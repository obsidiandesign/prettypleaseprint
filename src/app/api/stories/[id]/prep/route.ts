import { ok, storySerializer, withActor } from "@/lib/api";
import { getStory, sendToPrep, storyIdOr400 } from "@/lib/stories";

/**
 * Send a ticket to "Needs prep" — the printer owner prepares the model in
 * Bambu Studio and attaches the result (`POST …/prepared`). From Requested,
 * Slicing or Failed; the rules are `sendToPrep`'s.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withActor<{ id: string }>(
  async (_request, actor, { id }) => {
    const storyId = storyIdOr400(id);
    await sendToPrep(actor, storyId);
    const toResource = await storySerializer();
    return ok({ story: toResource(await getStory(actor, storyId)) });
  },
  { admin: true },
);
