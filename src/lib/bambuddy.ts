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
 * The Slicer Pipeline used as a settings template: printer, process, bed
 * type, the PLA filament preset, and which printer (or model class) to queue
 * for. Requests are not *run* through it — a pipeline run can't carry the
 * designer's settings, choose plates, or load the right number of filaments
 * (see "Slicing and queueing" in docs/architecture.md) — so the app slices
 * and queues directly, with these settings as the starting point.
 *
 * `BAMBUDDY_PIPELINE_ID`, or else the first of `BAMBUDDY_PIPELINES` (which
 * listed one pipeline per filament count before direct slicing; any of those
 * makes a fine template, since they differ only in that count).
 */
export function templatePipelineId(): number {
  const single = process.env.BAMBUDDY_PIPELINE_ID?.trim();
  const listed = process.env.BAMBUDDY_PIPELINES?.split(",")[0]?.trim();
  const id = Number(single || listed || bambuddyEnv("BAMBUDDY_PIPELINE_ID"));
  return Number.isInteger(id) && id > 0 ? id : 0;
}

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

/**
 * How long a Bambuddy call may take before it's abandoned. Without a limit, an
 * unreachable Bambuddy (a VLAN the container can't route to, say) holds a
 * request open until the OS gives up on the connection, and a page waiting on
 * it looks like a link that does nothing. Calls that do real work on
 * Bambuddy's side pass their own, longer limit.
 */
const DEFAULT_TIMEOUT_MS = 15_000;

async function bambuddyFetch<T>(
  path: string,
  init?: RequestInit,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  const res = await fetch(`${baseUrl()}${path}`, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs),
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
  // Bambuddy downloads the model from MakerWorld before answering.
  return bambuddyFetch<MakerWorldImportResponse>(
    "/api/v1/makerworld/import",
    { method: "POST", body: JSON.stringify(params) },
    120_000,
  );
}

/**
 * One filament slot of a library file, from `filament-requirements`.
 *
 * Confirmed against a live instance: without `full_slots`, only the slots
 * the plate actually uses come back — a model whose project defines six
 * slots but prints in one returns one. That is the right count for "how many
 * colours does this need". `slot_id` is the project's own numbering (1-based,
 * and a single-colour model's only slot was 3), and `type`/`color` are the
 * designer's, which this deployment treats as hints: every request is
 * sliced as PLA.
 */
export type FilamentRequirement = {
  slot_id: number;
  type: string | null;
  color: string | null;
  used_grams: number;
  used_in_plate?: boolean;
};

export async function getFilamentRequirements(libraryFileId: number): Promise<FilamentRequirement[]> {
  const { filaments } = await bambuddyFetch<{ filaments: FilamentRequirement[] }>(
    `/api/v1/library/files/${libraryFileId}/filament-requirements`,
  );
  return filaments.filter((f) => f.used_in_plate !== false);
}

/**
 * The slots the plate uses, and how many the project defines in all
 * (`full_slots`). The project's count sets how many filaments to slice with
 (see `filamentCountFor`), and the used ones are the colours to pick —
 * and they differ more often than you'd think: a single-colour model's
 * project can define six.
 */
export async function getFilamentSlots(
  libraryFileId: number,
): Promise<{ used: FilamentRequirement[]; all: FilamentRequirement[]; projectSlots: number }> {
  const [used, all] = await Promise.all([
    getFilamentRequirements(libraryFileId),
    bambuddyFetch<{ filaments: FilamentRequirement[] }>(
      `/api/v1/library/files/${libraryFileId}/filament-requirements?full_slots=true`,
    ),
  ]);
  return { used, all: all.filaments, projectSlots: all.filaments.length };
}

/**
 * Put an uploaded file into Bambuddy's library, thumbnail and all. This app
 * keeps no copy: the bytes go straight through. Generous timeout, since the
 * file can be up to 100 MB on a LAN.
 */
export async function uploadLibraryFile(
  filename: string,
  bytes: Uint8Array<ArrayBuffer>,
): Promise<{ id: number; filename: string; file_type: string; file_size: number }> {
  const form = new FormData();
  form.append("file", new Blob([bytes]), filename);
  const res = await fetch(`${baseUrl()}/api/v1/library/files?generate_stl_thumbnails=true`, {
    method: "POST",
    // No Content-Type: fetch sets the multipart boundary itself.
    headers: { "X-API-Key": apiKey() },
    body: form,
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => undefined);
    throw new BambuddyError(res.status, `Bambuddy POST /api/v1/library/files -> ${res.status}`, body);
  }
  return res.json();
}

/**
 * A library file's bytes, as a streaming response — for "Download original"
 * on a ticket waiting for prep. `undefined` when Bambuddy no longer has it.
 */
export async function downloadLibraryFile(libraryFileId: number): Promise<Response | undefined> {
  const res = await fetch(`${baseUrl()}/api/v1/library/files/${libraryFileId}/download`, {
    headers: { "X-API-Key": apiKey() },
    signal: AbortSignal.timeout(120_000),
  });
  if (res.status === 404) return undefined;
  if (!res.ok) throw new BambuddyError(res.status, `Bambuddy GET library file ${libraryFileId} -> ${res.status}`);
  return res;
}

/** One setting the designer changed from the stock process preset. */
export type DesignOverride = {
  key: string;
  value: unknown;
  /** Tuned for the designer's machine (speeds, accelerations, prime tower). */
  printer_coupled: boolean;
  /** Defines the picked process preset itself, so the pick should win. */
  preset_defining: boolean;
};

export type LibraryPlates = {
  is_multi_plate: boolean;
  plates: { index: number; name: string | null }[];
  design_overrides: DesignOverride[];
};

/** A library file's plates, and the process settings its designer changed. */
export async function getLibraryPlates(libraryFileId: number): Promise<LibraryPlates> {
  return bambuddyFetch<LibraryPlates>(`/api/v1/library/files/${libraryFileId}/plates`);
}

/** What `POST /library/files/{id}/slice` takes — the parts this app sets. */
export type SliceRequest = {
  printer_preset: PresetRef;
  process_preset: PresetRef;
  filament_presets: PresetRef[];
  filament_colours?: string[];
  bed_type?: string | null;
  /** `0` is every plate (one multi-plate 3MF); omitted is plate 1. */
  plate?: number;
  /** Keys from the file's own list of designer changes; omitted when it has none. */
  design_overrides?: string[];
  export_3mf: true;
};

/**
 * Start slicing a library file. Bambuddy answers 202 with a job id at once and
 * slices in the background; poll `getSliceJob`. The sliced 3MF lands in the
 * library as a new file, which `result.library_file_id` names.
 */
export async function sliceLibraryFile(libraryFileId: number, request: SliceRequest): Promise<{ job_id: number }> {
  return bambuddyFetch<{ job_id: number }>(`/api/v1/library/files/${libraryFileId}/slice`, {
    method: "POST",
    body: JSON.stringify(request),
  });
}

export type SliceJob = {
  job_id: number;
  status: "queued" | "running" | "completed" | "failed" | string;
  completed_at: string | null;
  result?: {
    library_file_id: number;
    print_time_seconds: number;
    filament_used_g: number;
  };
  error_status?: number;
  error_detail?: string;
};

/**
 * A slice job, or `undefined` once Bambuddy has forgotten it: jobs live in
 * its memory only, are swept 30 minutes after finishing, and are lost on a
 * restart. The caller re-slices in that case — nothing was queued from it.
 */
export async function getSliceJob(jobId: number): Promise<SliceJob | undefined> {
  try {
    return await bambuddyFetch<SliceJob>(`/api/v1/slice-jobs/${jobId}`);
  } catch (error) {
    if (error instanceof BambuddyError && error.status === 404) return undefined;
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Slicing — Slicer Pipelines (the template; and runs, for tickets from before
// direct slicing that are still in flight)
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

/**
 * Confirmed live: a job gets its `queue_entry_id` as soon as the run reaches
 * `dispatching` — well before `sliced_library_file_id` is set on the run
 * itself, and well before the run is `completed`. That queue entry is
 * created wanting to auto-start the moment a printer is free — Bambuddy has
 * no pipeline-level or instance-level setting to make it wait for a person
 * instead, so `secureQueueEntries` (bambuddy-sync.ts) has to PATCH
 * `manual_start: true` onto it directly, as early as it can.
 */
export type PipelineJob = {
  id: number;
  queue_entry_id: number | null;
  status: string;
  error_message: string | null;
};

export type PipelineRun = {
  id: number;
  pipeline_id: number;
  status: PipelineRunStatus;
  sliced_library_file_id: number | null;
  error_message: string | null;
  completed_at: string | null;
  jobs: PipelineJob[];
};

/** A preset as Bambuddy names it: `{source: "cloud", id: "GFSA00_11"}` and the like. */
export type PresetRef = { source: string; id: string };

/** The template's settings — see `templatePipelineId`. */
export type SlicerPipeline = {
  id: number;
  name: string;
  printer_preset: PresetRef;
  process_preset: PresetRef;
  filament_presets: PresetRef[];
  bed_type: string | null;
  target_kind: "printer" | "printer_class" | string;
  target_printer_id: number | null;
  target_model_class: string | null;
};

export async function getSlicerPipeline(pipelineId: number): Promise<SlicerPipeline> {
  return bambuddyFetch<SlicerPipeline>(`/api/v1/slicer-pipelines/${pipelineId}`);
}

/**
 * One run by id, however old. `undefined` only when Bambuddy no longer has
 * it (cleared from its run history).
 *
 * Not the per-pipeline `/runs` list: that is capped by `limit` (default 10),
 * so a story whose run slipped past the newest few would stop syncing.
 */
export async function getPipelineRun(runId: number): Promise<PipelineRun | undefined> {
  try {
    return await bambuddyFetch<PipelineRun>(`/api/v1/pipeline-runs/${runId}`);
  } catch (error) {
    if (error instanceof BambuddyError && error.status === 404) return undefined;
    throw error;
  }
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
  /**
   * Why a `pending` item hasn't auto-started even though it's eligible to —
   * confirmed live: "File was sliced for A1, which is not compatible with
   * [P2S]" for a MakerWorld 3MF that came with another printer's settings
   * embedded (see the pipeline module's own note on `used_embedded_settings`).
   * Worth showing the admin on a `Ready` ticket same as `error_message` is
   * shown on a `Failed` one — it's the reason this one needs a human, not a
   * failure.
   */
  waiting_reason: string | null;
};

/**
 * Queue a sliced file, **created waiting for a person** (`manual_start`).
 * That's set on creation, for every copy, so there is no window in which the
 * entry could auto-start — unlike a pipeline run's entries, which had to be
 * caught and switched afterwards (see `secureQueueEntries`).
 *
 * `quantity` above 1 makes that many entries in one batch (and one Bambuddy
 * notification); the response is the first entry, carrying the `batch_id`.
 * Passing `batch_id` adds to an existing batch — how every plate of a
 * multi-plate model ends up in the same one.
 */
export async function addToQueue(params: {
  library_file_id: number;
  plate_id?: number;
  quantity: number;
  batch_id?: number;
  printer_id?: number;
  target_model?: string;
}): Promise<QueueItem & { batch_id: number | null }> {
  return bambuddyFetch<QueueItem & { batch_id: number | null }>("/api/v1/queue/", {
    method: "POST",
    body: JSON.stringify({ ...params, manual_start: true }),
  });
}

/** How a batch's entries stand: the basis of a multi-entry ticket's status. */
export type QueueBatch = {
  id: number;
  status: string;
  pending_count: number;
  printing_count: number;
  completed_count: number;
  failed_count: number;
  cancelled_count: number;
  skipped_count: number;
};

export async function getQueueBatch(batchId: number): Promise<QueueBatch | undefined> {
  try {
    return await bambuddyFetch<QueueBatch>(`/api/v1/queue/batches/${batchId}`);
  } catch (error) {
    if (error instanceof BambuddyError && error.status === 404) return undefined;
    throw error;
  }
}

export async function getQueueItem(itemId: number): Promise<QueueItem> {
  return bambuddyFetch<QueueItem>(`/api/v1/queue/${itemId}`);
}

/**
 * Force manual-start on a queue entry.
 *
 * Confirmed live: refuses with a 400 ("Can only update pending items") once
 * an item has left `pending` — which is fine, since by then it's either
 * already been started by a person (the whole point) or is otherwise past
 * the point this matters. Callers should treat that refusal as a no-op, not
 * an error worth surfacing.
 */
export async function setManualStart(queueItemId: number): Promise<QueueItem> {
  return bambuddyFetch<QueueItem>(`/api/v1/queue/${queueItemId}`, {
    method: "PATCH",
    body: JSON.stringify({ manual_start: true }),
  });
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

/**
 * Only PLA can be requested — the one Slicer Pipeline (see `pipelineId`) is a
 * fixed standard-PLA recipe, so any other material would slice cleanly and
 * print wrong. The intake form filters its picker with this, and
 * `createStoryFromLink` enforces it server-side.
 */
export function isPla(material: string): boolean {
  return material.toUpperCase().includes("PLA");
}

export async function listSpools(): Promise<Spool[]> {
  // Short: a person is waiting on the order page for this.
  const spools = await bambuddyFetch<Spool[]>("/api/v1/inventory/spools", undefined, 5_000);
  return spools.filter((spool) => !spool.archived_at);
}
