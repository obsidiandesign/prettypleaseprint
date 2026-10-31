import "server-only";

import { db } from "@/lib/db";
import pkg from "../../package.json";

/**
 * What this deployment is running, and whether there's a newer build.
 *
 * The release workflow passes the commit, build time and repository into the
 * image (Dockerfile, runner stage). A local or CI build leaves them empty and
 * the System page says so. They describe the infrastructure, so only the
 * admin-only page shows them, never `/api/health`.
 */
export type Build = {
  /** Full commit SHA, or null for a build the release workflow didn't make. */
  sha: string | null;
  /** The first 7 characters: the image tag a deployment pins `PPP_TAG` to. */
  tag: string | null;
  builtAt: Date | null;
  /** "owner/name" on GitHub. Its `main` is what the update check compares against. */
  repo: string | null;
};

export function currentBuild(): Build {
  const sha = /^[0-9a-f]{40}$/.test(process.env.PPP_BUILD_SHA ?? "")
    ? process.env.PPP_BUILD_SHA!
    : null;
  const repo = /^[\w.-]+\/[\w.-]+$/.test(process.env.PPP_BUILD_REPO ?? "")
    ? process.env.PPP_BUILD_REPO!
    : null;
  const date = new Date(process.env.PPP_BUILD_DATE ?? "");
  return {
    sha,
    tag: sha?.slice(0, 7) ?? null,
    builtAt: Number.isNaN(date.getTime()) ? null : date,
    repo,
  };
}

/** Runtime dependencies, as pinned in package.json at build time. */
export function packageVersions(): Array<{ name: string; version: string }> {
  return Object.entries(pkg.dependencies as Record<string, string>)
    .map(([name, version]) => ({ name, version }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function postgresVersion(): Promise<string | null> {
  try {
    const [row] = await db.$queryRaw<Array<{ server_version: string }>>`SHOW server_version`;
    return row?.server_version ?? null;
  } catch {
    return null;
  }
}

export type UpdateCheck =
  | { state: "unstamped" }
  | { state: "current"; checkedAt: Date }
  | { state: "behind"; behindBy: number; latest: string; checkedAt: Date }
  | { state: "unknown"; reason: string; checkedAt: Date };

/**
 * GitHub allows 60 anonymous requests an hour per address, and a deployment
 * only moves when someone merges, so one check an hour is plenty. A failed
 * check is retried sooner, so a GitHub outage doesn't hide an update for an hour.
 */
const FRESH_FOR = 60 * 60_000;
const RETRY_AFTER = 5 * 60_000;
let cached: { until: number; result: UpdateCheck } | null = null;

export async function checkForUpdate(build: Build = currentBuild()): Promise<UpdateCheck> {
  if (!build.sha || !build.repo) return { state: "unstamped" };
  if (cached && cached.until > Date.now()) return cached.result;

  const result = await compareWithMain(build.sha, build.repo);
  cached = {
    until: Date.now() + (result.state === "unknown" ? RETRY_AFTER : FRESH_FOR),
    result,
  };
  return result;
}

/**
 * Compares against the newest commit on `main` that the release workflow
 * published images for, not `main`'s head. The daily traffic snapshot commits
 * to `main` without publishing anything (release-images.yml ignores its path),
 * so the head can be a commit with no image tag to pin to.
 */
async function compareWithMain(sha: string, repo: string): Promise<UpdateCheck> {
  const checkedAt = new Date();
  const api = `https://api.github.com/repos/${repo}`;
  const get = async (path: string) => {
    const res = await fetch(`${api}${path}`, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "pretty-please-print",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) throw new GitHubError(res.status);
    return res.json();
  };
  try {
    const runs = (await get(
      "/actions/workflows/release-images.yml/runs?branch=main&event=push&status=success&per_page=1",
    )) as { workflow_runs?: Array<{ head_sha?: string }> };
    const released = runs.workflow_runs?.[0]?.head_sha;
    if (!released) return { state: "unknown", reason: "no published release found", checkedAt };
    if (released === sha) return { state: "current", checkedAt };

    const { status, ahead_by } = (await get(`/compare/${sha}...${released}?per_page=1`)) as {
      status?: string;
      ahead_by?: number;
    };
    // "ahead" and "diverged" both mean the release has commits this build lacks.
    if ((status === "ahead" || status === "diverged") && (ahead_by ?? 0) > 0) {
      return { state: "behind", behindBy: ahead_by!, latest: released.slice(0, 7), checkedAt };
    }
    return { state: "current", checkedAt };
  } catch (err) {
    const reason =
      err instanceof GitHubError
        ? `GitHub answered ${err.status}`
        : err instanceof Error && err.name === "TimeoutError"
          ? "GitHub didn't answer in time"
          : "couldn't reach GitHub";
    return { state: "unknown", reason, checkedAt };
  }
}

class GitHubError extends Error {
  constructor(readonly status: number) {
    super(`GitHub answered ${status}`);
  }
}
