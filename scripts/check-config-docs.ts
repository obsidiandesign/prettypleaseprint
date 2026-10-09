/**
 * Is the configuration documented where a person setting it up will look?
 *
 *   npm run check:config-docs
 *
 * Two things rot silently here, and neither breaks a typecheck or a suite:
 *
 *   1. Environment variables. A variable added to the code but not to the README
 *      table and the example env files is invisible to everyone deploying from
 *      them: it works on the developer's machine and nowhere else. (PETG's
 *      BAMBUDDY_PIPELINE_PETG shipped in the README and `.env.example` but in
 *      neither deployment example — the first run of this check found it.)
 *   2. Claims the code stopped making true. "Only PLA can be requested" was the
 *      app's whole material policy until it wasn't; prose that keeps saying so
 *      is worse than no prose.
 *
 * The rules, for variables the app reads (src/, prisma/):
 *   A. Documented in the README table, or set by a compose file (the compose
 *      layer owns it: DATABASE_URL, BETTER_AUTH_URL), or listed in INTERNAL
 *      below with a reason.
 *   B. In `.env.example`, commented or not.
 *   C. In both deployment examples (`.env.docker.example` and
 *      `deploy/unraid/env.example`), unless compose sets it.
 * and the other way round:
 *   D. Every variable in the README table is used somewhere (code, scripts,
 *      compose, Dockerfile, deploy/), and every variable in any example file is
 *      in the README table or set by compose — so a removed variable does not
 *      linger in the docs.
 *
 * Variables the plan registry names (src/lib/materials.ts: each material's
 * pipeline variable) are read dynamically, so they are included explicitly.
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { MATERIALS } from "../src/lib/materials";

const ROOT = process.cwd();
const read = (p: string) => (existsSync(join(ROOT, p)) ? readFileSync(join(ROOT, p), "utf8") : "");

/** Read by the code, but not something a person configures. Each needs a reason. */
const INTERNAL: Record<string, { reason: string; documentedIn?: string }> = {
  NODE_ENV: { reason: "set by the runtime and the Dockerfile, not by the person deploying" },
  NEXT_PHASE: { reason: "set by Next.js itself during `next build`" },
  NEXT_PUBLIC_APP_URL: {
    reason: "inlined into browser code at build time; the published image leaves it unset and the browser uses the page's own origin",
  },
  BAMBUDDY_PIPELINES: {
    reason: "legacy fallback for BAMBUDDY_PIPELINE_ID, from before direct slicing",
    documentedIn: "docs/deployment.md",
  },
};

/** Prose that has stopped being true. Add a line when a policy changes. `stale-ok` on a line waives it. */
const STALE: { pattern: RegExp; why: string }[] = [
  { pattern: /\bPLA[- ]only\b/i, why: "PLA is no longer the only material (src/lib/materials.ts)" },
  { pattern: /\bonly PLA\b/i, why: "PLA is no longer the only material" },
  { pattern: /every (?:request|ticket|print)\b[^.\n]{0,40}\b(?:sliced|prints?)\b[^.\n]{0,15}\bPLA\b/i, why: "a ticket is sliced for its own material" },
  { pattern: /\bmust be (?:a )?PLA\b/i, why: "a spool must be a material the owner has switched on" },
  { pattern: /\bnon-PLA\b|\bisn'?t PLA\b|\bis not PLA\b/i, why: "refusals are about materials that are not switched on" },
];

// ---------------------------------------------------------------------------

const SKIP = new Set(["node_modules", ".git", ".next", "Pretty Please Print", "shots", "data", "public"]);

function files(dir: string, keep: (p: string) => boolean, out: string[] = []): string[] {
  for (const entry of readdirSync(join(ROOT, dir))) {
    if (SKIP.has(entry)) continue;
    const rel = join(dir, entry);
    if (statSync(join(ROOT, rel)).isDirectory()) files(rel, keep, out);
    else if (keep(rel)) out.push(rel);
  }
  return out;
}

const isCode = (p: string) => /\.(ts|tsx|mjs|js)$/.test(p);
const NAME = "[A-Z][A-Z0-9_]{2,}";

/** Variables a file reads via process.env, bambuddyEnv(), or Prisma's env(). */
function envReads(text: string): Set<string> {
  const found = new Set<string>();
  const patterns = [
    new RegExp(`process\\.env\\.(${NAME})`, "g"),
    new RegExp(`process\\.env\\[["'](${NAME})["']\\]`, "g"),
    new RegExp(`bambuddyEnv\\(["'](${NAME})["']\\)`, "g"),
    new RegExp(`\\benv\\(["'](${NAME})["']\\)`, "g"),
  ];
  for (const re of patterns) for (const m of text.matchAll(re)) found.add(m[1]!);
  return found;
}

const failures: string[] = [];
const fail = (msg: string) => failures.push(msg);

// What the app reads.
const appFiles = [...files("src", isCode), "prisma/seed.ts", "prisma/schema.prisma"].filter((p) => existsSync(join(ROOT, p)));
const appVars = new Map<string, string>(); // name -> a file that reads it
for (const f of appFiles) for (const v of envReads(read(f))) if (!appVars.has(v)) appVars.set(v, f);
for (const m of MATERIALS) if (!appVars.has(m.pipelineEnv)) appVars.set(m.pipelineEnv, "src/lib/materials.ts");

// What the docs say.
const readmeVars = new Set<string>();
for (const line of read("README.md").split("\n")) {
  const cell = /^\|\s*([^|]+?)\s*\|/.exec(line)?.[1];
  if (!cell || !cell.includes("`")) continue;
  for (const m of cell.matchAll(new RegExp(`\`(${NAME})\``, "g"))) readmeVars.add(m[1]!);
}
const exampleNames = (text: string) =>
  new Set([...text.matchAll(new RegExp(`^#?\\s*(${NAME})=`, "gm"))].map((m) => m[1]!));
const devExample = exampleNames(read(".env.example"));
const dockerExample = exampleNames(read(".env.docker.example"));
const unraidExample = exampleNames(read("deploy/unraid/env.example"));

// What compose sets itself (an `environment:` entry, not an `env_file`).
const composeFiles = [...files(".", (p) => /(^|\/)docker-compose[^/]*\.ya?ml$/.test(p))];
const composeSets = new Set<string>();
for (const f of composeFiles) {
  for (const m of read(f).matchAll(new RegExp(`^\\s+(${NAME}):\\s`, "gm"))) composeSets.add(m[1]!);
}

// Everywhere a variable can legitimately be used, for rule D.
const infra = [
  ...composeFiles, "Dockerfile",
  ...files("deploy", () => true),
  ...files("scripts", () => true),
].filter((p) => existsSync(join(ROOT, p)));
const usedText = [...appFiles, ...infra].map(read).join("\n");

// ---------------------------------------------------------------------------
// A, B, C
for (const [name, where] of [...appVars].sort()) {
  const internal = INTERNAL[name];
  if (internal) {
    if (internal.documentedIn && !read(internal.documentedIn).includes(name)) {
      fail(`${name} is declared documented in ${internal.documentedIn}, which does not mention it.`);
    }
    continue;
  }
  const derived = composeSets.has(name);
  if (!readmeVars.has(name) && !derived) {
    fail(`${name} (read in ${where}) is not in the README variable table. Add a row, or list it in INTERNAL with a reason.`);
  }
  if (!devExample.has(name)) fail(`${name} (read in ${where}) is not in .env.example. Add it, commented out if optional.`);
  if (!derived) {
    if (!dockerExample.has(name)) fail(`${name} (read in ${where}) is not in .env.docker.example.`);
    if (!unraidExample.has(name)) fail(`${name} (read in ${where}) is not in deploy/unraid/env.example.`);
  }
}

// D
for (const name of [...readmeVars].sort()) {
  if (!new RegExp(`\\b${name}\\b`).test(usedText)) {
    fail(`${name} is in the README variable table but nothing uses it. Remove the row, or the table is stale.`);
  }
}
for (const [label, set] of [[".env.example", devExample], [".env.docker.example", dockerExample], ["deploy/unraid/env.example", unraidExample]] as const) {
  for (const name of [...set].sort()) {
    if (!readmeVars.has(name) && !composeSets.has(name) && !INTERNAL[name] && !new RegExp(`\\b${name}\\b`).test(usedText)) {
      fail(`${name} is in ${label} but is neither documented in the README table nor used by anything.`);
    }
    if (!readmeVars.has(name) && !composeSets.has(name) && !INTERNAL[name] && new RegExp(`\\b${name}\\b`).test(usedText)) {
      fail(`${name} is in ${label} but not in the README variable table.`);
    }
  }
}

// Stale claims.
const prose = [
  "README.md",
  ...files("docs", (p) => p.endsWith(".md")),
  ...files("src", isCode),
  ...files("scripts", isCode).filter((p) => p !== "scripts/check-config-docs.ts"),
];
for (const f of prose) {
  read(f).split("\n").forEach((line, i) => {
    if (line.includes("stale-ok")) return;
    for (const { pattern, why } of STALE) {
      if (pattern.test(line)) fail(`${f}:${i + 1}: ${why}:\n        ${line.trim().slice(0, 140)}`);
    }
  });
}

// ---------------------------------------------------------------------------
if (failures.length === 0) {
  console.info(`ok  ${appVars.size} variables the app reads are documented, and ${prose.length} files carry no stale claims`);
  process.exit(0);
}
console.error(`FAIL  ${failures.length} configuration documentation problem${failures.length === 1 ? "" : "s"}:\n`);
for (const f of failures) console.error(`  - ${f}`);
console.error(`\n(checked from ${relative(process.cwd(), ROOT) || "."}; see the header of scripts/check-config-docs.ts for the rules)`);
process.exit(1);
