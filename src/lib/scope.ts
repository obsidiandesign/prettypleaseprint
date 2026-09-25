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
  "Slicing",
  "Ready",
  "Printing",
] as const satisfies readonly StoryStatus[];

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
 * `Declined` is deliberately not derivable here — it's the one status a
 * person still sets by hand, and only before any Bambuddy state exists.
 * `deriveStatus` is never called for a story that's already `Declined`.
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
    case "cancelled":
    case "skipped":
      return "Failed";
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
    case "cancelled":
      return "Failed";
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
  if (from !== "Requested") {
    throw new AuthzError(`Cannot decline a request that is already ${from}.`);
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
// the other. The *shape* is identical on purpose — forward-only, one step,
// Done leaves the board, Declined terminal from Requested — so the owner
// handles a feature request exactly as they handle a print.
// ---------------------------------------------------------------------------

/**
 * A feature request's flow. Same shape as `FLOW`, feature-appropriate names.
 * `Shipped` is "released, go and check it"; `Done` is "closed and off the
 * board", the way `Delivery`/`Done` work for a print.
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
