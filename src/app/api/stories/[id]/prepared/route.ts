import { ok, storySerializer, withActor } from "@/lib/api";
import { StoryProblem, attachPreparedFile, getStory, storyIdOr400 } from "@/lib/stories";

/**
 * Attach the file prepared in Bambu Studio to a ticket in "Needs prep":
 * `multipart/form-data` with a `file` — a sliced `.gcode.3mf` (queued as it
 * is) or a project `.3mf` (sliced). Answers with the ticket as it stands
 * after, which is `Ready`, `Slicing`, or still `Prep` with an `errorMessage`
 * if Bambuddy couldn't take it.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withActor<{ id: string }>(
  async (request, actor, { id }) => {
    const storyId = storyIdOr400(id);
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      throw new StoryProblem(400, "That upload didn't arrive whole — try again.");
    }
    const file = form.get("file");
    if (!(file instanceof File)) throw new StoryProblem(400, "file: attach the prepared .3mf.");

    await attachPreparedFile(actor, storyId, { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) });
    const toResource = await storySerializer();
    return ok({ story: toResource(await getStory(actor, storyId)) });
  },
  { admin: true },
);
