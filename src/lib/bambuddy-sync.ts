import "server-only";
import type { Prisma, StoryStatus } from "@prisma/client";

import { db } from "@/lib/db";
import { record } from "@/lib/audit";
import { notify, printerOwner } from "@/lib/authz";
import { deriveStatus, isTerminal, storyRef } from "@/lib/scope";
import {
  BambuddyCloudExpiredError,
  BambuddyError,
  getPipelineRun,
  getQueueItem,
  importMakerWorldModel,
  resolveMakerWorldUrl,
  runSlicerPipeline,
  setManualStart,
  type MakerWorldResolvedModel,
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
class IntakeProblem extends Error {}

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
  if (run.status !== "completed") return null;
  if (run.jobs.some((job) => job.queue_entry_id != null)) return null;
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

const RUN_SETTLED: ReadonlySet<string> = new Set(["completed", "failed", "partial_failure", "cancelled"]);

/**
 * Send a request to Bambuddy for the first time: resolve, import, kick off
 * the standard-PLA pipeline (`BAMBUDDY_PIPELINE_ID` — see bambuddy.ts,
 * there's only the one). Called once, synchronously, right after a story is
 * created, and again for any story `syncOpenStories` still finds `Requested`
 * on a later pass, so a transient failure (Bambuddy briefly down, Bambu
 * Cloud expired) heals itself once the underlying problem is fixed, without
 * anyone having to retry by hand.
 *
 * The handoff — `libraryFileId`, `pipelineRunId`, `Slicing` — is saved the
 * moment the pipeline run exists. Then it polls tightly (a few seconds
 * apart) for up to ~40s, specifically to catch and secure a queue entry as
 * early as possible — see `secureQueueEntries` — and tells the requester
 * where the story landed. If dispatch hasn't happened by then, or the poll
 * fails, `syncStory`'s regular poll picks up the queue entry (and secures
 * it) whenever it does appear.
 *
 * Never throws. A failure before the handoff is swallowed into
 * `errorMessage` and retried: a failed intake attempt is not a bug, it's
 * exactly the case `Requested` with an error exists for. A notification to the admin only fires the *first*
 * time a given error appears, so a problem that needs a human (Bambu Cloud
 * re-auth, most likely) is announced once rather than every sync interval.
 */
export async function processIntake(storyId: number): Promise<void> {
  const story = await db.story.findUnique({
    where: { id: storyId },
    select: {
      id: true, title: true, modelUrl: true, status: true, uploaderId: true,
      quantity: true, libraryFileId: true, errorMessage: true,
    },
  });
  if (!story || story.status !== "Requested" || story.libraryFileId) return;

  // The check above is only a snapshot, and nothing is written for ~40s
  // below — long enough for a cron tick to start a second import of the same
  // story. Claim the row atomically; whoever loses the race backs off.
  const now = new Date();
  const claimed = await db.story.updateMany({
    where: {
      id: story.id,
      status: "Requested",
      libraryFileId: null,
      ...intakeNotRunning(now),
    },
    data: { intakeStartedAt: now },
  });
  if (claimed.count === 0) return;

  let handoff: PipelineRun;
  try {
    const resolved = await resolveMakerWorldUrl(story.modelUrl);

    let imported;
    try {
      imported = await importMakerWorldModel({
        model_id: resolved.model_id,
        profile_id: resolved.profile_id,
      });
    } catch (error) {
      // Confirmed live: a missing/expired Bambu Cloud link answers exactly
      // this 401, even for a model already in the library — see
      // BambuddyCloudExpiredError's own comment in bambuddy.ts.
      if (error instanceof BambuddyError && error.status === 401) {
        throw new BambuddyCloudExpiredError();
      }
      throw error;
    }

    let run: PipelineRun;
    try {
      run = await runSlicerPipeline(imported.library_file_id, story.quantity);
    } catch (error) {
      // Confirmed live: refused with 409 and an eligibility report when the
      // pipeline has no target printer or model class configured — see
      // BAMBUDDY_PIPELINE_ID in .env.example. Distinct from a transient
      // failure: nothing here self-heals until an admin fixes the pipeline
      // in Bambuddy, so it's worth naming specifically rather than folding
      // into the generic message below.
      if (error instanceof BambuddyError && error.status === 409) {
        throw new IntakeProblem(
          "Bambuddy's Slicer Pipeline isn't configured with a target printer or " +
            "model class — fix this in Bambuddy under Settings → Slicer Pipelines.",
        );
      }
      throw error;
    }

    // Record the handoff the moment the run exists, before anything else can
    // throw. From here on the story belongs to `syncStory`, not to a retry of
    // this function: a retry would start a second run, and nothing would
    // ever watch the first one's queue entry — which then auto-starts.
    // Guarded on `Requested` as a backstop; decline and withdraw already
    // refuse while the claim above is held.
    const handedOff = await db.story.updateMany({
      where: { id: story.id, status: "Requested" },
      data: {
        libraryFileId: imported.library_file_id,
        pipelineRunId: run.id,
        status: "Slicing",
        resolvedTitle: resolvedTitleFrom(resolved),
        errorMessage: null,
      },
    });
    if (handedOff.count === 0) {
      console.error(`[intake] ${storyRef(story.id)} left Requested mid-intake; pipeline run ${run.id} is unowned`);
      return;
    }
    handoff = run;
  } catch (error) {
    const message =
      error instanceof BambuddyCloudExpiredError || error instanceof IntakeProblem
        ? error.message
        : "Bambuddy couldn't take this request. It'll retry automatically."; // detail withheld from the requester; see the audit row for the real message

    await db.story.update({ where: { id: story.id }, data: { errorMessage: message, intakeStartedAt: null } });

    if (story.errorMessage !== message) {
      await notifyAdmin(`${storyRef(story.id)} — “${story.title}” — needs attention: ${message}`, story.id);
      await record({
        action: "story.intake_failed",
        subject: storyRef(story.id),
        detail: { title: story.title, error: error instanceof Error ? error.message : String(error) },
      });
    }
    return;
  }

  // Past the handoff: poll tightly to secure the queue entry early. A
  // failure here is not an intake failure — `syncStory` secures and advances
  // the same run on its next pass — so it only ends the tight poll.
  const asSlicing = { ...story, status: "Slicing" as StoryStatus };
  let run = handoff;
  try {
    for (let i = 0; i < 20; i++) {
      const secured = await secureQueueEntries(run);
      if (secured.length > 0) {
        const item = await getQueueItem(secured[0]!);
        const to = deriveStatus({ queueItemStatus: item.status });
        await applyStatusChange(asSlicing, to, {
          queueItemId: secured[0]!,
          slicedLibraryFileId: run.sliced_library_file_id,
          archiveId: item.archive_id,
          errorMessage: to === "Failed" ? item.error_message : item.waiting_reason,
          intakeStartedAt: null,
        }, "Requested");
        return;
      }
      if (RUN_SETTLED.has(run.status)) break;

      await sleep(2000);
      const refreshed = await getPipelineRun(run.id);
      if (!refreshed) break;
      run = refreshed;
    }

    const to = deriveStatus({ pipelineRunStatus: run.status });
    await applyStatusChange(asSlicing, to, {
      slicedLibraryFileId: run.sliced_library_file_id,
      errorMessage: to === "Failed" ? run.error_message : null,
      intakeStartedAt: null,
    }, "Requested");
  } catch (error) {
    // The handoff is already saved, so the story is safe either way; at
    // worst the requester hears about its status one sync pass later.
    console.error(`[intake] ${storyRef(story.id)}: polling pipeline run ${run.id} failed; sync will continue`, error);
    await db.story
      .update({ where: { id: story.id }, data: { intakeStartedAt: null } })
      .catch(() => {}); // row withdrawn, or the DB is down — the lease expires on its own
  }
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
    text: `“${story.title}” is now ${to}.`,
  });
  if (to === "Ready") {
    await notifyAdmin(`${ref} — “${story.title}” — sliced and ready to print.`, story.id);
  }

  await record({
    action: "story.status_changed",
    subject: ref,
    detail: { from: announcedFrom, to, title: story.title },
  });
}

/**
 * Advance a story that's already reached Bambuddy (`libraryFileId` is set).
 * Two stages, told apart by whether a queue item exists yet:
 *
 *   - No `queueItemId`: watch the pipeline run, and — every poll, not just
 *     once — check for a queue entry among its jobs and secure it the
 *     moment one appears. This is the fallback for whatever `processIntake`'s
 *     own tight poll didn't catch; see `secureQueueEntries`'s own comment
 *     for why that matters.
 *   - `queueItemId` set: watch the queue item and apply `deriveStatus`
 *     directly. Also re-asserts manual-start defensively while the item is
 *     still `pending` — cheap, and this is the one thing in the whole flow
 *     worth being paranoid about twice.
 */
export async function syncStory(storyId: number): Promise<void> {
  const story = await db.story.findUnique({
    where: { id: storyId },
    select: {
      id: true, title: true, status: true, uploaderId: true,
      pipelineRunId: true, queueItemId: true, intakeStartedAt: true,
    },
  });
  if (!story || isTerminal(story.status)) return;

  // `processIntake` may still be in its tight poll for this story. Securing
  // queue entries below stays on regardless — it's idempotent, and the one
  // thing that must not wait on a lease if intake died mid-poll — but the
  // status change is left to intake so the requester isn't told twice.
  const intakeRunning =
    story.intakeStartedAt !== null &&
    story.intakeStartedAt.getTime() > Date.now() - INTAKE_LEASE_MS;

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
