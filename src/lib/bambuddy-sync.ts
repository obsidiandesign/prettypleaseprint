import "server-only";
import type { StoryStatus } from "@prisma/client";

import { db } from "@/lib/db";
import { record } from "@/lib/audit";
import { notify, printerOwner } from "@/lib/authz";
import { deriveStatus, isTerminal, storyRef } from "@/lib/scope";
import {
  BambuddyCloudExpiredError,
  BambuddyError,
  addToQueue,
  getPipelineRun,
  getQueueItem,
  importMakerWorldModel,
  resolveMakerWorldUrl,
  runSlicerPipeline,
  type MakerWorldResolvedModel,
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
 * Send a request to Bambuddy for the first time: resolve, import, kick off
 * the standard-PLA pipeline (`BAMBUDDY_PIPELINE_ID` — see bambuddy.ts,
 * there's only the one). Called once, synchronously, right after a story is
 * created — the common case is the requester sees "Slicing" within the same
 * request — and again for any story `syncOpenStories` still finds
 * `Requested` on a later pass, so a transient failure (Bambuddy briefly
 * down, Bambu Cloud expired) heals itself once the underlying problem is
 * fixed, without anyone having to retry by hand.
 *
 * Every failure is swallowed into `errorMessage` rather than thrown: a
 * failed intake attempt is not a bug, it's exactly the case `Requested` with
 * an error exists for. A notification to the admin only fires the *first*
 * time a given error appears, so a problem that needs a human (Bambu Cloud
 * re-auth, most likely) is announced once rather than every sync interval.
 */
export async function processIntake(storyId: number): Promise<void> {
  const story = await db.story.findUnique({
    where: { id: storyId },
    select: { id: true, title: true, modelUrl: true, status: true, libraryFileId: true, errorMessage: true },
  });
  if (!story || story.status !== "Requested" || story.libraryFileId) return;

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

    const run = await runSlicerPipeline(imported.library_file_id);

    await db.story.update({
      where: { id: story.id },
      data: {
        libraryFileId: imported.library_file_id,
        pipelineRunId: run.id,
        status: "Slicing",
        resolvedTitle: resolvedTitleFrom(resolved),
        errorMessage: null,
      },
    });

    await record({
      action: "story.status_changed",
      subject: storyRef(story.id),
      detail: { from: "Requested", to: "Slicing", title: story.title },
    });
  } catch (error) {
    const message =
      error instanceof BambuddyCloudExpiredError
        ? error.message
        : "Bambuddy couldn't take this request. It'll retry automatically."; // detail withheld from the requester; see the audit row for the real message

    await db.story.update({ where: { id: story.id }, data: { errorMessage: message } });

    if (story.errorMessage !== message) {
      await notifyAdmin(`${storyRef(story.id)} — “${story.title}” — needs attention: ${message}`, story.id);
      await record({
        action: "story.intake_failed",
        subject: storyRef(story.id),
        detail: { title: story.title, error: error instanceof Error ? error.message : String(error) },
      });
    }
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
  extra: { archiveId?: number | null; errorMessage?: string | null } = {},
): Promise<void> {
  if (to === story.status) return;

  await db.story.update({
    where: { id: story.id },
    data: { status: to, ...extra },
  });

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
    detail: { from: story.status, to, title: story.title },
  });
}

/**
 * Advance a story that's already reached Bambuddy (`libraryFileId` is set).
 * Two stages, told apart by whether a queue item exists yet:
 *
 *   - No `queueItemId`: watch the pipeline run. Once it completes, this is
 *     the one place a queue item gets created — `addToQueue` — which is why
 *     this function, not `deriveStatus`, owns that handoff.
 *   - `queueItemId` set: watch the queue item and apply `deriveStatus`
 *     directly; Bambuddy's own state is the entire answer from here on.
 */
export async function syncStory(storyId: number): Promise<void> {
  const story = await db.story.findUnique({
    where: { id: storyId },
    select: {
      id: true, title: true, status: true, uploaderId: true,
      pipelineRunId: true, queueItemId: true,
    },
  });
  if (!story || isTerminal(story.status)) return;

  if (story.queueItemId) {
    const item = await getQueueItem(story.queueItemId);
    const to = deriveStatus({ queueItemStatus: item.status });
    await applyStatusChange(story, to, {
      archiveId: item.archive_id,
      errorMessage: to === "Failed" ? item.error_message : null,
    });
    return;
  }

  if (!story.pipelineRunId) return; // Requested — processIntake's job, not this one.

  const run = await getPipelineRun(story.pipelineRunId);
  if (!run) {
    console.error(`[sync] ${storyRef(story.id)}: pipeline run ${story.pipelineRunId} not found`);
    return;
  }

  if (run.status === "completed") {
    if (!run.sliced_library_file_id) {
      console.error(`[sync] ${storyRef(story.id)}: run ${run.id} completed with no sliced file`);
      await applyStatusChange(story, "Failed", { errorMessage: "Slicing finished with nothing to queue." });
      return;
    }
    const item = await addToQueue(run.sliced_library_file_id);
    await db.story.update({ where: { id: story.id }, data: { slicedLibraryFileId: run.sliced_library_file_id, queueItemId: item.id } });
    await applyStatusChange(story, deriveStatus({ queueItemStatus: item.status }));
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
