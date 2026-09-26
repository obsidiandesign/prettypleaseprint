import { ok, storySerializer, withActor } from "@/lib/api";
import { declineStory, getStory, storyIdOr400 } from "@/lib/stories";

/**
 * Say no. Terminal, and only reachable from `Requested` — once the request is
 * with Bambuddy, saying no is a conversation (and a cancel in Bambuddy), not a
 * state change here. A decline from anywhere else is 403, carrying the
 * sentence that says why; one mid-handoff is 409.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withActor<{ id: string }>(
  async (_request, actor, { id }) => {
    const storyId = storyIdOr400(id);
    const done = await declineStory(actor, storyId);
    const toResource = await storySerializer();
    return ok({
      story: toResource(await getStory(actor, storyId)),
      moved: { from: done.from, to: done.to },
      notified: done.uploaderName,
    });
  },
  { admin: true },
);
