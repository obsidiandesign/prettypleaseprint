import "server-only";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { Prisma, StoryStatus } from "@prisma/client";

import { db } from "@/lib/db";
import { record } from "@/lib/audit";
import { notify, printerName, printerOwner } from "@/lib/authz";
import {
  ALL_STATUSES,
  AuthzError,
  assertDecline,
  storyRef,
  storyScope,
  type Actor,
} from "@/lib/scope";
import { listSpools } from "@/lib/bambuddy";
import { processIntake } from "@/lib/bambuddy-sync";
import { QuantitySchema } from "@/lib/catalog";

/**
 * Everything that can happen to a ticket, in one place.
 *
 * This file exists because there are now two front doors onto the same
 * operations — the server-rendered forms in `src/app/actions/stories.ts` and
 * the JSON API under `src/app/api/stories` — and an authorisation rule that
 * lives in the caller is a rule that only holds for the caller that
 * remembered it. Everything below takes an `Actor` and decides for itself:
 * who may, from which state, what the uploader is told, and what goes in the
 * trail. A new front door gets all of that by construction.
 *
 * The rules the admin actions have always had are unchanged, and are
 * enforced here rather than in the layer above:
 *
 *   1. Role is checked on every call. Not rendering a button is not
 *      authorisation, and neither is not documenting an endpoint.
 *   2. `Declined` goes through `assertDecline` — admin only, and only from
 *      `Requested`. Every other status is *derived*, not moved by hand —
 *      see `deriveStatus` in scope.ts and the sync path below.
 *   3. The uploader is told. That is the whole point of the Activity panel.
 *   4. An audit row is written *after* the change commits, so the trail
 *      cannot claim something that did not happen.
 *
 * What is deliberately NOT here: `redirect`, `notFound`, and anything that
 * knows about a form or a status code. Failures leave as `StoryProblem`,
 * which carries an HTTP status the API can answer with and a sentence the
 * form can put in a toast. Translating one into the other is the caller's
 * job, because the right answer differs — see `src/lib/api.ts` for why the
 * API says 403 where a page says 404.
 */

/** A refusal with both a status code and something a person can read. */
export class StoryProblem extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "StoryProblem";
  }
}

const problem = (status: number, message: string) => new StoryProblem(status, message);

/** `assertTransition` speaks `AuthzError`; the layers above speak status codes. */
function asProblem(error: unknown): never {
  if (error instanceof AuthzError) throw problem(403, error.message);
  throw error;
}

export const IdSchema = z.coerce.number().int().positive();

/**
 * Every status a ticket can be in, for parsing a `?status=` filter.
 *
 * Built from `ALL_STATUSES` rather than typed out, so a new status added
 * there is filterable the day it lands.
 */
export const StatusSchema = z.enum([...ALL_STATUSES] as [string, ...string[]])
  .transform((s) => s as StoryStatus);

export const ReasonSchema = z
  .string()
  .trim()
  .min(3, "Say what is wrong with it — that is the whole point of a flag.")
  .max(200, "Keep the reason short.");

export const BodySchema = z
  .string()
  .trim()
  .min(1, "Say something first.")
  .max(2000, "That is longer than a comment wants to be.");

/**
 * A new request: a link, not a file. `spoolId` is the only way color and
 * material reach the row — see `createStoryFromLink`, which looks the spool
 * up in live Bambuddy inventory rather than trusting a client-supplied name
 * and color together.
 */
export const CreateStorySchema = z.object({
  title: z
    .string()
    .trim()
    .min(1, "Give it a title.")
    .max(120, "Keep the title under 120 characters."),
  modelUrl: z
    .string()
    .trim()
    .min(1, "Paste a model link.")
    .max(2000, "That link is too long."),
  spoolId: z.coerce.number().int().positive("Pick a color."),
  quantity: QuantitySchema,
  note: z.string().trim().max(2000, "That note is very long.").optional().default(""),
  neededBy: z.coerce.date().optional(),
});

export type CreateStoryInput = z.infer<typeof CreateStorySchema>;

/** Parse a path segment or form field into a story id, or refuse it. */
export function storyIdOr400(raw: unknown): number {
  const parsed = IdSchema.safeParse(raw);
  if (!parsed.success) throw problem(400, "That is not a ticket.");
  return parsed.data;
}

function refresh(id: number) {
  revalidatePath("/queue");
  revalidatePath("/board");
  revalidatePath("/me");
  revalidatePath(`/story/${id}`);
}

const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? name;

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * The columns every representation of a story is built from.
 *
 * Written out rather than selecting the whole row, and that is the security
 * control: the uploader's e-mail address — the board shows a name and
 * initials, and so does the API — is not on this list, so no caller can leak
 * it by forgetting to strip it.
 *
 * Also deliberately absent: the Bambuddy handoff ids (`libraryFileId`,
 * `pipelineRunId`, `slicedLibraryFileId`, `queueItemId`, `archiveId`). They
 * are sync plumbing, not something a requester or the board needs to
 * render — `status` and `errorMessage` are the requester-facing summary of
 * what those ids mean at any given moment.
 */
export const STORY_FIELDS = {
  id: true,
  title: true,
  status: true,
  flagged: true,
  flagReason: true,
  quantity: true,
  neededBy: true,
  modelUrl: true,
  resolvedTitle: true,
  plateCount: true,
  spoolId: true,
  material: true,
  colorName: true,
  colorHex: true,
  tip: true,
  note: true,
  errorMessage: true,
  createdAt: true,
  updatedAt: true,
  uploaderId: true,
  uploader: { select: { id: true, name: true, initials: true } },
  _count: { select: { comments: true } },
} satisfies Prisma.StorySelect;

export type StoryRow = Prisma.StoryGetPayload<{ select: typeof STORY_FIELDS }>;

// ---------------------------------------------------------------------------
// History — the prints that have left, or are leaving, the active rail
// ---------------------------------------------------------------------------

/**
 * What the History view lists: work that is no longer moving through the
 * board. `Done` (printed and handed over), `Failed` (Bambuddy couldn't
 * finish it) and `Declined` are the terminal states. Anything still
 * `Requested`/`Slicing`/`Ready`/`Printing` belongs on the rail, not here.
 */
export const HISTORY_STATUSES = ["Done", "Failed", "Declined"] as const satisfies readonly StoryStatus[];

export type HistoryFilters = {
  /** One of HISTORY_STATUSES, or undefined for all of them. */
  status?: StoryStatus;
  material?: string;
  /** Only tickets filed within this many days; undefined = all time. */
  sinceDays?: number;
};

/** Fields the history rows render. Named, so no column leaks by a spread. */
const HISTORY_FIELDS = {
  id: true,
  title: true,
  status: true,
  material: true,
  colorHex: true,
  modelUrl: true,
  tip: true,
  flagged: true,
  errorMessage: true,
  createdAt: true,
  uploaderId: true,
  uploader: { select: { name: true, initials: true } },
} satisfies Prisma.StorySelect;

export type HistoryRow = Prisma.StoryGetPayload<{ select: typeof HISTORY_FIELDS }>;

/**
 * A person's history, newest first. Scoped exactly like the board — a client
 * sees only their own, the owner sees the group — with the filters ANDed onto
 * the scope so no combination of them can widen the set.
 */
export function listHistory(actor: Actor, filters: HistoryFilters = {}): Promise<HistoryRow[]> {
  const inHistory = filters.status && (HISTORY_STATUSES as readonly string[]).includes(filters.status)
    ? { status: filters.status }
    : { status: { in: [...HISTORY_STATUSES] } };

  const where: Prisma.StoryWhereInput = {
    AND: [
      storyScope(actor),
      inHistory,
      ...(filters.material ? [{ material: filters.material as Prisma.StoryWhereInput["material"] }] : []),
      ...(filters.sinceDays
        ? [{ createdAt: { gte: new Date(Date.now() - filters.sinceDays * 86_400_000) } }]
        : []),
    ],
  };

  return db.story.findMany({ where, select: HISTORY_FIELDS, orderBy: { createdAt: "desc" } });
}

export type StoryQuery = {
  status?: StoryStatus[];
  flagged?: boolean;
  mine?: boolean;
  limit?: number;
  /** Id of the last story on the previous page. Ids descend, so this is `id <`. */
  before?: number;
};

export const LIST_LIMIT_DEFAULT = 25;
export const LIST_LIMIT_MAX = 100;

/**
 * List the stories this actor may see, newest first.
 *
 * `storyScope` is the first term of the AND, so a client cannot widen the set
 * with any combination of the filters — the worst a hostile query does is
 * narrow its own results.
 *
 * Paging is a cursor on the id rather than an offset. Ids are autoincrement,
 * so id-descending is creation-descending, and a cursor cannot skip or repeat
 * a row when something is inserted mid-page the way `skip`/`take` can.
 */
export async function listStories(actor: Actor, query: StoryQuery = {}) {
  const limit = Math.min(Math.max(query.limit ?? LIST_LIMIT_DEFAULT, 1), LIST_LIMIT_MAX);

  const where: Prisma.StoryWhereInput = {
    AND: [
      storyScope(actor),
      ...(query.mine ? [{ uploaderId: actor.id }] : []),
      ...(query.status?.length ? [{ status: { in: query.status } }] : []),
      ...(query.flagged === undefined ? [] : [{ flagged: query.flagged }]),
      ...(query.before === undefined ? [] : [{ id: { lt: query.before } }]),
    ],
  };

  // One more than asked for, so "is there another page" is answered by the
  // query rather than by a second count that could disagree with it.
  const rows = await db.story.findMany({
    where,
    select: STORY_FIELDS,
    orderBy: { id: "desc" },
    take: limit + 1,
  });

  const stories = rows.slice(0, limit);
  return {
    stories,
    nextCursor: rows.length > limit ? (stories[stories.length - 1]?.id ?? null) : null,
  };
}

/**
 * One story, under the caller's scope.
 *
 * Returns null rather than throwing so the caller decides what "not visible"
 * looks like. Both callers make it indistinguishable from "does not exist",
 * which is the point: a 403 here would confirm the ticket is real.
 */
export function findStory(actor: Actor, id: number): Promise<StoryRow | null> {
  return db.story.findFirst({
    where: { AND: [{ id }, storyScope(actor)] },
    select: STORY_FIELDS,
  });
}

/** As `findStory`, but refuses instead of returning null. */
export async function getStory(actor: Actor, id: number): Promise<StoryRow> {
  const story = await findStory(actor, id);
  if (!story) throw problem(404, "That ticket no longer exists.");
  return story;
}

/**
 * The admin's view of a ticket for an action on it.
 *
 * Unscoped on purpose — `storyScope` is `{}` for an admin anyway, and going
 * through it here would suggest the scope is doing work it is not. The role
 * check is the control, and it is the first line.
 */
async function loadForAdmin(actor: Actor, id: number) {
  if (actor.role !== "admin") {
    throw problem(403, "Only the printer owner moves a story along.");
  }
  const story = await db.story.findUnique({
    where: { id },
    include: { uploader: { select: { id: true, name: true } } },
  });
  if (!story) throw problem(404, "That ticket no longer exists.");
  return story;
}

// ---------------------------------------------------------------------------
// The printer owner's actions
// ---------------------------------------------------------------------------
//
// There used to be an `advanceStory` here — a manual, one-step-at-a-time
// click that moved a ticket forward. That no longer fits: every status but
// `Declined` is now *derived* from Bambuddy's own state (`deriveStatus` in
// scope.ts), not moved by hand. Its replacement is a system-triggered sync
// (poll the story's pipeline run / queue item, apply `deriveStatus`, notify
// on change) — deliberately not written here, since it isn't a person
// clicking a button and doesn't fit this file's "every function takes an
// Actor" contract. That belongs in its own module alongside whatever
// schedules it (a cron route, most likely), landing with the intake flow
// that actually creates `libraryFileId`/`pipelineRunId`/`queueItemId` for a
// sync to have something to poll.

/**
 * Decline. Terminal, and only reachable from `Requested` — once a request
 * has reached Bambuddy, saying no is a conversation and a withdrawal, not a
 * status change.
 */
export async function declineStory(actor: Actor, id: number) {
  const story = await loadForAdmin(actor, id);

  try {
    assertDecline(actor, story.status);
  } catch (e) {
    asProblem(e);
  }

  await db.story.update({ where: { id: story.id }, data: { status: "Declined" } });

  await notify({
    recipientId: story.uploaderId,
    storyId: story.id,
    text: `${firstName(actor.name)} declined “${story.title}”.`,
  });
  await record({
    action: "story.declined",
    actor,
    subject: storyRef(story.id),
    detail: { title: story.title },
  });

  refresh(story.id);
  return {
    id: story.id,
    ref: storyRef(story.id),
    title: story.title,
    from: story.status,
    to: "Declined" as StoryStatus,
    uploaderName: story.uploader.name,
  };
}

/**
 * Flag a model problem.
 *
 * Deliberately does NOT change the status: a flagged ticket is still wherever
 * it was, it just has a note on it saying why it cannot proceed as-is. The
 * reason is required, because "flagged" with no explanation tells the person
 * waiting nothing they can act on.
 */
export async function flagStory(actor: Actor, id: number, rawReason: unknown) {
  const story = await loadForAdmin(actor, id);

  const parsed = ReasonSchema.safeParse(typeof rawReason === "string" ? rawReason : "");
  if (!parsed.success) {
    throw problem(400, parsed.error.issues[0]?.message ?? "Give a reason.");
  }
  const reason = parsed.data;

  await db.story.update({
    where: { id: story.id },
    data: { flagged: true, flagReason: reason },
  });

  await notify({
    recipientId: story.uploaderId,
    storyId: story.id,
    text: `${firstName(actor.name)} flagged “${story.title}”: ${reason}`,
  });
  await record({
    action: "story.flagged",
    actor,
    subject: storyRef(story.id),
    detail: { title: story.title, reason },
  });

  refresh(story.id);
  return {
    id: story.id,
    ref: storyRef(story.id),
    title: story.title,
    reason,
    uploaderName: story.uploader.name,
  };
}

/**
 * Clear a flag once it has been dealt with.
 *
 * Not in the handoff, but a flag with no way off is a dead end: the ticket
 * would carry "needs a look" for the rest of its life even after the model
 * was fixed. The uploader is told, because they are the one who fixed it.
 */
export async function clearFlag(actor: Actor, id: number) {
  const story = await loadForAdmin(actor, id);
  if (!story.flagged) throw problem(409, "That ticket is not flagged.");

  await db.story.update({
    where: { id: story.id },
    data: { flagged: false, flagReason: null },
  });

  await notify({
    recipientId: story.uploaderId,
    storyId: story.id,
    text: `${firstName(actor.name)} cleared the flag on “${story.title}”.`,
  });
  await record({
    action: "story.flag_cleared",
    actor,
    subject: storyRef(story.id),
    detail: { title: story.title },
  });

  refresh(story.id);
  return {
    id: story.id,
    ref: storyRef(story.id),
    title: story.title,
    uploaderName: story.uploader.name,
  };
}

// ---------------------------------------------------------------------------
// The requester's action
// ---------------------------------------------------------------------------

/**
 * File a new request from a pasted model link.
 *
 * `spoolId` is resolved against `listSpools()` here, server-side — the only
 * way a client can name a color is by picking one that is actually in stock
 * right now, not by sending a name and a hex code that no longer match
 * anything. `material`/`colorName`/`colorHex` are copied onto the row at
 * this moment and never re-read from Bambuddy afterward, on purpose: the
 * ticket should keep showing what was picked even if that spool is later
 * restocked under a different id or archived.
 *
 * `processIntake` runs once, synchronously, right after the row commits —
 * the common case is the requester sees `Slicing` before this call even
 * returns. It cannot fail this function: a Bambuddy hiccup leaves the
 * ticket `Requested` with an `errorMessage`, which the cron sync retries
 * (see src/lib/bambuddy-sync.ts) rather than making the requester resubmit.
 */
export async function createStoryFromLink(actor: Actor, input: CreateStoryInput) {
  const spools = await listSpools();
  const spool = spools.find((s) => s.id === input.spoolId);
  if (!spool) {
    throw problem(409, "That color isn't available any more — refresh and pick again.");
  }

  const story = await db.story.create({
    data: {
      title: input.title,
      uploaderId: actor.id,
      status: "Requested",
      modelUrl: input.modelUrl,
      quantity: input.quantity,
      neededBy: input.neededBy ?? null,
      note: input.note,
      spoolId: spool.id,
      material: spool.material,
      colorName: spool.color_name ?? "Unnamed",
      colorHex: spool.rgba,
    },
    select: { id: true, title: true },
  });

  await record({
    action: "story.created",
    actor,
    subject: storyRef(story.id),
    detail: { title: story.title, modelUrl: input.modelUrl, spoolId: spool.id },
  });

  const owner = await printerOwner();
  if (owner && owner.id !== actor.id) {
    await notify({
      recipientId: owner.id,
      storyId: story.id,
      text: `${actor.name} asked for “${story.title}”.`,
    });
  }

  await processIntake(story.id);

  refresh(story.id);
  return { id: story.id, ref: storyRef(story.id), title: story.title };
}

/**
 * The person who asked for a print withdraws it.
 *
 * **Only before Bambuddy has state for it.** Allowed while `Requested`
 * (nothing sent yet) or `Declined` (already dead) — the window a requester
 * should be able to change their mind in when a better model turns up or
 * plans move on (FRR-101). Once it is `Slicing` or later, Bambuddy holds a
 * library file and possibly a queue item; tearing those down on withdrawal
 * is real work this app doesn't do yet (see the sync note above), so for
 * now the ticket stays and the requester asks the owner instead.
 */
export async function withdrawStory(actor: Actor, id: number) {
  // Scoped read: a client asking after somebody else's story gets the same
  // answer as one asking after a story that does not exist.
  const story = await db.story.findFirst({
    where: { AND: [{ id }, storyScope(actor)] },
    select: {
      id: true, title: true, status: true,
      uploaderId: true, uploader: { select: { name: true } },
    },
  });
  if (!story) throw problem(404, "That ticket no longer exists.");

  // An admin can see every story; being able to see one is not being allowed
  // to withdraw it. Only the person who asked for it may take it back.
  if (story.uploaderId !== actor.id) {
    throw problem(403, "Only the person who asked for it can withdraw it.");
  }

  if (story.status !== "Requested" && story.status !== "Declined") {
    throw problem(
      409,
      `${storyRef(story.id)} is already ${story.status.toLowerCase()} — ` +
        `ask ${await printerName()} instead.`,
    );
  }

  const ref = storyRef(story.id);
  const owner = await printerOwner();

  await db.story.delete({ where: { id: story.id } });

  // Tell the printer owner when they had it in hand — a request still
  // waiting on them.
  if (owner && story.status === "Requested" && owner.id !== actor.id) {
    await notify({
      recipientId: owner.id,
      text: `${actor.name} withdrew ${ref} — “${story.title}”.`,
    });
  }

  await record({
    action: "story.withdrawn",
    actor,
    subject: ref,
    detail: { title: story.title, wasStatus: story.status },
  });

  refresh(story.id);
  return { id: story.id, ref, title: story.title, wasStatus: story.status };
}

/**
 * Print an old request again, without re-pasting the link (FRR-102).
 *
 * A first print is often a test; when it works, or needs another go, this
 * opens a brand-new `Requested` ticket from any of the requester's own past
 * tickets — a finished one, a declined one, anything — copying the wish
 * fields across, but none of the old Bambuddy handoff ids. A requeue is a
 * fresh request in Bambuddy's eyes too: the same system trigger that
 * processes any other `Requested` story (see the sync note above) resolves
 * and imports the link again, rather than this reusing a library file or
 * queue item that may no longer exist on the Bambuddy side. Only the person
 * who filed the original may re-queue it — being able to see a ticket (an
 * admin sees all) is not being the person whose request it is to repeat.
 */
export async function requeueStory(actor: Actor, id: number) {
  const src = await db.story.findFirst({
    where: { AND: [{ id }, storyScope(actor)] },
    select: {
      id: true, title: true, quantity: true, neededBy: true, modelUrl: true,
      spoolId: true, material: true, colorName: true, colorHex: true,
      tip: true, note: true, uploaderId: true,
    },
  });
  if (!src) throw problem(404, "That ticket no longer exists.");
  if (src.uploaderId !== actor.id) {
    throw problem(403, "Only the person who asked for it can print it again.");
  }

  const created = await db.story.create({
    data: {
      title: src.title,
      uploaderId: actor.id,
      status: "Requested",
      quantity: src.quantity,
      neededBy: src.neededBy,
      modelUrl: src.modelUrl,
      spoolId: src.spoolId,
      material: src.material,
      colorName: src.colorName,
      colorHex: src.colorHex,
      tip: src.tip,
      note: src.note,
    },
    select: { id: true },
  });

  const owner = await printerOwner();
  if (owner && owner.id !== actor.id) {
    await notify({
      recipientId: owner.id,
      storyId: created.id,
      text: `${actor.name} re-queued “${src.title}”.`,
    });
  }

  await record({
    action: "story.requeued",
    actor,
    subject: storyRef(created.id),
    detail: { title: src.title, from: storyRef(src.id) },
  });

  refresh(created.id);
  return {
    id: created.id,
    ref: storyRef(created.id),
    title: src.title,
    fromRef: storyRef(src.id),
  };
}

// ---------------------------------------------------------------------------
// The conversation
// ---------------------------------------------------------------------------

export const COMMENT_FIELDS = {
  id: true,
  storyId: true,
  body: true,
  createdAt: true,
  author: { select: { id: true, name: true, initials: true, role: true } },
} satisfies Prisma.CommentSelect;

export type CommentRow = Prisma.CommentGetPayload<{ select: typeof COMMENT_FIELDS }>;

/** The thread on a ticket the caller can see. Oldest first, as the page reads it. */
export async function listComments(actor: Actor, id: number): Promise<CommentRow[]> {
  await getStory(actor, id); // scoped: refuses before any comment is read
  return db.comment.findMany({
    where: { storyId: id },
    select: COMMENT_FIELDS,
    orderBy: { createdAt: "asc" },
  });
}

/**
 * Say something on a ticket.
 *
 * Both sides may write here — it is the one place in the app where the client
 * has something to do besides upload and wait. Which is exactly why the
 * visibility check matters: the story is loaded through `storyScope`, so a
 * client naming another person's story id finds nothing and is told the
 * ticket does not exist. Not "you may not", which would confirm it does.
 *
 * The notification goes to the *other* side. Nobody needs telling about
 * their own comment, and a feed full of your own words is a feed people
 * stop reading.
 */
export async function addComment(actor: Actor, id: number, rawBody: unknown) {
  const parsed = BodySchema.safeParse(typeof rawBody === "string" ? rawBody : "");
  if (!parsed.success) {
    throw problem(400, parsed.error.issues[0]?.message ?? "Check that again.");
  }
  const body = parsed.data;

  const story = await db.story.findFirst({
    where: { AND: [{ id }, storyScope(actor)] },
    select: { id: true, title: true, uploaderId: true },
  });
  if (!story) throw problem(404, "That ticket no longer exists.");

  const comment = await db.comment.create({
    data: { storyId: story.id, authorId: actor.id, body },
    select: COMMENT_FIELDS,
  });

  // Whoever is not the author. An admin writing tells the uploader; a client
  // writing tells the printer owner.
  const recipientId =
    actor.role === "admin" ? story.uploaderId : (await printerOwner())?.id;

  if (recipientId && recipientId !== actor.id) {
    await notify({
      recipientId,
      storyId: story.id,
      text: `${firstName(actor.name)} commented on “${story.title}”.`,
    });
  }

  await record({
    action: "comment.added",
    actor,
    subject: storyRef(story.id),
    detail: { title: story.title, length: body.length },
  });

  revalidatePath(`/story/${story.id}`);
  return comment;
}
