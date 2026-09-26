import Link from "next/link";

import { db } from "@/lib/db";
import { printerName, requireUser, storyScope } from "@/lib/authz";
import { getSettings } from "@/lib/settings";
import { storyRef } from "@/lib/scope";
import { relativeTime } from "@/lib/catalog";
import { AppHeader } from "@/components/app-header";
import { Kicker, StatusChip } from "@/components/ui";

import type { StoryStatus } from "@prisma/client";

export const dynamic = "force-dynamic";

/** What counts as printed: it came off the plate. Named rather than repeated as a literal, so a status added later is one edit, not a grep. */
const PRINTED: StoryStatus[] = ["Done"];


/**
 * The profile. Handoff §6.
 *
 * Everything on this page is scoped by the same rule as the board: a client
 * counts and lists only their own tickets, the printer owner sees the group.
 * The handoff calls this out explicitly, and it is the easiest place to leak
 * — a stat is still a fact about someone else's data.
 *
 * This is also where declined tickets finally surface. They are deliberately
 * off the rail, which left them reachable only by URL; the whole history
 * belongs here, including the parts that did not happen.
 */

type Card = { value: string; label: string; skin: string };

export default async function ProfilePage() {
  const user = await requireUser("/me");
  const [owner, { tipJarEnabled }] = await Promise.all([printerName(), getSettings()]);
  const isAdmin = user.role === "admin";
  const scope = storyScope(user);

  const [stories, finished, beers, favourite, ready, needsAttention] = await Promise.all([
    db.story.findMany({
      where: scope,
      orderBy: { createdAt: "desc" },
      include: { uploader: { select: { name: true, initials: true } } },
    }),
    db.story.count({ where: { AND: [scope, { status: { in: PRINTED } }] } }),
    // A beer is owed once the work is actually done — not when it is asked for.
    db.story.count({
      where: { AND: [scope, { tip: "A beer" }, { status: { in: PRINTED } }] },
    }),
    db.story.groupBy({
      by: ["material"],
      where: scope,
      _count: { material: true },
      orderBy: { _count: { material: "desc" } },
      take: 1,
    }),
    db.story.count({ where: { AND: [scope, { status: "Ready" }] } }),
    db.story.count({ where: { AND: [scope, { errorMessage: { not: null } }] } }),
  ]);

  const inHand = stories.filter((s) => s.status === "Done").length;
  const usual = favourite[0]?.material ?? "—";

  // The beer count belongs to the tip jar, and goes when it is switched off.
  const beerCard = (label: string, skin: string): Card[] =>
    tipJarEnabled ? [{ value: String(beers), label, skin }] : [];

  const cards: Card[] = isAdmin
    ? [
        { value: String(finished), label: "Printed for the group", skin: "bg-aqua" },
        { value: String(ready), label: "Ready to print", skin: "bg-mint-wash" },
        { value: String(needsAttention), label: "Need a look", skin: "bg-cherry-wash" },
        ...beerCard("Beers owed to you", "bg-mint"),
      ]
    : [
        { value: String(stories.length), label: "Requests made", skin: "bg-aqua" },
        { value: String(inHand), label: "In your hands", skin: "bg-mint" },
        ...beerCard(`Beers owed to ${owner}`, "bg-sun"),
        { value: usual, label: "Your usual material", skin: "bg-cream-2" },
      ];

  return (
    <>
      <AppHeader user={user} active="/me" />

      <main className="mx-auto w-full max-w-[1180px] px-[26.4px] pb-[80px] pt-[35.2px]">
        <div className="mb-[35.2px] flex flex-wrap items-center gap-[22px]">
          <span
            aria-hidden
            className="flex h-[92px] w-[92px] flex-none items-center justify-center rounded-full border-[3px] border-ink bg-aqua font-mono text-[30px] font-bold text-ink shadow-stamp-lg"
          >
            {user.initials}
          </span>
          <div>
            <Kicker>{isAdmin ? "Behind the counter" : "At the counter"}</Kicker>
            <h1 className="m-0 mb-[6px] text-[38px] leading-[1] text-ink">
              {user.name}
            </h1>
            <p className="m-0 text-[15.5px] text-ink-2">
              {isAdmin
                ? "Owns the printer, sees every ticket"
                : `Invited by ${owner} · sees only their own tickets`}
            </p>
          </div>
        </div>

        <div className="mb-[35.2px] grid grid-cols-[repeat(auto-fit,minmax(190px,1fr))] gap-[13.2px]">
          {cards.map((c) => (
            <div
              key={c.label}
              className={`rounded-panel border-[3px] border-ink ${c.skin} p-[17.6px] shadow-stamp`}
            >
              <p className="m-0 font-display text-[36px] leading-[1] text-ink">
                {c.value}
              </p>
              <p className="m-0 mt-[8px] font-mono text-[11.5px] font-bold uppercase tracking-[0.06em] text-ink">
                {c.label}
              </p>
            </div>
          ))}
        </div>

        <h2 className="m-0 mb-[13.2px] font-display text-[26px] text-ink">
          {isAdmin ? "Everything the group has sent you" : "Your orders"}
        </h2>

        <div className="overflow-hidden rounded-panel border-[3px] border-ink bg-porcelain shadow-stamp">
          {stories.length === 0 ? (
            <p className="m-0 p-[22px] font-mono text-[12px] uppercase tracking-[0.06em] text-ink-3">
              {isAdmin ? "Nobody has sent you anything yet." : "No orders yet."}
            </p>
          ) : (
            stories.map((story, i) => (
              <div
                key={story.id}
                className={`flex flex-wrap items-center gap-[15px] p-[15px] ${
                  i < stories.length - 1 ? "border-b-2 border-dashed border-rule" : ""
                } ${story.status === "Declined" ? "bg-cream-2" : ""}`}
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
                    {storyRef(story.id)}
                    {isAdmin ? ` · ${story.uploader.name}` : ""} ·{" "}
                    {relativeTime(story.createdAt)}
                  </p>
                </div>
                <StatusChip status={story.status} />
                {(story.flagged || story.errorMessage) && (
                  <span className="rounded-chip border-2 border-ink bg-cherry px-[9px] py-[2px] font-mono text-[10.5px] font-bold uppercase text-ink">
                    needs a look
                  </span>
                )}
              </div>
            ))
          )}
        </div>

        <p className="m-0 mt-[13.2px] font-mono text-[11px] uppercase tracking-[0.05em] text-ink-3">
          Declined orders are listed here too — the rail only carries what is
          still moving.
        </p>
      </main>
    </>
  );
}
