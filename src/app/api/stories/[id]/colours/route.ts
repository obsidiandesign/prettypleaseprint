import { jsonBody, ok, storySerializer, withActor } from "@/lib/api";
import { getStory, setStoryColours, storyIdOr400 } from "@/lib/stories";

/**
 * Choose a multi-colour model's colours: `{"slots": [{"slotId": 3,
 * "spoolId": 12}, {"slotId": 5, "spoolId": null}]}`. `null` is "printer's
 * choice". Slots left out stay as they are.
 *
 * The requester's, or the printer owner's, until the print starts. Spools are
 * checked against live inventory and must be the ticket's own material. The rules are `setStoryColours`'s, shared with the ticket page.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const PUT = withActor<{ id: string }>(async (request, actor, { id }) => {
  const storyId = storyIdOr400(id);
  const body = await jsonBody(request);
  await setStoryColours(actor, storyId, body);
  const toResource = await storySerializer();
  return ok({ story: toResource(await getStory(actor, storyId)) });
});
