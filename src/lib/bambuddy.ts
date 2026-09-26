import "server-only";

import { isBuildPhase } from "@/lib/runtime";

/**
 * Server-only client for a Bambuddy instance's REST API.
 *
 * Bambuddy stays on the LAN by design (see the project brief) — every call
 * here is made from inside this container, never from a browser, using an
 * API key scoped to Manage Library + Manage Queue only. No Control Printer:
 * a compromise of this app can queue and slice, but cannot start, stop, or
 * otherwise touch a running print.
 *
 * A request moves through Bambuddy in three handoffs, not one:
 *   import (-> library_file_id) -> pipeline run (-> sliced_library_file_id)
 *   -> queue item (-> archive_id, once it has actually printed)
 * Each function below returns just enough of Bambuddy's response to drive
 * that handoff and the requester-facing status; it is not a full mirror of
 * the OpenAPI schema.
 */

function bambuddyEnv(name: "BAMBUDDY_URL" | "BAMBUDDY_API_KEY" | "BAMBUDDY_PIPELINE_ID"): string {
  const value = process.env[name];
  if (value) return value;
  if (process.env.NODE_ENV === "production" && !isBuildPhase) {
    throw new Error(`${name} is required in production.`);
  }
  return "";
}

const baseUrl = () => bambuddyEnv("BAMBUDDY_URL").replace(/\/+$/, "");
const apiKey = () => bambuddyEnv("BAMBUDDY_API_KEY");

/**
 * The one Slicer Pipeline this deployment uses — a saved "P2S, standard PLA"
 * recipe in Bambuddy. Color is picked at intake for display and spool
 * assignment only; it never selects a different pipeline, since slicing
 * only cares about material, and the only material this farm runs is PLA.
 */
const pipelineId = () => bambuddyEnv("BAMBUDDY_PIPELINE_ID");

/** A Bambuddy call that did not return 2xx. `body` is the parsed JSON error, if any. */
export class BambuddyError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "BambuddyError";
  }
}

/**
 * Bambu Cloud isn't usable from the Bambuddy side — never linked, or linked
 * and since expired. Nothing that downloads from MakerWorld will work until
 * an admin signs in to Bambu Cloud inside Bambuddy's own UI.
 *
 * Confirmed against a live instance: `POST /makerworld/import` answers
 * `401 {"detail":"Downloading files from MakerWorld requires a Bambu Cloud
 * login"}` in exactly this case — and it does so even for a model already
 * present in the library (`already_imported_library_ids` on the resolve
 * response), so there's no cache path that avoids it. Note this is *not*
 * reliably reflected by `getMakerWorldStatus().sign_in_expired`, which is
 * `false` when Bambu Cloud was simply never linked (as opposed to linked and
 * expired) — so the useful check is catching this 401 from `import` itself,
 * which is what `resolveMakerWorldUrl`/`importMakerWorldModel`'s callers
 * should do, rather than pre-checking a flag that doesn't cover both cases.
 */
export class BambuddyCloudExpiredError extends BambuddyError {
  constructor() {
    super(401, "Bambu Cloud isn't connected in Bambuddy — an admin needs to sign it in there.");
    this.name = "BambuddyCloudExpiredError";
  }
}

async function bambuddyFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${baseUrl()}${path}`, {
    ...init,
    headers: {
      "X-API-Key": apiKey(),
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => undefined);
    throw new BambuddyError(res.status, `Bambuddy ${init?.method ?? "GET"} ${path} -> ${res.status}`, body);
  }
  return res.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// MakerWorld
// ---------------------------------------------------------------------------

export type MakerWorldStatus = {
  has_cloud_token: boolean;
  can_download: boolean;
  sign_in_expired?: boolean;
};

export async function getMakerWorldStatus(): Promise<MakerWorldStatus> {
  return bambuddyFetch<MakerWorldStatus>("/api/v1/makerworld/status");
}

/**
 * `design` and `instances` are passed through opaque by Bambuddy itself,
 * verbatim from MakerWorld's own API. Kept opaque here for the same reason:
 * MakerWorld can add fields (badges, license variants) a strict type would
 * silently drop.
 *
 * Confirmed against a live resolve: `design.titleTranslated` (falling back
 * to `design.title`, which is often the model's original, non-English
 * name) is a display title — see `resolvedTitleFrom` in bambuddy-sync.ts.
 * `instances` are community-submitted print-profile variants (different
 * layer heights/infill, not plates), each with its own numeric `profileId`,
 * not a plate count — resist the temptation to read `instances.length` as
 * one. Bambuddy works `resolve` without any Bambu Cloud link at all; only
 * `import` needs it (see `BambuddyCloudExpiredError`).
 */
export type MakerWorldResolvedModel = {
  model_id: number;
  profile_id: number | null;
  design: Record<string, unknown>;
  instances: Record<string, unknown>[];
  already_imported_library_ids: number[];
};

export async function resolveMakerWorldUrl(url: string): Promise<MakerWorldResolvedModel> {
  return bambuddyFetch<MakerWorldResolvedModel>("/api/v1/makerworld/resolve", {
    method: "POST",
    body: JSON.stringify({ url }),
  });
}

export type MakerWorldImportResponse = {
  library_file_id: number;
  filename: string;
  was_existing: boolean;
};

export async function importMakerWorldModel(params: {
  model_id: number;
  /** Defaults to "makerworld" server-side if omitted. */
  source_type?: string;
  profile_id?: number | null;
}): Promise<MakerWorldImportResponse> {
  return bambuddyFetch<MakerWorldImportResponse>("/api/v1/makerworld/import", {
    method: "POST",
    body: JSON.stringify(params),
  });
}

// ---------------------------------------------------------------------------
// Slicing — Slicer Pipelines
// ---------------------------------------------------------------------------

export type PipelineRunStatus =
  | "queued"
  | "slicing"
  | "dispatching"
  | "in_progress"
  | "completed"
  | "failed"
  | "partial_failure"
  | "cancelled";

export type PipelineRun = {
  id: number;
  pipeline_id: number;
  status: PipelineRunStatus;
  sliced_library_file_id: number | null;
  error_message: string | null;
};

export async function runSlicerPipeline(sourceLibraryFileId: number): Promise<PipelineRun> {
  return bambuddyFetch<PipelineRun>(`/api/v1/slicer-pipelines/${pipelineId()}/run`, {
    method: "POST",
    body: JSON.stringify({ source_library_file_id: sourceLibraryFileId, copies: 1 }),
  });
}

/**
 * There is no GET for a single run, only a list per pipeline — filtering
 * client-side is fine at the volume one pipeline for one family sees. Worth
 * revisiting only if that list ever grows large enough for it to matter.
 */
export async function getPipelineRun(runId: number): Promise<PipelineRun | undefined> {
  const { runs } = await bambuddyFetch<{ runs: PipelineRun[] }>(
    `/api/v1/slicer-pipelines/${pipelineId()}/runs?limit=50`,
  );
  return runs.find((run) => run.id === runId);
}

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------

export type QueueItemStatus = "pending" | "printing" | "completed" | "failed" | "skipped" | "cancelled";

export type QueueItem = {
  id: number;
  status: QueueItemStatus;
  archive_id: number | null;
  library_file_id: number | null;
  started_at: string | null;
  completed_at: string | null;
  error_message: string | null;
};

/**
 * Always manual-start: this is the "ready to print" pile the printer owner
 * reviews and kicks off by hand, never auto-dispatched.
 */
export async function addToQueue(slicedLibraryFileId: number): Promise<QueueItem> {
  return bambuddyFetch<QueueItem>("/api/v1/queue/", {
    method: "POST",
    body: JSON.stringify({ library_file_id: slicedLibraryFileId, manual_start: true }),
  });
}

export async function getQueueItem(itemId: number): Promise<QueueItem> {
  return bambuddyFetch<QueueItem>(`/api/v1/queue/${itemId}`);
}

// ---------------------------------------------------------------------------
// Filament inventory — for the intake form's color picker
// ---------------------------------------------------------------------------

export type Spool = {
  id: number;
  material: string;
  color_name: string | null;
  rgba: string | null;
  archived_at: string | null;
};

export async function listSpools(): Promise<Spool[]> {
  const spools = await bambuddyFetch<Spool[]>("/api/v1/inventory/spools");
  return spools.filter((spool) => !spool.archived_at);
}
