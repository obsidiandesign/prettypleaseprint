import Link from "next/link";

import { db } from "@/lib/db";
import { storyRef } from "@/lib/scope";
import { printerName, requireAdmin } from "@/lib/authz";
import { quantityText, relativeTime } from "@/lib/catalog";
import { AppHeader } from "@/components/app-header";
import { AdminActions } from "@/components/admin-actions";
import { Kicker, Notice, StatusChip } from "@/components/ui";
import { Toast } from "@/components/toast";

export const dynamic = "force-dynamic";

/**
 * The pass — the printer owner's home. Handoff §5.
 *
 * There is no more "waiting for a yes": intake resolves, imports and slices
 * on its own (see src/lib/bambuddy-sync.ts), so the only things that still
 * need a person are the ones Bambuddy itself couldn't get past on its
 * own — an `errorMessage` set, whatever the status — and the `Ready` pile,
 * which isn't a problem, just the queue of "go start this in Bambuddy
 * whenever you have time" that the whole app exists to build. Everything
 * else is a list you scan rather than act on.
 *
 * Admin-only: `requireAdmin` answers 404, so a client learns nothing about
 * whether this route exists.
 */
export default async function QueuePage({
  searchParams,
}: {
  searchParams: Promise<{ toast?: string; error?: string }>;
}) {
  const [{ toast, error }, admin] = await Promise.all([searchParams, requireAdmin()]);
  const owner = await printerName();

  const stories = await db.story.findMany({
    orderBy: { createdAt: "asc" },
    include: { uploader: { select: { name: true, initials: true } } },
  });

  const needsAttention = stories.filter(
    (s) => s.errorMessage && s.status !== "Failed" && s.status !== "Declined",
  );
  const ready = stories.filter((s) => s.status === "Ready");
  const rest = stories.filter(
    (s) => !needsAttention.includes(s) && s.status !== "Ready" && s.status !== "Declined",
  );

  return (
    <>
      <AppHeader user={admin} active="/queue" />

      <main className="mx-auto w-full max-w-[1180px] px-[26.4px] pb-[80px] pt-[35.2px]">
        <Kicker>Printer view · the machine by the window</Kicker>
        <h1 className="m-0 mb-[11px] text-[46px] leading-[0.95] text-ink">
          {owner}&rsquo;s queue
        </h1>
        <p className="m-0 mb-[26.4px] text-[16.5px] leading-[1.5] text-ink-2">
          {needsAttention.length
            ? `${needsAttention.length} ${needsAttention.length === 1 ? "ticket needs" : "tickets need"} a look.`
            : ready.length
              ? `${ready.length} sliced and ready whenever you are.`
              : "Nothing waiting. Enjoy the quiet."}
        </p>

        {error && (
          <div className="mb-[22px] max-w-[640px]">
            <Notice tone="warn">{error}</Notice>
          </div>
        )}

        {/* ---- the only part that actually needs a decision ---- */}
        {needsAttention.length > 0 && (
          <section className="mb-[26.4px] overflow-hidden rounded-panel border-[3px] border-ink bg-cherry-wash shadow-stamp-lg">
            <div className="layers border-b-[3px] border-ink px-[22px] py-[11px]">
              <h2 className="m-0 font-display text-[20px] text-ink">Needs a look</h2>
            </div>
            <div className="flex flex-col gap-[13.2px] p-[17.6px]">
              {needsAttention.map((story) => (
                <article
                  key={story.id}
                  className="flex flex-wrap items-start gap-[17.6px] rounded-card border-[3px] border-ink bg-porcelain p-[15px]"
                >
                  <div className="min-w-[220px] flex-[1_1_280px]">
                    <p className="m-0 font-mono text-[11.5px] font-bold tracking-[0.06em] text-ink-3">
                      {storyRef(story.id)} · <StatusChip status={story.status} />
                    </p>
                    <Link
                      href={`/story/${story.id}`}
                      className="mt-[4px] block font-display text-[20px] leading-[1.15] text-ink hover:text-cherry-dk"
                    >
                      {story.title}
                    </Link>
                    <p className="m-0 mt-[6px] text-[14px] text-cherry-dk">{story.errorMessage}</p>
                    <p className="m-0 mt-[4px] font-mono text-[11.5px] uppercase tracking-[0.05em] text-ink-3">
                      {story.uploader.name} · {relativeTime(story.createdAt)}
                    </p>
                  </div>
                  <AdminActions
                    storyId={story.id}
                    status={story.status}
                    flagged={story.flagged}
                    flagReason={story.flagReason}
                    from="/queue"
                    compact
                  />
                </article>
              ))}
            </div>
          </section>
        )}

        {/* ---- sliced and waiting to be started, in Bambuddy itself ---- */}
        {ready.length > 0 && (
          <section className="mb-[26.4px] overflow-hidden rounded-panel border-[3px] border-ink bg-mint-wash shadow-stamp">
            <div className="layers border-b-[3px] border-ink px-[22px] py-[11px]">
              <h2 className="m-0 font-display text-[20px] text-ink">Ready to print</h2>
            </div>
            <div className="flex flex-col gap-[8.8px] p-[17.6px]">
              {ready.map((story) => (
                <div key={story.id} className="flex flex-wrap items-center gap-[13.2px]">
                  <span
                    aria-hidden
                    className="h-[28px] w-[28px] flex-none rounded-full border-[3px] border-ink"
                    style={{ background: story.colorHex ? `#${story.colorHex.replace(/^#/, "")}` : "#b6bcc2" }}
                  />
                  <Link
                    href={`/story/${story.id}`}
                    className="font-display text-[16px] text-ink hover:text-cherry-dk"
                  >
                    {story.title}
                  </Link>
                  <span className="font-mono text-[11.5px] uppercase tracking-[0.05em] text-ink-3">
                    {quantityText(story.quantity)} · {story.material} · {story.uploader.name}
                  </span>
                </div>
              ))}
            </div>
            <p className="m-0 border-t-2 border-dashed border-rule px-[17.6px] py-[8.8px] font-mono text-[11px] uppercase tracking-[0.04em] text-ink-3">
              Start these from Bambuddy itself when you have time — this app doesn&rsquo;t touch the printer.
            </p>
          </section>
        )}

        {/* ---- everything else moving, scan-only ---- */}
        <h2 className="m-0 mb-[13.2px] font-display text-[24px] text-ink">
          Rest of the queue
        </h2>
        <div className="overflow-hidden rounded-panel border-[3px] border-ink bg-porcelain shadow-stamp">
          {rest.length === 0 ? (
            <p className="m-0 p-[22px] font-mono text-[12px] uppercase tracking-[0.06em] text-ink-3">
              Nothing on the go.
            </p>
          ) : (
            rest.map((story, i) => (
              <div
                key={story.id}
                className={`flex flex-wrap items-center gap-[15px] p-[15px] ${
                  i < rest.length - 1 ? "border-b-2 border-dashed border-rule" : ""
                }`}
              >
                <span
                  aria-hidden
                  className="h-[40px] w-[40px] flex-none rounded-full border-[3px] border-ink"
                  style={{ background: story.colorHex ? `#${story.colorHex.replace(/^#/, "")}` : "#b6bcc2" }}
                />
                <div className="min-w-[180px] flex-[1_1_240px]">
                  <Link
                    href={`/story/${story.id}`}
                    className="block font-display text-[17px] leading-[1.2] text-ink hover:text-cherry-dk"
                  >
                    {story.title}
                  </Link>
                  <p className="m-0 mt-[3px] font-mono text-[11px] uppercase tracking-[0.04em] text-ink-3">
                    {story.uploader.name} · {relativeTime(story.createdAt)}
                  </p>
                </div>
                <StatusChip status={story.status} />
                {story.flagged && (
                  <span className="rounded-chip border-2 border-ink bg-cherry px-[9px] py-[2px] font-mono text-[10.5px] font-bold uppercase text-ink">
                    needs a look
                  </span>
                )}
              </div>
            ))
          )}
        </div>
      </main>

      {toast && <Toast>{toast}</Toast>}
    </>
  );
}
