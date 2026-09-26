"use server";

import { redirect } from "next/navigation";

import { requireAdmin, requireUser } from "@/lib/authz";
import {
  CreateStorySchema,
  StoryProblem,
  clearFlag as clear,
  createStoryFromLink as create,
  declineStory as decline,
  flagStory as flag,
  requeueStory as requeue,
  storyIdOr400,
  withdrawStory as withdraw,
} from "@/lib/stories";

/**
 * The printer owner's panel, as plain forms.
 *
 * What each of these *does* lives in `src/lib/stories.ts`, which the JSON API
 * calls too — the rules about who may move a ticket, from which state, who
 * gets told and what goes in the trail are enforced there so both front doors
 * cannot drift apart. This file is the adapter: read a `FormData`, call the
 * operation, turn the outcome into a redirect.
 *
 * `requireAdmin()` still runs first, and is not redundant with the role check
 * inside the service. It is the one that answers 404 rather than 403, which is
 * what a page owes a client poking at a control that was never drawn for
 * them — the API answers differently, and deliberately. See `src/lib/api.ts`.
 */

/**
 * Where to send the browser afterwards, with a message.
 *
 * These are plain forms, so there is no client state to hand a result back
 * to — the outcome travels in the query string and the page renders it as a
 * toast. That also means the whole panel works with JavaScript off.
 *
 * `from` arrives in the form body, so it is validated like any other
 * redirect target: same-origin absolute paths only. An open redirect is how
 * a phishing page borrows your domain's credibility.
 */
function back(from: FormDataEntryValue | null, params: Record<string, string>): never {
  const raw = typeof from === "string" ? from : "";
  const safe = raw.startsWith("/") && !raw.startsWith("//") ? raw.split("?")[0]! : "/queue";
  const q = new URLSearchParams(params).toString();
  redirect(`${safe}?${q}`);
}

/**
 * Run one operation and land the browser somewhere sensible either way.
 *
 * A `StoryProblem` is the expected shape of "no": it already carries a
 * sentence written for a person, so it goes straight into the toast. Anything
 * else is a bug and is left to throw — an error page is the honest answer to
 * something we did not anticipate, and swallowing it into a toast would make
 * the failure quiet, which is exactly what this repo tries not to do.
 */
async function run(
  formData: FormData,
  operation: (id: number) => Promise<{ toast: string }>,
): Promise<never> {
  try {
    const id = storyIdOr400(formData.get("id") ?? formData.get("storyId"));
    const { toast } = await operation(id);
    back(formData.get("from"), { toast });
  } catch (error) {
    if (error instanceof StoryProblem) back(formData.get("from"), { error: error.message });
    throw error;
  }
}

/**
 * File a new request from the intake form. A link, not a file — see
 * `createStoryFromLink` for why the form only ever sends a `spoolId`, never
 * a colour name or hex directly.
 *
 * Lands on the new ticket, `?sent=1`, so the requester watches the one they
 * just filed rather than being dropped back on the board to go find it.
 * Validation failures and refusals both return to `/upload` with the
 * message in the query string, same as every other action here.
 */
export async function createStory(formData: FormData): Promise<void> {
  const user = await requireUser("/upload");

  const neededByRaw = formData.get("neededBy");
  const parsed = CreateStorySchema.safeParse({
    title: formData.get("title"),
    modelUrl: formData.get("modelUrl"),
    spoolId: formData.get("spoolId"),
    quantity: formData.get("quantity"),
    note: formData.get("note") ?? undefined,
    neededBy: typeof neededByRaw === "string" && neededByRaw ? neededByRaw : undefined,
    tip: formData.get("tip") || undefined,
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    redirect(`/upload?error=${encodeURIComponent(issue?.message ?? "Check the form.")}`);
  }

  try {
    const created = await create(user, parsed.data);
    redirect(`/story/${created.id}?sent=1`);
  } catch (error) {
    if (error instanceof StoryProblem) {
      redirect(`/upload?error=${encodeURIComponent(error.message)}`);
    }
    throw error;
  }
}

export async function declineStory(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  await run(formData, async (id) => {
    const done = await decline(admin, id);
    return { toast: `Declined · ${done.uploaderName} notified` };
  });
}

export async function flagStory(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  await run(formData, async (id) => {
    const done = await flag(admin, id, formData.get("reason") ?? "");
    return { toast: `Flagged · ${done.uploaderName} notified` };
  });
}

export async function clearFlag(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  await run(formData, async (id) => {
    const done = await clear(admin, id);
    return { toast: `Flag cleared · ${done.uploaderName} notified` };
  });
}

/**
 * The requester takes their own back. The only action here that is not the
 * printer owner's, which is why it takes `requireUser` — the ownership check
 * itself is the service's, and applies to the API call just the same.
 *
 * It lands on the board rather than `from`: the ticket it came from no longer
 * exists, and redirecting to a page that is now a 404 is a poor way to say
 * "that worked".
 */
export async function withdrawStory(formData: FormData): Promise<void> {
  const user = await requireUser();
  const id = storyIdOr400(formData.get("storyId"));
  try {
    const done = await withdraw(user, id);
    back("/board", { toast: `${done.ref} withdrawn.` });
  } catch (error) {
    if (error instanceof StoryProblem) back(`/story/${id}`, { toast: error.message });
    throw error;
  }
}

/**
 * Re-queue a past request as a fresh one (FRR-102). Lands on the NEW ticket,
 * which is what the requester wants to watch now — the old one is history.
 */
export async function requeueStory(formData: FormData): Promise<void> {
  const user = await requireUser();
  const id = storyIdOr400(formData.get("storyId"));
  try {
    const done = await requeue(user, id);
    back(`/story/${done.id}`, { toast: `Re-queued ${done.fromRef} as ${done.ref}` });
  } catch (error) {
    if (error instanceof StoryProblem) back(`/story/${id}`, { toast: error.message });
    throw error;
  }
}
