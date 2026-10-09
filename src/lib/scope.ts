/**
 * The pure authorisation rules — no session, no database, no request.
 *
 * These are deliberately separate from `authz.ts`, which is `server-only`
 * because it reads cookies. Keeping the predicates here means they can be
 * imported by tests and probes and exercised directly, rather than being
 * re-implemented (and drifting) wherever they need checking.
 */
import type { FeatureStatus, Prisma, StoryStatus } from "@prisma/client";

export type Actor = {
  id: string;
  name: string;
  email: string;
  initials: string;
  role: "client" | "admin";
};

/**
 * The handoff's core rule:
 *
 *   Client -> only stories where uploaderId == self
 *   Admin  -> everything
 *
 * Every list query composes this. One place to audit, and a new screen
 * cannot quietly forget it.
 */
export function storyScope(actor: Actor): Prisma.StoryWhereInput {
  return actor.role === "admin" ? {} : { uploaderId: actor.id };
}

/**
 * Display key: PPP-104 for story 4.
 *
 * The handoff writes this as "PTFM-", after the product's old name. The
 * prefix exists to be recognisable when someone pastes it into chat, so it
 * tracks what the product is actually called.
 */
export const storyRef = (id: number) => `PPP-${100 + id}`;

/**
 * How many colours the printer can feed in one print: the AMS's slots, which
 * is also how many filament presets the Slicer Pipeline carries (one per AMS
 * slot). A model needing more is flagged to the owner rather than refused; it
 * may still print with manual swaps, and that is their call.
 */
export const AMS_SLOTS = 4;

/**
 * How many filament presets to slice a model with: one per filament slot its
 * project defines, or `fallback` (the template's own count) when that isn't
 * known.
 *
 * Bambu Studio's CLI can't take more filaments than a multi-colour project
 * defines. Confirmed live, slicing through Bambuddy:
 *
 *   project slots  presets  result
 *   1              1 or 4   slices
 *   3              3        slices
 *   3              4        aborts ("Flush volumes matrix do not match to
 *                           the correct size!")
 *   7 (6 used)     6 or 7   slices
 *
 * The project's own count is the one that slices in every case measured, and
 * it gives every slot the PLA preset rather than leaving some to the file's.
 */
export function filamentCountFor(projectSlots: number, fallback: number): number {
  return projectSlots >= 1 ? projectSlots : fallback;
}

/** One slot a project defines, from Bambuddy's `full_slots=true` filament-requirements read. */
export type ProjectFilamentSlot = { slot_id: number; color: string | null };

/** A ticket's own pick for one colour slot (a `StoryFilament` row). */
export type FilamentPick = { slotId: number; colorHex: string | null; designColor: string | null };

/** `#RRGGBB` (or `#RRGGBBAA`), or null for anything else Bambuddy sends. */
function hexOrNull(value: string | null | undefined): string | null {
  if (!value) return null;
  const hex = value.replace(/^#/, "");
  return /^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(hex) ? `#${hex}` : null;
}

/**
 * The `filament_colours` a slice request sends — one entry per project
 * slot, lined up with `filament_presets` by position. Ordered by ascending
 * `slot_id`, not `slot_id === i + 1`: a project's own slot numbering isn't
 * guaranteed contiguous from 1 (a single-colour model's only slot has been
 * seen numbered 3), so treating position `i` as slot id `i + 1` silently
 * read the wrong slot — or no slot at all — for every colour after the
 * first whenever the real ids skipped a number. The ticket's own pick wins,
 * then the designer's colour, then Bambuddy's default (empty string) —
 * never falling back to a *different* slot's colour, which is what made a
 * two-colour print's second colour quietly become a copy of the first.
 */
export function filamentColoursFor(
  count: number,
  projectSlots: ProjectFilamentSlot[],
  picks: FilamentPick[],
): string[] {
  const ordered = [...projectSlots].sort((a, b) => a.slot_id - b.slot_id);
  return Array.from({ length: count }, (_, i) => {
    const slot = ordered[i];
    if (!slot) return "";
    const pick = picks.find((p) => p.slotId === slot.slot_id);
    return hexOrNull(pick?.colorHex) ?? hexOrNull(pick?.designColor) ?? hexOrNull(slot.color) ?? "";
  });
}

/** How a ticket's print-queue entries stand, from a Bambuddy batch or each entry. */
export type QueueCounts = {
  pending: number;
  printing: number;
  completed: number;
  failed: number;
  cancelled: number;
  skipped: number;
};

/**
 * A ticket's status from all of its queue entries — one per plate per copy.
 * `note` goes on the ticket as its message when there's something a person
 * should know (some prints didn't happen; the entries vanished).
 */
export function queueOutcome(c: QueueCounts): { status: StoryStatus; note: string | null } {
  const didnt = c.failed + c.cancelled + c.skipped;
  const total = c.pending + c.printing + c.completed + didnt;
  // Deleted from Bambuddy's queue before any finished: the owner's doing,
  // like a cancel. (A finished ticket is never polled again, so clearing
  // old entries out of the queue doesn't land here.)
  if (total === 0) {
    return { status: "Declined", note: "Its print queue entries were removed in Bambuddy." };
  }
  if (c.printing > 0 || (c.pending > 0 && c.completed > 0)) {
    return { status: "Printing", note: c.completed > 0 ? `${c.completed} of ${total} printed so far.` : null };
  }
  if (c.pending > 0) return { status: "Ready", note: null };
  if (c.completed > 0) {
    return {
      status: "Done",
      note: didnt > 0 ? `${c.completed} of ${total} printed; ${didnt} didn't (failed or cancelled in Bambuddy).` : null,
    };
  }
  // Nothing printed, and nothing failed: every entry was cancelled (or
  // skipped) in Bambuddy, which here only ever means the printer owner said
  // no — the same as declining it by hand.
  if (c.failed === 0) {
    return {
      status: "Declined",
      note: `${total === 1 ? "Cancelled" : `All ${total} prints were cancelled`} in Bambuddy by the printer owner.`,
    };
  }
  return {
    status: "Failed",
    note: `${total === 1 ? "The print" : `None of the ${total} prints`} went through — failed or cancelled in Bambuddy.`,
  };
}

/**
 * While the requester can still change a ticket's colours: up to the moment
 * the print starts. Every request is sliced as PLA, so colour never affects
 * slicing; it only matters when the owner maps slots to the AMS in Bambuddy.
 */
export const COLOUR_EDITABLE: readonly StoryStatus[] = ["Requested", "Prep", "Slicing", "Ready"];

/**
 * The columns the board draws, in the order a request actually moves through
 * them. Unlike the old flow, nothing here is "the only order it may move
 * in" — a story's status is derived from Bambuddy's state on every sync
 * (`deriveStatus`, below), not stepped forward one click at a time. This
 * array exists for display order only.
 *
 * Note the enum in schema.prisma keeps its own member order: Postgres cannot
 * reorder enum values without rebuilding the type, and the order there
 * carries no meaning. This array is where the sequence lives.
 */
export const BOARD = [
  "Requested",
  "Prep",
  "Slicing",
  "Ready",
  "Printing",
] as const satisfies readonly StoryStatus[];

/**
 * How a status reads to a person, where the enum's own name doesn't. `Prep`
 * is "Needs prep": the ticket waits for the printer owner to prepare the
 * model in Bambu Studio and attach the result.
 */
export const STATUS_LABEL: Partial<Record<StoryStatus, string>> = { Prep: "Needs prep" };
export const statusLabel = (status: StoryStatus | string): string =>
  STATUS_LABEL[status as StoryStatus] ?? status;

/** Every status a ticket can be in — `BOARD`'s order plus the three that leave it. */
export const ALL_STATUSES = [...BOARD, "Done", "Failed", "Declined"] as const satisfies readonly StoryStatus[];

/** Is this the end of the line? */
export function isTerminal(status: StoryStatus): boolean {
  return status === "Done" || status === "Failed" || status === "Declined";
}

/**
 * The two pieces of Bambuddy state a story's status is derived from. Either
 * may be absent — a story that hasn't reached that stage yet simply has
 * `null`/`undefined` there, which is why `Requested` and `Slicing` fall out
 * of this without a special case.
 */
export type BambuddyProgress = {
  pipelineRunStatus?:
    | "queued"
    | "slicing"
    | "dispatching"
    | "in_progress"
    | "completed"
    | "failed"
    | "partial_failure"
    | "cancelled"
    | null;
  queueItemStatus?: "pending" | "printing" | "completed" | "failed" | "skipped" | "cancelled" | null;
};

/**
 * What a story's status should be right now, given the latest known state of
 * its Bambuddy handoff (see src/lib/bambuddy.ts for how that's fetched).
 *
 * Pure and total on purpose, the same reason the rest of this file has no
 * session or database in it: this is called on every sync, potentially for
 * every open story, and it needs to be cheap and exercised directly by
 * tests rather than re-implemented per caller.
 *
 * A cancelled (or skipped) entry or run is `Declined`, not `Failed`: in
 * this app a cancel only ever comes from the printer owner in Bambuddy, and
 * it means the same as declining by hand. `deriveStatus` is never called for
 * a story that's already `Declined`, since that is terminal.
 */
export function deriveStatus(progress: BambuddyProgress): StoryStatus {
  switch (progress.queueItemStatus) {
    case "pending":
      return "Ready";
    case "printing":
      return "Printing";
    case "completed":
      return "Done";
    case "failed":
      return "Failed";
    case "cancelled":
    case "skipped":
      return "Declined";
  }

  switch (progress.pipelineRunStatus) {
    case "completed":
      // The queue item is created in the same step that observes this
      // completion — see stories.ts — so this case is transient in
      // practice. Treated as "not yet queued" rather than "ready" if it's
      // ever seen on its own, since there is no queue item to point at.
      return "Slicing";
    case "failed":
    case "partial_failure":
      return "Failed";
    case "cancelled":
      return "Declined";
    case "queued":
    case "slicing":
    case "dispatching":
    case "in_progress":
      return "Slicing";
  }

  return "Requested";
}

export class AuthzError extends Error {}

/**
 * Only the admin declines a story, and only before it has gone anywhere —
 * once Bambuddy has state for it, saying no is a conversation and a
 * withdrawal, not a status change.
 */
export function assertDecline(actor: Actor, from: StoryStatus): void {
  if (actor.role !== "admin") {
    throw new AuthzError("Only the printer owner can decline a request.");
  }
  // Prep holds nothing in Bambuddy's queue yet — saying no is still clean.
  if (from !== "Requested" && from !== "Prep") {
    throw new AuthzError(`Cannot decline a request that is already ${statusLabel(from)}.`);
  }
}

// ---------------------------------------------------------------------------
// Feature requests — the 'frr' track
//
// The same pure rules as the print backlog above, for the parallel
// feature-request flow. Kept here beside them, and deliberately NOT merged
// into one generic helper: the print rules are load-bearing and exercised
// directly by the suites, so the two stay legible and independently testable
// rather than sharing a cleverness that a change to one could quietly bend for
// the other. What they share: Done leaves the board, Declined is terminal and
// only from Requested. What they don't: a print's status is derived from
// Bambuddy (`deriveStatus`), while a feature request is stepped forward by the
// owner, one stage at a time (`assertFeatureTransition`).
// ---------------------------------------------------------------------------

/**
 * A feature request's flow, stepped by the owner. `Shipped` is "released, go
 * and check it"; `Done` is "closed and off the board", the way `Done` is for
 * a print.
 */
export const FEATURE_FLOW = [
  "Requested",
  "Accepted",
  "InProgress",
  "Shipped",
  "Done",
] as const satisfies readonly FeatureStatus[];

/** The board columns — the flow minus its terminal state. */
export const FEATURE_BOARD = FEATURE_FLOW.slice(0, -1) as readonly FeatureStatus[];

/**
 * Display labels. The enum can carry no space, so `InProgress` is written out
 * for people. Everything else reads as-is.
 */
export const FEATURE_STATUS_LABEL: Record<FeatureStatus, string> = {
  Requested: "Requested",
  Accepted: "Accepted",
  InProgress: "In progress",
  Shipped: "Shipped",
  Done: "Done",
  Declined: "Declined",
};

export const featureLabel = (status: FeatureStatus): string =>
  FEATURE_STATUS_LABEL[status] ?? status;

/**
 * Display ref: FRR-101 for feature request 1. Recognisable when pasted into
 * chat, and parallel to `PPP-` for a print.
 */
export const featureRef = (id: number) => `FRR-${100 + id}`;

/**
 * The scope rule, mirroring `storyScope`:
 *   Client -> only their own requests
 *   Admin  -> everything
 */
export function featureScope(actor: Actor): Prisma.FeatureRequestWhereInput {
  return actor.role === "admin" ? {} : { requesterId: actor.id };
}

export function isFeatureTerminal(status: FeatureStatus): boolean {
  return status === FEATURE_FLOW[FEATURE_FLOW.length - 1] || status === "Declined";
}

export function nextFeatureStatus(current: FeatureStatus): FeatureStatus | null {
  const i = (FEATURE_FLOW as readonly string[]).indexOf(current);
  if (i < 0 || i === FEATURE_FLOW.length - 1) return null;
  return FEATURE_FLOW[i + 1]!;
}

/**
 * Only the owner moves a request, only forwards, only one step at a time.
 * `Declined` is reachable from `Requested` alone.
 */
export function assertFeatureTransition(
  actor: Actor,
  from: FeatureStatus,
  to: FeatureStatus,
): void {
  if (actor.role !== "admin") {
    throw new AuthzError("Only the printer owner moves a request along.");
  }
  if (to === "Declined") {
    if (from !== "Requested") {
      throw new AuthzError(`Cannot decline a request that is already ${featureLabel(from)}.`);
    }
    return;
  }
  if (nextFeatureStatus(from) !== to) {
    throw new AuthzError(
      `${featureLabel(from)} → ${featureLabel(to)} is not a step along the flow.`,
    );
  }
}
