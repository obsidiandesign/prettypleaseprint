import Link from "next/link";
import { notFound } from "next/navigation";

import { getStoryOr404, printerName, requireUser, storyRef, BOARD } from "@/lib/authz";
import { quantityText, relativeTime } from "@/lib/catalog";
import { isHttpUrl } from "@/lib/stories";
import { AppHeader } from "@/components/app-header";
import { Fact, Notice, StatusChip } from "@/components/ui";
import { AdminActions } from "@/components/admin-actions";
import { Conversation } from "@/components/conversation";
import { Toast } from "@/components/toast";
import { WithdrawStory } from "@/components/withdraw-story";
import { RequeueStory } from "@/components/requeue-story";

export const dynamic = "force-dynamic";

/** The happy path, in display order — `Failed`/`Declined` are branches off it, not steps on it. */
const HAPPY_PATH = [...BOARD, "Done"] as const;

/**
 * Story detail — the read half. Handoff §4.
 *
 * There's no model to view or download any more — the link is the model.
 * What's here instead: the link itself, what Bambuddy resolved it to,
 * the wish, and where it sits in a flow this app no longer drives by hand.
 */
export default async function StoryPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ sent?: string; toast?: string; error?: string }>;
}) {
  const [{ id }, { sent, toast, error }] = await Promise.all([params, searchParams]);
  const storyId = Number(id);
  if (!Number.isInteger(storyId)) notFound();

  const user = await requireUser(`/story/${id}`);
  // 404s rather than 403s for a client asking after someone else's story —
  // a 403 would confirm it exists.
  const story = await getStoryOr404(storyId, user);
  const owner = await printerName();

  const currentIndex = (HAPPY_PATH as readonly string[]).indexOf(story.status);
  const branchedOff = story.status === "Declined" || story.status === "Failed";
  const swatch = story.colorHex ? `#${story.colorHex.replace(/^#/, "")}` : "#b6bcc2";

  return (
    <>
      <AppHeader user={user} active="/board" />

      <main className="mx-auto w-full max-w-[1180px] px-[26.4px] pb-[80px] pt-[35.2px]">
        <Link
          href="/board"
          className="inline-block font-mono text-[12px] font-bold uppercase tracking-[0.08em] text-ink-2 underline underline-offset-4 hover:text-cherry-dk"
        >
          ← Back to the rail
        </Link>

        <div className="mt-[13.2px] grid grid-cols-[repeat(auto-fit,minmax(330px,1fr))] items-start gap-[26.4px]">
          {/* ---------- left: the model and the conversation ---------- */}
          <div>
            <div className="overflow-hidden rounded-panel border-[3px] border-ink bg-porcelain shadow-stamp">
              <div className="layers border-b-[3px] border-ink bg-aqua-wash px-[17.6px] py-[11px]">
                <p className="m-0 font-mono text-[11px] font-bold uppercase tracking-[0.1em] text-ink">
                  The model
                </p>
              </div>
              <div className="p-[17.6px]">
                {/* Validated at intake too; checked again here so a row that
                    predates the check can never become a clickable javascript: link. */}
                {isHttpUrl(story.modelUrl) ? (
                  <a
                    href={story.modelUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block break-all font-mono text-[13px] text-ink underline underline-offset-4 hover:text-cherry-dk"
                  >
                    {story.resolvedTitle ?? story.modelUrl}
                  </a>
                ) : (
                  <p className="m-0 break-all font-mono text-[13px] text-ink-3">
                    {story.modelUrl || "No model link — this request predates link intake."}
                  </p>
                )}
                {story.resolvedTitle && isHttpUrl(story.modelUrl) && (
                  <p className="m-0 mt-[6px] break-all font-mono text-[11px] text-ink-3">
                    {story.modelUrl}
                  </p>
                )}
                {story.plateCount !== null && (
                  <p className="m-0 mt-[8px] font-mono text-[11px] uppercase tracking-[0.05em] text-ink-3">
                    {story.plateCount} {story.plateCount === 1 ? "plate" : "plates"}
                  </p>
                )}
              </div>
            </div>

            <Conversation
              storyId={story.id}
              comments={story.comments}
              viewerRole={user.role}
              ownerName={owner}
            />
          </div>

          {/* ---------- right: the wish and the flow ---------- */}
          <div>
            <div className="mb-[8.8px] flex flex-wrap items-center gap-[8.8px]">
              <span className="rounded-chip border-2 border-ink bg-porcelain px-[11px] py-[3px] font-mono text-[12px] font-bold tracking-[0.06em] text-ink">
                {storyRef(story.id)}
              </span>
              <StatusChip status={story.status} />
              {story.flagged && (
                <span className="rounded-chip border-2 border-ink bg-cherry px-[11px] py-[3px] font-mono text-[11.5px] font-bold uppercase tracking-[0.06em] text-ink">
                  flagged{story.flagReason ? `: ${story.flagReason}` : ""}
                </span>
              )}
            </div>

            <h1 className="m-0 mb-[13.2px] text-[36px] leading-[1.02] text-ink">
              {story.title}
            </h1>
            {story.note && (
              <p className="m-0 mb-[22px] text-[16px] leading-[1.55] text-ink-2 text-pretty">
                {story.note}
              </p>
            )}

            {/* Bambuddy's own explanation — a real failure, or just a Ready
                ticket it flagged with a waiting_reason (see bambuddy-sync.ts).
                Shown as-is, since it's written for a person already. */}
            {story.errorMessage && (
              <div className="mb-[22px]">
                <Notice tone="warn">{story.errorMessage}</Notice>
              </div>
            )}

            <div className="rounded-panel border-[3px] border-ink bg-porcelain p-[22px] shadow-stamp">
              <div className="grid grid-cols-[repeat(auto-fit,minmax(120px,1fr))] gap-[17.6px]">
                <Fact label="Asked by">{story.uploader.name}</Fact>
                <Fact label="Quantity">{quantityText(story.quantity)}</Fact>
                <Fact label="Material">{story.material ?? "—"}</Fact>
                <Fact label="Colour">
                  <span className="flex items-center gap-[8.8px]">
                    <span
                      aria-hidden
                      className="h-[18px] w-[18px] rounded-full border-2 border-ink"
                      style={{ background: swatch }}
                    />
                    {story.colorName}
                  </span>
                </Fact>
                {story.neededBy && (
                  <Fact label="Needed by">
                    {story.neededBy.toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                  </Fact>
                )}
              </div>
            </div>

            <section className="mt-[26.4px]">
              <h2 className="m-0 mb-[13.2px] font-display text-[22px] text-ink">
                Where it&rsquo;s at
              </h2>
              {branchedOff ? (
                <p className="m-0 rounded-card border-[3px] border-ink bg-cream-3 px-[17.6px] py-[13.2px] text-[15px] text-ink-2">
                  {story.status === "Declined"
                    ? `This one was declined ${relativeTime(story.updatedAt)}.`
                    : `This one didn't make it — updated ${relativeTime(story.updatedAt)}.`}
                </p>
              ) : (
                <ol className="m-0 flex list-none flex-col p-0">
                  {HAPPY_PATH.map((step, i) => {
                    const done = currentIndex >= 0 && i < currentIndex;
                    const now = i === currentIndex;
                    return (
                      <li key={step} className="flex items-start gap-[13.2px]">
                        <div className="flex flex-none flex-col items-center">
                          <span
                            aria-hidden
                            className={`h-[20px] w-[20px] rounded-full border-[3px] border-ink ${
                              done ? "bg-mint" : now ? "bg-sun" : "bg-cream-3"
                            }`}
                          />
                          {i < HAPPY_PATH.length - 1 && (
                            <span
                              aria-hidden
                              className={`w-[4px] flex-1 ${done ? "bg-mint" : "bg-cream-3"}`}
                              style={{ minHeight: "26px" }}
                            />
                          )}
                        </div>
                        <div className="pb-[17.6px]">
                          <div
                            className={`font-display text-[17px] ${
                              done || now ? "text-ink" : "text-ink-3"
                            }`}
                          >
                            {step}
                          </div>
                          <div className="mt-[3px] font-mono text-[11px] font-bold uppercase tracking-[0.08em] text-ink-3">
                            {now ? "now" : done ? "cleared" : "waiting"}
                          </div>
                        </div>
                      </li>
                    );
                  })}
                </ol>
              )}
            </section>

            {/*
              The requester's own controls. Deliberately not gated on role —
              an admin looking at somebody else's ticket is not its owner, and
              the action refuses on ownership rather than on role.
            */}
            {story.uploader.id === user.id &&
              (story.status === "Requested" || story.status === "Declined") && (
                <WithdrawStory
                  storyId={story.id}
                  label={storyRef(story.id)}
                  from={`/story/${story.id}`}
                />
              )}

            {/*
              Print again — the requester's, on any of their own tickets. Like
              withdraw, gated on ownership rather than role; the action re-checks.
            */}
            {story.uploader.id === user.id && (
              <RequeueStory
                storyId={story.id}
                label={storyRef(story.id)}
                from={`/story/${story.id}`}
              />
            )}

            {/*
              The printer owner's controls. Rendered only for the admin, and
              the actions behind them check the role again — drawing a button
              is not authorisation. Shown regardless of status: flagging has
              no status restriction, and `AdminActions` itself handles what a
              declined ticket offers (nothing further) versus a failed one
              (still flaggable, just never declinable — see assertDecline).
            */}
            {user.role === "admin" && (
              <section className="mt-[26.4px] rounded-panel border-[3px] border-ink bg-aqua-wash p-[22px] shadow-stamp">
                <h2 className="m-0 mb-[13.2px] font-display text-[20px] text-ink">
                  Owner&rsquo;s controls
                </h2>
                {error && (
                  <div className="mb-[13.2px]">
                    <Notice tone="warn">{error}</Notice>
                  </div>
                )}
                <AdminActions
                  storyId={story.id}
                  status={story.status}
                  flagged={story.flagged}
                  flagReason={story.flagReason}
                  from={`/story/${story.id}`}
                />
              </section>
            )}
          </div>
        </div>
      </main>

      {sent && <Toast>Order in · {owner} has been notified</Toast>}
      {toast && <Toast>{toast}</Toast>}
    </>
  );
}
