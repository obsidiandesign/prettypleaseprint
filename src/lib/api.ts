import "server-only";
import { NextResponse } from "next/server";

import { currentUser } from "@/lib/authz";
import { storyRef, type Actor } from "@/lib/scope";
import { StoryProblem, type CommentRow, type StoryRow } from "@/lib/stories";
import { getSettings } from "@/lib/settings";
import type { Prisma } from "@prisma/client";

/**
 * The JSON API's boundary.
 *
 * Route handlers under `/api` are not pages, and three things have to work
 * differently for them. All three live here rather than being remembered
 * fourteen times.
 *
 * **1. Refusals are answers, not redirects.** Middleware deliberately never
 * redirects `/api/*` — a caller with no session needs a 401 with a body it
 * can parse, not a 307 to an HTML sign-in page. That means every handler owes
 * its own authorisation check, and `withActor` is how it pays.
 *
 * **2. The API says 403 where a page says 404.** Everywhere else in this app
 * an admin-only surface answers 404, because a 403 would confirm the route
 * exists. That reasoning does not survive publishing an OpenAPI document:
 * `/api/stories/{id}/advance` is listed at `/api/openapi.json` and rendered at
 * `/docs`, so its existence is already public and a 404 would be theatre —
 * worse than theatre, because it would tell an honest client that their
 * ticket had vanished when the truth is that they are not the printer owner.
 * Existence of a *ticket* is still hidden: an unauthorised read is 404, via
 * `storyScope`, exactly as before.
 *
 * **3. CSRF.** The app's model is Better Auth's — `SameSite=Lax` on the
 * session cookie, plus an Origin check — and this keeps to it. Any request
 * that changes something is refused if it arrives with an `Origin` header
 * naming somewhere other than this deployment. A browser always sends that
 * header on a cross-site write, so a hostile page cannot drive the API even
 * if the cookie somehow rode along; a script that is not a browser sends no
 * Origin at all and is allowed through, which is what makes `curl` and the
 * bearer token useful.
 */

const appOrigin = () => {
  try {
    return new URL(process.env.BETTER_AUTH_URL ?? "http://localhost:3000").origin;
  } catch {
    return "http://localhost:3000";
  }
};

/** The error envelope the upload route has always used. One shape, everywhere. */
export const fail = (status: number, error: string) =>
  NextResponse.json({ error }, { status });

export const ok = <T>(data: T, status = 200) => NextResponse.json(data, { status });

const WRITES = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Refuse a write that a browser sent from somewhere else.
 *
 * Absent is fine — that is `curl`, or a same-origin GET. Present and wrong is
 * not, and no legitimate caller produces it.
 */
function crossOrigin(request: Request): boolean {
  if (!WRITES.has(request.method)) return false;
  const origin = request.headers.get("origin");
  if (!origin) return false;
  return origin !== appOrigin();
}

type Handler<P> = (
  request: Request,
  actor: Actor,
  params: P,
) => Promise<Response> | Response;

/**
 * Next generates a type check per route asserting the handler's second
 * parameter accepts `{ params: Promise<…> }` — required, even on a route with
 * no dynamic segment. Declaring it optional here made `npm run typecheck`
 * fail on every paramless route, which is the build catching a genuine
 * mismatch rather than a nuisance.
 */
type Context<P> = { params: Promise<P> };

type Options = {
  /** Refuse anyone but the printer owner, with 403. */
  admin?: boolean;
};

/**
 * Wrap a route handler with the four things every one of them needs: the
 * Origin check, a session, the role gate, and turning a `StoryProblem` into
 * the status code it is carrying.
 *
 * Anything that is *not* a `StoryProblem` is a bug. It is logged and answered
 * 500 with a fixed sentence — never the message, never a stack. Malformed
 * input returning a stack trace is its own finding (`A05-stacktrace`).
 */
export function withActor<P = Record<string, string>>(
  handler: Handler<P>,
  options: Options = {},
) {
  return async (request: Request, context: Context<P>): Promise<Response> => {
    if (crossOrigin(request)) {
      return fail(403, "Cross-origin writes are refused.");
    }

    const actor = await currentUser();
    if (!actor) return fail(401, "Sign in first.");

    if (options.admin && actor.role !== "admin") {
      return fail(403, "Only the printer owner can do that.");
    }

    try {
      // Optional at runtime even though the type is not: a route with no
      // dynamic segment is called with nothing to unwrap.
      const params = ((await context?.params) ?? {}) as P;
      return await handler(request, actor, params);
    } catch (error) {
      if (error instanceof StoryProblem) return fail(error.status, error.message);
      console.error(`[api] ${request.method} ${new URL(request.url).pathname}`, error);
      return fail(500, "Something went wrong at our end.");
    }
  };
}

/**
 * Read a JSON body, tolerantly.
 *
 * An empty body is `{}` rather than an error: several of these endpoints take
 * no arguments at all, and making `POST /advance` fail without a literal `{}`
 * would be a papercut for every caller with nothing to say. A body that is
 * present and not JSON is still refused — that is a caller who meant
 * something and got it wrong.
 */
export async function jsonBody(request: Request): Promise<Record<string, unknown>> {
  const raw = await request.text();
  if (!raw.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new StoryProblem(400, "The body must be a JSON object.");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof StoryProblem) throw error;
    throw new StoryProblem(400, "That body is not valid JSON.");
  }
}

// ---------------------------------------------------------------------------
// What goes on the wire
// ---------------------------------------------------------------------------

/**
 * A story, as the API describes it.
 *
 * The one thing worth saying about this function is what it does not do:
 * there is no spread of the database row anywhere in it. Every field is
 * named, so a column added to the schema tomorrow — a private note, a cost,
 * a supplier reference — does not appear on the wire because somebody forgot
 * to exclude it. The Bambuddy handoff ids (`libraryFileId`, `pipelineRunId`,
 * `slicedLibraryFileId`, `queueItemId`, `archiveId`) are the standing
 * example now: they are sync plumbing, not this API's business — `status`
 * and `errorMessage` are what a caller needs.
 */
/**
 * `tipJar` is the tip jar's switch (src/lib/settings.ts). Off, `tip` goes out
 * as `""`, the same as a ticket that offered nothing: the field keeps its type,
 * and the stored value is not lost, just not shown.
 */
export function storyResource(story: StoryRow, { tipJar }: { tipJar: boolean }) {
  return {
    id: story.id,
    ref: storyRef(story.id),
    title: story.title,
    status: story.status,
    flagged: story.flagged,
    flagReason: story.flagReason,
    quantity: story.quantity,
    neededBy: story.neededBy?.toISOString() ?? null,
    model: {
      url: story.modelUrl,
      resolvedTitle: story.resolvedTitle,
    },
    material: story.material,
    color: { name: story.colorName, hex: story.colorHex },
    tip: tipJar ? story.tip : "",
    note: story.note,
    errorMessage: story.errorMessage,
    uploader: {
      id: story.uploader.id,
      name: story.uploader.name,
      initials: story.uploader.initials,
    },
    commentCount: story._count.comments,
    createdAt: story.createdAt.toISOString(),
    updatedAt: story.updatedAt.toISOString(),
  };
}

/**
 * `storyResource` bound to the tip jar's current switch, read once — so a
 * list of a hundred tickets is one settings query, not a hundred.
 */
export async function storySerializer() {
  const { tipJarEnabled } = await getSettings();
  return (story: StoryRow) => storyResource(story, { tipJar: tipJarEnabled });
}

export function commentResource(comment: CommentRow) {
  return {
    id: comment.id,
    storyId: comment.storyId,
    ref: storyRef(comment.storyId),
    body: comment.body,
    author: {
      id: comment.author.id,
      name: comment.author.name,
      initials: comment.author.initials,
      role: comment.author.role,
    },
    createdAt: comment.createdAt.toISOString(),
  };
}

export type NotificationRow = Prisma.NotificationGetPayload<{
  select: { id: true; storyId: true; text: true; read: true; createdAt: true };
}>;

export function notificationResource(n: NotificationRow) {
  return {
    id: n.id,
    storyId: n.storyId,
    // Null when the story it referred to has been withdrawn — the notification
    // survives the ticket, so the reference has to be allowed to go missing.
    ref: n.storyId === null ? null : storyRef(n.storyId),
    text: n.text,
    read: n.read,
    createdAt: n.createdAt.toISOString(),
  };
}
