import "server-only";
import type { Prisma, StoryStatus } from "@prisma/client";

import { db } from "@/lib/db";
import { materialByKey, materialOf } from "@/lib/materials";
import { record } from "@/lib/audit";
import { notify, printerOwner } from "@/lib/authz";
import {
  AMS_SLOTS,
  deriveStatus,
  filamentCountFor,
  isTerminal,
  queueOutcome,
  statusLabel,
  storyRef,
  type QueueCounts,
} from "@/lib/scope";
import {
  BambuddyCloudExpiredError,
  BambuddyError,
  addToQueue,
  getFilamentSlots,
  getLibraryPlates,
  getPipelineRun,
  getQueueBatch,
  getSliceJob,
  getSlicerPipeline,
  getQueueItem,
  importMakerWorldModel,
  sliceLibraryFile,
  materialPipelineId,
  resolveMakerWorldUrl,
  setManualStart,
  type FilamentRequirement,
  type MakerWorldResolvedModel,
  type SliceJob,
  type SliceRequest,
  type SlicerPipeline,
  type PipelineRun,
} from "@/lib/bambuddy";

/**
 * The system-triggered half of a story's life.
 *
 * `advanceStory` used to live in stories.ts and move a ticket forward on an
 * admin's click. It doesn't any more — see the comment left in its place.
 * Everything here runs from a schedule (`src/app/api/cron/sync/route.ts`),
 * not a person, which is why nothing takes an `Actor`: the "every function
 * takes an Actor" rule in stories.ts is about authorising a person's action,
 * and there is no person here to authorise.
 */

/**
 * A specific, human-readable reason `processIntake` gives up, distinct from
 * a raw `BambuddyError` — the message is meant to reach the admin verbatim,
 * the way `BambuddyCloudExpiredError`'s does.
 */
/**
 * An intake failure worth naming, rather than the generic retry message.
 * `message` is shown on the ticket, to the requester; `adminDetail`, when
 * given, is what the printer owner is told instead — the part they can act on.
 */
class IntakeProblem extends Error {
  constructor(message: string, readonly adminDetail?: string) {
    super(message);
  }
}

async function notifyAdmin(text: string, storyId?: number): Promise<void> {
  const owner = await printerOwner();
  if (!owner) return;
  await notify({ recipientId: owner.id, storyId, text });
}

/**
 * A display title from a resolved model, best-effort. `titleTranslated` is
 * MakerWorld's English (or viewer-locale) translation; `title` is often the
 * original, sometimes non-English, name. Both confirmed present on a live
 * resolve — see the type's own comment in bambuddy.ts.
 */
function resolvedTitleFrom(resolved: MakerWorldResolvedModel): string | null {
  const title = resolved.design.titleTranslated ?? resolved.design.title;
  return typeof title === "string" && title.trim() ? title.trim() : null;
}

/**
 * Force manual-start on every queue entry a run has produced so far.
 *
 * This is the one safety-critical operation in this whole module. Confirmed
 * live: a Slicer Pipeline run creates its queue entry as soon as it reaches
 * `dispatching` — often well before the run is `completed` — wanting to
 * auto-start the instant a printer is free, and Bambuddy has no setting
 * that makes it wait for a person instead. There is no way to prevent that
 * entry from being created wanting to auto-start; the only lever is to
 * PATCH it to `manual_start: true` as fast as possible after it exists.
 * Idempotent and safe to call every poll: a queue item past `pending`
 * refuses the PATCH with a 400, which just means it's a no-op here, not an
 * error.
 *
 * Returns every queue entry id found on this run, whether or not this call
 * is what secured it (an earlier call may already have).
 */
async function secureQueueEntries(run: PipelineRun): Promise<number[]> {
  const ids = run.jobs.map((job) => job.queue_entry_id).filter((id): id is number => id != null);
  await Promise.all(
    ids.map(async (id) => {
      try {
        await setManualStart(id);
      } catch (error) {
        if (error instanceof BambuddyError && error.status === 400) return; // already past pending
        console.error(`[sync] failed to secure queue entry ${id}`, error);
      }
    }),
  );
  return ids;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * How long a `processIntake` claim holds before another caller may take the
 * story over. Far longer than a healthy run (~40s of polling plus a few
 * Bambuddy calls), so it only ever expires on a process that died mid-run.
 */
const INTAKE_LEASE_MS = 10 * 60 * 1000;

/**
 * Where-clause for "no `processIntake` is running on this story right now".
 * Decline and withdraw use it too (stories.ts): they wait for the claim
 * rather than race intake, which would otherwise start a pipeline run for a
 * story that no longer wants one. (Bambuddy can cancel a run, but refusing
 * for the few seconds intake holds the claim is simpler and loses nothing.)
 */
export function intakeNotRunning(now = new Date()): Prisma.StoryWhereInput {
  return {
    OR: [
      { intakeStartedAt: null },
      { intakeStartedAt: { lt: new Date(now.getTime() - INTAKE_LEASE_MS) } },
    ],
  };
}

/**
 * How long a `completed` run may go without any job carrying a queue entry
 * before that's treated as final. Entries normally appear at `dispatching`,
 * before the run completes, so this only has to cover a slow write on
 * Bambuddy's side.
 */
const UNQUEUED_GRACE_MS = 2 * 60 * 1000;

/**
 * Why a run finished without ever reaching the print queue, or `null` if it
 * hasn't (yet). Without this, `deriveStatus` reads such a run as `Slicing`
 * forever and nobody is told.
 */
function unqueuedReason(run: PipelineRun): string | null {
  if (run.jobs.some((job) => job.queue_entry_id != null)) return null;

  // Confirmed live: a slice that failed left its run `in_progress`, with the
  // failure in `error_message` and `completed_at` set, every job still
  // `pending` — and Bambuddy's own cancel answered 200 without moving it. A
  // run that has finished with an error is final, whatever `status` says.
  if (run.error_message && run.completed_at) return run.error_message;

  if (run.status !== "completed") return null;
  // A missing or unparseable completed_at counts as past the grace: waiting
  // on a time that never comes would leave the story in Slicing for good.
  const completedAt = run.completed_at ? Date.parse(run.completed_at) : NaN;
  if (Number.isFinite(completedAt) && Date.now() - completedAt <= UNQUEUED_GRACE_MS) return null;

  const jobError = run.jobs.find((job) => job.error_message)?.error_message;
  return (
    jobError ??
    "Bambuddy sliced this but never added it to the print queue — check the Slicer Pipeline's dispatch settings."
  );
}

/** `#RRGGBB` (or `#RRGGBBAA`), or null for anything else Bambuddy sends. */
function hexOrNull(value: string | null): string | null {
  if (!value) return null;
  const hex = value.replace(/^#/, "");
  return /^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(hex) ? `#${hex}` : null;
}

/**
 * Record the colours the model uses (read by intake, before choosing a
 * pipeline) as the ticket's slots.
 *
 * The form's colour goes on the slot using the most filament, since that is
 * the body of the print in practice; slot numbering is the designer's and
 * arbitrary. When usage isn't known (an unsliced file, which is most), that
 * falls back to the lowest slot. The other slots start as "printer's choice" until the requester
 * picks them on the ticket. A single-colour model ends up with one slot
 * holding the form's colour, which is exactly what the ticket showed before.
 *
 * Best-effort: the handoff is already saved, and a ticket without slots just
 * shows the form's colour. A re-queued ticket arrives with its old slots
 * copied over (see `requeueStory`), and those are kept as they are.
 */
async function recordFilaments(
  story: {
    id: number; title: string; uploaderId: string;
    spoolId: number | null; material: string | null; colorName: string; colorHex: string | null;
  },
  slots: FilamentRequirement[],
): Promise<void> {
  try {
    if (slots.length === 0) return;
    if ((await db.storyFilament.count({ where: { storyId: story.id } })) > 0) return;

    // Most filament first, lowest slot on a tie. Confirmed live: an unsliced
    // project 3MF reports 0 g for every slot (only a pre-sliced .gcode.3mf
    // knows its usage), so for most MakerWorld models this is simply slot 1.
    // stories.ts orders slots the same way, so "main" means the same there.
    const main = [...slots].sort((a, b) => b.used_grams - a.used_grams || a.slot_id - b.slot_id)[0]!;

    await db.storyFilament.createMany({
      data: slots.map((slot) => ({
        storyId: story.id,
        slotId: slot.slot_id,
        designColor: hexOrNull(slot.color),
        usedGrams: slot.used_grams,
        ...(slot === main && {
          spoolId: story.spoolId,
          material: story.material,
          colorName: story.colorName,
          colorHex: story.colorHex,
        }),
      })),
      skipDuplicates: true,
    });

    if (slots.length > 1) {
      await notify({
        recipientId: story.uploaderId,
        storyId: story.id,
        text: `“${story.title}” uses ${slots.length} colours — pick the rest on the ticket.`,
      });
    }
    if (slots.length > AMS_SLOTS) {
      await notifyAdmin(
        `${storyRef(story.id)} — “${story.title}” — needs ${slots.length} colours; the AMS holds ${AMS_SLOTS}.`,
        story.id,
      );
    }
  } catch (error) {
    console.error(`[intake] ${storyRef(story.id)}: couldn't read the model's colours`, error);
  }
}

const NOT_SET_UP = "The printer isn't set up to slice yet — the printer owner has been told.";

/**
 * The settings for a ticket's material — see `materialPipelineId`. A ticket
 * is sliced for its main spool's material; one with none recorded (a legacy
 * row) is PLA, which is all there was.
 */
function materialKeyFor(spoolMaterial: string | null): string {
  return materialOf(spoolMaterial)?.key ?? "PLA";
}

async function loadTemplate(materialKey: string): Promise<SlicerPipeline> {
  const id = materialPipelineId(materialKey);
  const env = materialByKey(materialKey)?.pipelineEnv ?? "BAMBUDDY_PIPELINE_ID";
  if (!id) {
    throw new IntakeProblem(NOT_SET_UP, `No Slicer Pipeline is set for ${materialKey}: set ${env}.`);
  }
  try {
    const template = await getSlicerPipeline(id);
    if (!template.filament_presets?.[0]) {
      throw new IntakeProblem(NOT_SET_UP, `Slicer Pipeline ${id} (the ${materialKey} template) has no filament preset.`);
    }
    return template;
  } catch (error) {
    if (error instanceof BambuddyError && error.status === 404) {
      throw new IntakeProblem(NOT_SET_UP, `Slicer Pipeline ${id}, the ${materialKey} settings template, doesn't exist in Bambuddy.`);
    }
    throw error;
  }
}

/** `#RRGGBB(AA)` for the slicer, from a spool's `RRGGBBAA` or a designer's `#RRGGBB`. */
function hashHex(value: string | null | undefined): string {
  return hexOrNull(value ?? null) ?? "";
}

/**
 * Everything one slice of a library file needs, from the template and the
 * file itself. The same plan is rebuilt for a re-slice, so it reads the
 * ticket's colour picks rather than anything held in memory.
 *
 * - **Filaments:** one preset per slot the project defines, in the ticket's material
 *   (`filamentCountFor`) — a pipeline's fixed count crashed the slicer.
 * - **Designer's settings:** what Bambuddy's own "use the designer's
 *   settings" applies — every process setting the file says its designer
 *   changed, except the printer-coupled ones (tuned for their machine) and
 *   the preset-defining ones (the template's pick wins). Omitted, not empty,
 *   when the file lists none: an empty list tells Bambuddy "offered, all
 *   declined", which also holds back its support carry-over.
 * - **Plates:** all of them, as one multi-plate 3MF (`plate: 0`); each is
 *   queued separately afterwards. A file with just one plate slices that one.
 * - **Colours:** the ticket's pick per slot, else the designer's, so the
 *   sliced file records what will actually print where it knows.
 */
async function planSlice(
  storyId: number,
  libraryFileId: number,
): Promise<{ request: SliceRequest; printPlates: number[]; template: SlicerPipeline }> {
  const story = await db.story.findUnique({ where: { id: storyId }, select: { material: true } });
  const template = await loadTemplate(materialKeyFor(story?.material ?? null));

  const [slots, plates, picks] = await Promise.all([
    getFilamentSlots(libraryFileId).catch((error) => {
      console.error(`[slice] ${storyRef(storyId)}: couldn't read the model's filament slots`, error);
      return null;
    }),
    getLibraryPlates(libraryFileId).catch((error) => {
      console.error(`[slice] ${storyRef(storyId)}: couldn't read the model's plates`, error);
      return null;
    }),
    db.storyFilament.findMany({ where: { storyId }, select: { slotId: true, colorHex: true, designColor: true } }),
  ]);

  const count = filamentCountFor(slots?.projectSlots ?? 0, template.filament_presets.length);
  const colours = Array.from({ length: count }, (_, i) => {
    const slotId = i + 1;
    const pick = picks.find((p) => p.slotId === slotId);
    const designed = slots?.all.find((f) => f.slot_id === slotId)?.color;
    return hashHex(pick?.colorHex) || hashHex(pick?.designColor) || hashHex(designed);
  });

  const indices = (plates?.plates ?? []).map((p) => p.index).filter((n) => Number.isInteger(n) && n > 0);
  const offered = plates?.design_overrides ?? [];

  const request: SliceRequest = {
    printer_preset: template.printer_preset,
    process_preset: template.process_preset,
    filament_presets: Array.from({ length: count }, () => template.filament_presets[0]!),
    filament_colours: colours,
    bed_type: template.bed_type,
    export_3mf: true,
    ...(indices.length > 1 ? { plate: 0 } : indices.length === 1 ? { plate: indices[0]! } : {}),
    ...(offered.length > 0 && {
      design_overrides: offered.filter((o) => !o.printer_coupled && !o.preset_defining).map((o) => o.key),
    }),
  };
  // Plate 1 alone needs no plate on its queue entry; anything else does.
  const printPlates = indices.length > 1 || (indices.length === 1 && indices[0] !== 1) ? indices : [];
  return { request, printPlates, template };
}

/** Plan and start a slice; the caller records `sliceJobId`. */
async function startSlice(storyId: number, libraryFileId: number) {
  const plan = await planSlice(storyId, libraryFileId);
  const { job_id } = await sliceLibraryFile(libraryFileId, plan.request);
  return { jobId: job_id, printPlates: plan.printPlates };
}

/**
 * Claim a story for Bambuddy work — queueing a finished slice, or slicing it
 * again — the same way intake claims it, so a cron pass and intake (or two
 * passes) can never queue one ticket twice. Released by the status write
 * that ends the work (`intakeStartedAt: null`).
 */
async function claim(storyId: number): Promise<boolean> {
  const now = new Date();
  const won = await db.story.updateMany({
    where: { id: storyId, ...intakeNotRunning(now) },
    data: { intakeStartedAt: now },
  });
  return won.count === 1;
}

type AnnounceableStory = {
  id: number; title: string; status: StoryStatus; uploaderId: string; quantity: number; material: string | null;
};

/**
 * Queue a finished slice: one entry per plate per copy, every one created
 * waiting for a person (see `addToQueue`). With copies, all of them — every
 * plate's — share one batch, which is what the ticket then follows; a single
 * copy has no batch, so its entries are followed one by one.
 */
async function queueSliced(
  story: AnnounceableStory,
  result: NonNullable<SliceJob["result"]>,
  printPlates: number[],
  announcedFrom: StoryStatus,
): Promise<void> {
  const template = await loadTemplate(materialKeyFor(story.material));
  const target =
    template.target_kind === "printer" && template.target_printer_id
      ? { printer_id: template.target_printer_id }
      : template.target_model_class
        ? { target_model: template.target_model_class }
        : {};

  let batchId: number | null = null;
  const itemIds: number[] = [];
  for (const plate of printPlates.length > 0 ? printPlates : [undefined]) {
    const item = await addToQueue({
      library_file_id: result.library_file_id,
      quantity: story.quantity,
      ...target,
      ...(plate !== undefined && { plate_id: plate }),
      ...(batchId !== null && { batch_id: batchId }),
    });
    batchId ??= item.batch_id ?? null;
    itemIds.push(item.id);
  }

  await applyStatusChange(
    story,
    "Ready",
    {
      slicedLibraryFileId: result.library_file_id,
      queueBatchId: batchId,
      queueItemIds: batchId !== null ? [] : itemIds,
      printSeconds: Math.round(result.print_time_seconds) || null,
      filamentGrams: result.filament_used_g || null,
      errorMessage: null,
      intakeStartedAt: null,
    },
    announcedFrom,
  );
}

/** A slice Bambuddy reports as failed: final, with the slicer's own reason. */
async function sliceFailed(story: AnnounceableStory, job: SliceJob, announcedFrom: StoryStatus): Promise<void> {
  const reason = `Slice failed: ${job.error_detail?.trim() || "Bambuddy gave no reason."}`;
  await applyStatusChange(story, "Failed", { errorMessage: reason, intakeStartedAt: null }, announcedFrom);
  await notifyAdmin(`${storyRef(story.id)} — “${story.title}” — needs attention: ${reason}`, story.id);
}

/** Where a queued ticket stands: its batch's counts, or each of its entries. */
async function queueProgress(story: { queueBatchId: number | null; queueItemIds: number[] }) {
  const counts: QueueCounts = { pending: 0, printing: 0, completed: 0, failed: 0, cancelled: 0, skipped: 0 };
  let detail: string | null = null;

  if (story.queueBatchId !== null) {
    const batch = await getQueueBatch(story.queueBatchId);
    if (batch) {
      counts.pending = batch.pending_count;
      counts.printing = batch.printing_count;
      counts.completed = batch.completed_count;
      counts.failed = batch.failed_count;
      counts.cancelled = batch.cancelled_count;
      counts.skipped = batch.skipped_count;
    }
  } else {
    for (const id of story.queueItemIds) {
      const item = await getQueueItem(id).catch((error) => {
        if (error instanceof BambuddyError && error.status === 404) return null; // removed in Bambuddy
        throw error;
      });
      if (!item) continue;
      counts[item.status] += 1;
      // One entry's own words beat a summary: why it failed, or why a
      // pending one is waiting (e.g. "sliced for A1, not compatible with P2S").
      detail ??= item.status === "failed" ? item.error_message : item.status === "pending" ? item.waiting_reason : null;
    }
  }

  const outcome = queueOutcome(counts);
  return { status: outcome.status, note: outcome.status === "Failed" || outcome.status === "Ready" ? detail ?? outcome.note : outcome.note };
}

/** Intake waits this long for a slice before leaving it to the sync. */
const INTAKE_SLICE_POLLS = 7;
const INTAKE_SLICE_POLL_MS = 3000;

const RUN_SETTLED: ReadonlySet<string> = new Set(["completed", "failed", "partial_failure", "cancelled"]);

/** What intake and prep read about a story. */
const INTAKE_FIELDS = {
  id: true, title: true, modelUrl: true, status: true, uploaderId: true,
  quantity: true, libraryFileId: true, libraryFileKind: true, errorMessage: true,
  spoolId: true, material: true, colorName: true, colorHex: true,
  sliceJobId: true, pipelineRunId: true, queueBatchId: true, queueItemIds: true,
} as const;

type IntakeStory = Prisma.StoryGetPayload<{ select: typeof INTAKE_FIELDS }>;

/** Whether a story's model already reached Bambuddy's slicer or queue. */
function handedOff(story: { sliceJobId: number | null; pipelineRunId: number | null; queueBatchId: number | null; queueItemIds: number[] }) {
  return story.sliceJobId !== null || story.pipelineRunId !== null || story.queueBatchId !== null || story.queueItemIds.length > 0;
}

/** Plates to queue separately: none for a lone plate 1, else each plate. */
function platesToQueue(indices: number[]): number[] {
  return indices.length > 1 || (indices.length === 1 && indices[0] !== 1) ? indices : [];
}

/**
 * Carry on with a model that is already in Bambuddy's library — an upload, a
 * file the printer owner prepared, or a re-print of either — according to
 * what it is (`libraryFileKind`):
 *
 *   - "stl": geometry with no settings, so it waits for the printer owner to
 *     prepare it in Bambu Studio (`Prep`).
 *   - "gcode.3mf": already sliced, by the owner, for this printer: queued
 *     exactly as it is, every entry waiting for a person.
 *   - "3mf": a project, sliced like a MakerWorld model (its own settings,
 *     every plate, the ticket's colours). Returns the handoff to wait on.
 *
 * The caller holds the story's claim; every path that ends here releases it.
 */
async function fromLibraryFile(
  story: IntakeStory,
  announcedFrom: StoryStatus,
): Promise<{ jobId: number; printPlates: number[] } | null> {
  const libraryFileId = story.libraryFileId!;
  const asStory = { ...story, status: announcedFrom };

  if (story.libraryFileKind === "stl") {
    await applyStatusChange(asStory, "Prep", { errorMessage: null, intakeStartedAt: null }, announcedFrom);
    return null;
  }

  if (story.libraryFileKind === "gcode.3mf") {
    const plates = await getLibraryPlates(libraryFileId).catch(() => null);
    const indices = (plates?.plates ?? []).map((p) => p.index).filter((n) => Number.isInteger(n) && n > 0);
    await queueSliced(
      asStory,
      { library_file_id: libraryFileId, print_time_seconds: 0, filament_used_g: 0 },
      platesToQueue(indices),
      announcedFrom,
    );
    return null;
  }

  let slots: FilamentRequirement[] = [];
  try {
    slots = (await getFilamentSlots(libraryFileId)).used;
  } catch (error) {
    console.error(`[intake] ${storyRef(story.id)}: couldn't read the model's colours`, error);
  }
  await recordFilaments(story, slots);

  const slice = await startSlice(story.id, libraryFileId);
  const moved = await db.story.updateMany({
    where: { id: story.id, status: announcedFrom },
    data: { sliceJobId: slice.jobId, printPlates: slice.printPlates, status: "Slicing", errorMessage: null },
  });
  if (moved.count === 0) {
    console.error(`[intake] ${storyRef(story.id)} moved on mid-handoff; slice job ${slice.jobId} is unowned`);
    return null;
  }
  return slice;
}

/**
 * Wait briefly for a slice, since a small model is done in seconds and the
 * person is still on the page; anything slower is `syncStory`'s, on its next
 * pass. Never throws: the handoff is already saved.
 */
async function awaitSliceBriefly(
  asSlicing: AnnounceableStory,
  handoff: { jobId: number; printPlates: number[] },
  announcedFrom: StoryStatus,
): Promise<void> {
  try {
    for (let i = 0; i < INTAKE_SLICE_POLLS; i++) {
      await sleep(INTAKE_SLICE_POLL_MS);
      const job = await getSliceJob(handoff.jobId);
      if (!job) break; // forgotten already: sync slices it again
      if (job.status === "completed" && job.result) {
        await queueSliced(asSlicing, job.result, handoff.printPlates, announcedFrom);
        return;
      }
      if (job.status === "failed") {
        await sliceFailed(asSlicing, job, announcedFrom);
        return;
      }
    }
    await applyStatusChange(asSlicing, "Slicing", { intakeStartedAt: null }, announcedFrom);
  } catch (error) {
    console.error(`[intake] ${storyRef(asSlicing.id)}: waiting on slice job ${handoff.jobId} failed; sync will continue`, error);
    await db.story
      .update({ where: { id: asSlicing.id }, data: { intakeStartedAt: null } })
      .catch(() => {}); // row withdrawn, or the DB is down — the lease expires on its own
  }
}

/**
 * Carry on with a ticket in `Prep` once the printer owner has attached the
 * prepared file (src/lib/stories.ts sets `libraryFileId`/`libraryFileKind`
 * first): queue it as sliced, or slice the project. Called in the owner's
 * request. A failure is put on the ticket for the owner to see and retry —
 * the ticket stays in `Prep`.
 */
export async function processPreparedFile(storyId: number): Promise<void> {
  const story = await db.story.findUnique({ where: { id: storyId }, select: INTAKE_FIELDS });
  if (!story || story.status !== "Prep" || handedOff(story) || story.libraryFileId === null) return;
  if (!(await claim(story.id))) return;

  let handoff: { jobId: number; printPlates: number[] } | null;
  try {
    handoff = await fromLibraryFile(story, "Prep");
  } catch (error) {
    const message =
      error instanceof IntakeProblem || error instanceof BambuddyCloudExpiredError
        ? error instanceof IntakeProblem && error.adminDetail ? error.adminDetail : error.message
        : `Bambuddy couldn't take the prepared file: ${error instanceof Error ? error.message : String(error)}`;
    await db.story.update({ where: { id: story.id }, data: { errorMessage: message, intakeStartedAt: null } });
    return;
  }
  if (handoff) await awaitSliceBriefly({ ...story, status: "Slicing" }, handoff, "Prep");
}

/**
 * Send a request to Bambuddy for the first time: resolve, import, read its
 * colours, and start slicing it directly (`planSlice`, from the template
 * pipeline's settings). Called once, synchronously, right after a story is
 * created, and again for any story `syncOpenStories` still finds `Requested`
 * on a later pass, so a transient failure (Bambuddy briefly down, Bambu
 * Cloud expired) heals itself once the underlying problem is fixed, without
 * anyone having to retry by hand.
 *
 * The handoff — `libraryFileId`, `sliceJobId`, `Slicing` — is saved the
 * moment the slice job exists. Then it waits a few seconds for the slice
 * and, if it's done, queues it (`queueSliced`, every entry created waiting
 * for a person) and tells the requester where the story landed. A slower
 * slice is `syncStory`'s to finish on a later pass.
 *
 * Never throws. A failure before the handoff is swallowed into
 * `errorMessage` and retried: a failed intake attempt is not a bug, it's
 * exactly the case `Requested` with an error exists for. A notification to
 * the admin only fires the *first* time a given error appears, so a problem
 * that needs a human (Bambu Cloud re-auth, most likely) is announced once
 * rather than every sync interval.
 */
export async function processIntake(storyId: number): Promise<void> {
  const story = await db.story.findUnique({
    where: { id: storyId },
    select: {
      ...INTAKE_FIELDS,
    },
  });
  // Already handed to Bambuddy: sliced, slicing, or queued. (An upload has a
  // library file from the start, so that alone doesn't mean handed off.)
  if (!story || story.status !== "Requested" || handedOff(story)) return;

  // The check above is only a snapshot, and nothing is written until the
  // slice has started — long enough for a cron tick to start a second import
  // of the same story. Claim the row atomically; whoever loses the race backs off.
  const now = new Date();
  const claimed = await db.story.updateMany({
    where: {
      id: story.id,
      status: "Requested",
      sliceJobId: null,
      pipelineRunId: null,
      queueBatchId: null,
      ...intakeNotRunning(now),
    },
    data: { intakeStartedAt: now },
  });
  if (claimed.count === 0) return;

  let handoff: { jobId: number; printPlates: number[] };
  let slots: FilamentRequirement[] = [];
  let profileFellBack = false;
  try {
    if (story.libraryFileId !== null && story.libraryFileKind !== null) {
      // An upload, a prepared file, or a re-print of either: already in
      // Bambuddy's library, so no MakerWorld steps.
      const next = await fromLibraryFile(story, "Requested");
      if (!next) return;
      handoff = next;
    } else {
      const resolved = await resolveMakerWorldUrl(story.modelUrl);

      let imported;
      try {
        try {
          imported = await importMakerWorldModel({
            model_id: resolved.model_id,
            profile_id: resolved.profile_id,
          });
        } catch (error) {
          // The link named a print profile (a `?…`/`#profileId-…` part) that
          // Bambu won't serve. Confirmed live: a share link's profile answered
          // 502 "Bambu Lab API unexpected status 400 for profile …", while the
          // same model with no profile imported fine. Fall back to the model's
          // default profile once, and tell the requester below. A 401 is Bambu
          // Cloud, which no retry fixes, so it goes straight through.
          if (
            resolved.profile_id == null ||
            !(error instanceof BambuddyError) ||
            error.status === 401
          ) {
            throw error;
          }
          imported = await importMakerWorldModel({ model_id: resolved.model_id });
          profileFellBack = true;
        }
      } catch (error) {
        // Confirmed live: a missing/expired Bambu Cloud link answers exactly
        // this 401, even for a model already in the library — see
        // BambuddyCloudExpiredError's own comment in bambuddy.ts.
        if (error instanceof BambuddyError && error.status === 401) {
          throw new BambuddyCloudExpiredError();
        }
        throw error;
      }

      // The model's colours, recorded before slicing so a re-slice (and the
      // slice itself) uses the ticket's picks. Best-effort: a failed read just
      // means no colour slots, and the slice falls back to the template's count.
      try {
        slots = (await getFilamentSlots(imported.library_file_id)).used;
      } catch (error) {
        console.error(`[intake] ${storyRef(story.id)}: couldn't read the model's colours`, error);
      }
      await recordFilaments(story, slots);

      const slice = await startSlice(story.id, imported.library_file_id);

      // Record the handoff the moment the slice job exists. From here on the
      // story belongs to `syncStory`: it queues the result, or slices again if
      // Bambuddy forgets the job. Nothing can print from a slice the app never
      // queued, so a lost job costs only a re-slice. Guarded on `Requested` as
      // a backstop; decline and withdraw already refuse while the claim above
      // is held.
      const recorded = await db.story.updateMany({
        where: { id: story.id, status: "Requested" },
        data: {
          libraryFileId: imported.library_file_id,
          libraryFileKind: "3mf",
          sliceJobId: slice.jobId,
          printPlates: slice.printPlates,
          status: "Slicing",
          resolvedTitle: resolvedTitleFrom(resolved),
          errorMessage: null,
        },
      });
      if (recorded.count === 0) {
        console.error(`[intake] ${storyRef(story.id)} left Requested mid-intake; slice job ${slice.jobId} is unowned`);
        return;
      }
      handoff = slice;
    }
  } catch (error) {
    const message =
      error instanceof BambuddyCloudExpiredError || error instanceof IntakeProblem
        ? error.message
        : "Bambuddy couldn't take this request. It'll retry automatically."; // detail withheld from the requester; see the audit row for the real message

    await db.story.update({ where: { id: story.id }, data: { errorMessage: message, intakeStartedAt: null } });

    if (story.errorMessage !== message) {
      const forAdmin = error instanceof IntakeProblem && error.adminDetail ? error.adminDetail : message;
      await notifyAdmin(`${storyRef(story.id)} — “${story.title}” — needs attention: ${forAdmin}`, story.id);
      await record({
        action: "story.intake_failed",
        subject: storyRef(story.id),
        detail: {
          title: story.title,
          error:
            error instanceof IntakeProblem && error.adminDetail
              ? error.adminDetail
              : error instanceof Error
                ? error.message
                : String(error),
          // What Bambuddy said, not just its status code: a bare "502" from
          // an import doesn't say whether MakerWorld refused the download or
          // Bambuddy couldn't reach it. Admin-only, so it's kept whole-ish.
          ...(error instanceof BambuddyError && error.body !== undefined && {
            bambuddy: JSON.stringify(error.body).slice(0, 500),
          }),
        },
      });
    }
    return;
  }

  if (profileFellBack) {
    await notify({
      recipientId: story.uploaderId,
      storyId: story.id,
      text:
        `“${story.title}”: the print profile in your link couldn't be downloaded, ` +
        "so the model's default profile is being used instead.",
    });
  }

  await awaitSliceBriefly({ ...story, status: "Slicing" }, handoff, "Requested");
}

/**
 * Apply a derived status change to a story already past `Requested`: update
 * the row, tell the requester, tell the admin too when it just became
 * `Ready` — that's the "ready to print" pile they review by hand — and
 * write the audit row. A no-op if the status hasn't actually changed.
 */
async function applyStatusChange(
  story: { id: number; title: string; status: StoryStatus; uploaderId: string },
  to: StoryStatus,
  extra: {
    queueItemId?: number;
    slicedLibraryFileId?: number | null;
    archiveId?: number | null;
    errorMessage?: string | null;
    intakeStartedAt?: null;
    sliceJobId?: number;
    printPlates?: number[];
    queueBatchId?: number | null;
    queueItemIds?: number[];
    printSeconds?: number | null;
    filamentGrams?: number | null;
  } = {},
  /**
   * The status the requester last heard about, when it differs from the
   * row's. Intake writes `Slicing` silently at handoff and announces the
   * whole move from `Requested` once it knows where the story landed.
   */
  announcedFrom: StoryStatus = story.status,
): Promise<void> {
  await db.story.update({
    where: { id: story.id },
    data: { status: to, ...extra },
  });

  // `extra` (waiting_reason, archive_id) is worth keeping fresh even on a
  // poll that doesn't move the status — the write above already did that.
  // Only the notify/audit noise below is conditional on an actual change.
  if (to === announcedFrom) return;

  const ref = storyRef(story.id);
  await notify({
    recipientId: story.uploaderId,
    storyId: story.id,
    text: `“${story.title}” is now ${statusLabel(to)}.`,
  });
  if (to === "Ready") {
    await notifyAdmin(`${ref} — “${story.title}” — sliced and ready to print.`, story.id);
  }
  if (to === "Prep") {
    await notifyAdmin(`${ref} — “${story.title}” — needs prep: open it in Bambu Studio, then attach the result.`, story.id);
  }

  await record({
    action: "story.status_changed",
    subject: ref,
    detail: { from: announcedFrom, to, title: story.title },
  });
}

/**
 * Advance a story that's already reached Bambuddy (`libraryFileId` is set).
 *
 * Sliced directly (every ticket since direct slicing):
 *   - Queued (`queueBatchId` or `queueItemIds`): status from all its entries
 *     together — `queueOutcome`.
 *   - Slicing (`sliceJobId`): when the job has finished, queue the result;
 *     when it failed, `Failed` with the slicer's reason; when Bambuddy has
 *     forgotten it, slice again. Queueing and re-slicing take the same claim
 *     as intake, so nothing is ever queued twice.
 *
 * Legacy, for tickets sliced through a Slicer Pipeline run before that:
 *   - No `queueItemId`: watch the pipeline run, and — every poll, not just
 *     once — check for a queue entry among its jobs and secure it the
 *     moment one appears; see `secureQueueEntries`'s own comment for why.
 *   - `queueItemId` set: watch the queue item and apply `deriveStatus`
 *     directly. Also re-asserts manual-start defensively while the item is
 *     still `pending`.
 */
export async function syncStory(storyId: number): Promise<void> {
  const story = await db.story.findUnique({
    where: { id: storyId },
    select: {
      id: true, title: true, status: true, uploaderId: true, quantity: true, material: true,
      pipelineRunId: true, queueItemId: true, intakeStartedAt: true,
      libraryFileId: true, sliceJobId: true, printPlates: true,
      queueBatchId: true, queueItemIds: true,
    },
  });
  if (!story || isTerminal(story.status)) return;
  if (story.status === "Prep") return; // waiting on the printer owner, not on Bambuddy

  // `processIntake` may still be in its tight poll for this story. Securing
  // queue entries below stays on regardless — it's idempotent, and the one
  // thing that must not wait on a lease if intake died mid-poll — but the
  // status change is left to intake so the requester isn't told twice.
  const intakeRunning =
    story.intakeStartedAt !== null &&
    story.intakeStartedAt.getTime() > Date.now() - INTAKE_LEASE_MS;

  // --- sliced and queued directly (every ticket since direct slicing) ---
  if (story.queueBatchId !== null || story.queueItemIds.length > 0) {
    const progress = await queueProgress(story);
    await applyStatusChange(story, progress.status, { errorMessage: progress.note });
    return;
  }
  if (story.sliceJobId !== null) {
    if (intakeRunning) return; // intake is waiting on this slice itself
    const job = await getSliceJob(story.sliceJobId);
    if (job && job.status !== "completed" && job.status !== "failed") return; // still slicing

    if (job?.status === "failed") {
      await sliceFailed(story, job, story.status);
      return;
    }
    if (!(await claim(story.id))) return;
    try {
      if (job?.status === "completed" && job.result) {
        await queueSliced(story, job.result, story.printPlates, story.status);
      } else {
        // Bambuddy forgot the job — restarted, or it finished more than 30
        // minutes ago without this pass seeing it. Nothing was queued from
        // it, so slicing again is safe; at worst the library keeps a spare
        // sliced file.
        const slice = await startSlice(story.id, story.libraryFileId!);
        await db.story.update({
          where: { id: story.id },
          data: { sliceJobId: slice.jobId, printPlates: slice.printPlates, intakeStartedAt: null },
        });
        console.info(`[sync] ${storyRef(story.id)}: slice job ${story.sliceJobId} was gone; re-sliced as ${slice.jobId}`);
      }
    } catch (error) {
      await db.story.update({ where: { id: story.id }, data: { intakeStartedAt: null } }).catch(() => {});
      throw error;
    }
    return;
  }

  // --- legacy: sliced through a Slicer Pipeline run, before direct slicing ---

  if (story.queueItemId) {
    if (story.status === "Ready") {
      try {
        await setManualStart(story.queueItemId);
      } catch {
        // Best effort — getQueueItem just below is the source of truth either way.
      }
    }
    const item = await getQueueItem(story.queueItemId);
    const to = deriveStatus({ queueItemStatus: item.status });
    await applyStatusChange(story, to, {
      archiveId: item.archive_id,
      errorMessage: to === "Failed" ? item.error_message : item.waiting_reason,
    });
    return;
  }

  if (!story.pipelineRunId) return; // Requested — processIntake's job, not this one.

  const run = await getPipelineRun(story.pipelineRunId);
  if (!run) {
    console.error(`[sync] ${storyRef(story.id)}: pipeline run ${story.pipelineRunId} not found`);
    return;
  }

  const secured = await secureQueueEntries(run);
  if (intakeRunning) return;
  if (secured.length > 0) {
    const queueItemId = secured[0]!;
    const item = await getQueueItem(queueItemId);
    const to = deriveStatus({ queueItemStatus: item.status });
    await applyStatusChange(story, to, {
      queueItemId,
      slicedLibraryFileId: run.sliced_library_file_id,
      archiveId: item.archive_id,
      errorMessage: to === "Failed" ? item.error_message : item.waiting_reason,
    });
    return;
  }

  const unqueued = unqueuedReason(run);
  if (unqueued) {
    await applyStatusChange(story, "Failed", {
      slicedLibraryFileId: run.sliced_library_file_id,
      errorMessage: unqueued,
    });
    await notifyAdmin(`${storyRef(story.id)} — “${story.title}” — needs attention: ${unqueued}`, story.id);
    return;
  }

  const to = deriveStatus({ pipelineRunStatus: run.status });
  await applyStatusChange(story, to, {
    errorMessage: to === "Failed" ? run.error_message : null,
  });
}

/**
 * The whole open rail, one pass. Called by the cron route — see
 * src/app/api/cron/sync/route.ts. Sequential on purpose: a family-scale
 * queue is a handful of open tickets, not a scale where a failure in one
 * story's sync should race another's.
 */
export async function syncOpenStories(): Promise<{ processed: number }> {
  const stories = await db.story.findMany({
    where: { status: { notIn: ["Done", "Failed", "Declined"] } },
    select: { id: true, status: true },
  });

  for (const s of stories) {
    try {
      if (s.status === "Requested") await processIntake(s.id);
      else await syncStory(s.id);
    } catch (error) {
      console.error(`[sync] story ${s.id} failed`, error);
    }
  }

  return { processed: stories.length };
}
