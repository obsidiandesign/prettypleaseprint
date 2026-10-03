import { z } from "zod";

import { jsonBody, ok, storySerializer, withActor } from "@/lib/api";
import type { Actor } from "@/lib/scope";
import {
  CreateStorySchema,
  CreateUploadSchema,
  LIST_LIMIT_DEFAULT,
  LIST_LIMIT_MAX,
  StatusSchema,
  StoryProblem,
  createStoryFromLink,
  createStoryFromUpload,
  getStory,
  listStories,
} from "@/lib/stories";

/**
 * The tickets this caller may see, newest first.
 *
 * The same set the board and the queue draw from, and scoped by the same
 * `storyScope` fragment: a client sees their own requests, the printer owner
 * sees everything. The filters below can only ever narrow that — there is no
 * combination of query parameters that widens it, because the scope is the
 * first term of the AND and nothing here can reach it.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const QuerySchema = z.object({
  status: z.array(StatusSchema).optional(),
  flagged: z.enum(["true", "false"]).optional(),
  mine: z.enum(["true", "false"]).optional(),
  limit: z.coerce.number().int().min(1).max(LIST_LIMIT_MAX).optional(),
  before: z.coerce.number().int().positive().optional(),
});

export const GET = withActor(async (request, actor) => {
  const url = new URL(request.url);

  // `?status=Requested&status=Printing` and `?status=Requested,Printing` both
  // work. Repeated keys are the OpenAPI convention; the comma form is what
  // people type into a terminal.
  const statuses = url.searchParams
    .getAll("status")
    .flatMap((v) => v.split(","))
    .map((v) => v.trim())
    .filter(Boolean);

  const parsed = QuerySchema.safeParse({
    status: statuses.length ? statuses : undefined,
    flagged: url.searchParams.get("flagged") ?? undefined,
    mine: url.searchParams.get("mine") ?? undefined,
    limit: url.searchParams.get("limit") ?? undefined,
    before: url.searchParams.get("before") ?? undefined,
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new StoryProblem(
      400,
      `${issue?.path.join(".") || "query"}: ${issue?.message ?? "not a valid filter."}`,
    );
  }

  const { stories, nextCursor } = await listStories(actor, {
    status: parsed.data.status,
    flagged: parsed.data.flagged === undefined ? undefined : parsed.data.flagged === "true",
    mine: parsed.data.mine === "true",
    limit: parsed.data.limit ?? LIST_LIMIT_DEFAULT,
    before: parsed.data.before,
  });

  const toResource = await storySerializer();
  return ok({
    stories: stories.map(toResource),
    // Null on the last page. Feed it back as `?before=` for the next one.
    nextCursor,
  });
});

/**
 * File a new request: JSON with a MakerWorld `modelUrl`, or
 * `multipart/form-data` with a `file` (an STL or 3MF, up to 100 MB) and the
 * same fields as form values plus an optional `sourceLink`. See
 * `createStoryFromLink` / `createStoryFromUpload` for why `spoolId` is the
 * only thing that names a color.
 */
export const POST = withActor(async (request, actor) => {
  const created = (request.headers.get("content-type") ?? "").startsWith("multipart/form-data")
    ? await fromUpload(request, actor)
    : await fromLink(request, actor);
  const toResource = await storySerializer();
  return ok({ story: toResource(await getStory(actor, created.id)) }, 201);
});

function invalid(issue: { path: PropertyKey[]; message: string } | undefined): never {
  throw new StoryProblem(400, `${issue?.path.join(".") || "body"}: ${issue?.message ?? "invalid."}`);
}

async function fromLink(request: Request, actor: Actor) {
  const parsed = CreateStorySchema.safeParse(await jsonBody(request));
  if (!parsed.success) invalid(parsed.error.issues[0]);
  return createStoryFromLink(actor, parsed.data);
}

async function fromUpload(request: Request, actor: Actor) {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    throw new StoryProblem(400, "That upload didn't arrive whole — try again.");
  }
  const file = form.get("file");
  if (!(file instanceof File)) throw new StoryProblem(400, "file: attach an .stl or .3mf file.");

  // Form values are strings; empty ones mean "not given".
  const fields = Object.fromEntries(
    [...form.entries()].filter(([k, v]) => k !== "file" && typeof v === "string" && v !== ""),
  );
  const parsed = CreateUploadSchema.safeParse(fields);
  if (!parsed.success) invalid(parsed.error.issues[0]);

  return createStoryFromUpload(actor, parsed.data, {
    name: file.name,
    bytes: new Uint8Array(await file.arrayBuffer()),
  });
}
