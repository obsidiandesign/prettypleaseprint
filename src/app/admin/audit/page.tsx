import Link from "next/link";
import type { ReactNode } from "react";
import type { Prisma } from "@prisma/client";

import { db } from "@/lib/db";
import { requireAdmin } from "@/lib/authz";
import { relativeTime } from "@/lib/catalog";
import { AppHeader } from "@/components/app-header";
import { AuditDashboard } from "@/components/audit-dashboard";
import { REFUSAL_ACTIONS, mix, refusals, stages } from "@/lib/dashboard";
import { Kicker } from "@/components/ui";

export const dynamic = "force-dynamic";

/**
 * The audit log, and the three panels above it. Admin only.
 *
 * Deliberately a page a human reads rather than an alerting pipeline: for one
 * printer and a handful of colleagues, a screen the owner can glance at beats
 * thresholds nobody tunes and alerts everyone learns to ignore. The rows are
 * already there if that changes — recording is the part that cannot be
 * backfilled.
 *
 * That argument only holds if somebody actually looks, and a wall of rows is
 * not something anybody opens twice. The panels are the answer: refusals,
 * where work is sitting, and what gets asked for — the three questions a person
 * arrives with, none of which a log can answer by being scrolled. They are pure
 * aggregation over rows that already existed (`src/lib/dashboard.ts`); nothing
 * new is recorded for them.
 */

type Lens = "all" | "access" | "uploads";

const LENSES: Array<{ key: Lens; label: string; actions?: string[] }> = [
  { key: "all", label: "Everything" },
  {
    key: "access",
    label: "Who got in",
    actions: [
      "invite.sent", "invite.resent", "invite.revoked", "invite.accepted",
      "invite.rejected", "auth.signed_in", "auth.signed_out", "user.role_changed",
    ],
  },
  {
    key: "uploads",
    label: "Models",
    actions: [
      "story.created", "upload.rejected", "story.status_changed",
      "story.declined", "story.flagged", "file.downloaded",
    ],
  },
];

/**
 * Within "Models", the three moments of a ticket's life people ask about:
 * when it arrived, when it went on the printer, and when it came off.
 * `story.status_changed` records the stage it moved `to`, so the printing and
 * done steps are a filter on that field rather than verbs of their own.
 */
type Step = "created" | "printing" | "done";

const STEPS: Array<{ key: Step; label: string; where: Prisma.AuditEventWhereInput }> = [
  { key: "created", label: "Created", where: { action: "story.created" } },
  {
    key: "printing",
    label: "Printing",
    where: { action: "story.status_changed", detail: { path: ["to"], equals: "Printing" } },
  },
  {
    key: "done",
    label: "Done",
    where: { action: "story.status_changed", detail: { path: ["to"], equals: "Done" } },
  },
];

/** Rows per page. The log only grows, so the page has to stop somewhere. */
const PAGE_SIZE = 50;

/** One URL per view, so a page can be linked to and the back button works. */
function auditHref(lens: Lens, step: Step | undefined, page: number): string {
  const q = new URLSearchParams();
  if (lens !== "all") q.set("lens", lens);
  if (step) q.set("step", step);
  if (page > 1) q.set("page", String(page));
  const qs = q.toString();
  return qs ? `/admin/audit?${qs}` : "/admin/audit";
}

/**
 * Refusals are the rows worth noticing — a run of them from one place is the
 * shape of somebody trying things. Everything else is normal traffic.
 *
 * The list lives in `dashboard.ts` so the count at the top, the tint in the
 * table and the panel cannot disagree. It gained `file.refused`, which had been
 * missing here: that verb fires when an account asks for a model it may not
 * see, which is the refusal most worth noticing and was the one not counted.
 */
const REFUSALS = new Set<string>(REFUSAL_ACTIONS);

function tone(action: string): string {
  if (REFUSALS.has(action)) return "bg-cherry text-ink";
  if (action.startsWith("auth.")) return "bg-aqua-wash text-ink";
  if (action.startsWith("invite.")) return "bg-mint-wash text-ink";
  return "bg-cream-2 text-ink-2";
}

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<{ lens?: string; step?: string; page?: string }>;
}) {
  const admin = await requireAdmin();
  const { lens: raw, step: rawStep, page: rawPage } = await searchParams;
  const lens = (LENSES.find((l) => l.key === raw)?.key ?? "all") as Lens;
  const actions = LENSES.find((l) => l.key === lens)?.actions;
  // Steps only exist inside "Models"; a stray `step` on another lens is ignored.
  const step = lens === "uploads" ? STEPS.find((s) => s.key === rawStep) : undefined;

  const where: Prisma.AuditEventWhereInput =
    step?.where ?? (actions ? { action: { in: actions } } : {});

  const total = await db.auditEvent.count({ where });
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  // Anything unparseable is page 1; past the end is the last page.
  const page = Math.min(pages, Math.max(1, Number.parseInt(rawPage ?? "", 10) || 1));
  const first = (page - 1) * PAGE_SIZE;

  const [events, refusalsToday, refusalPanel, stagePanel, mixPanel] = await Promise.all([
    db.auditEvent.findMany({
      where,
      // `id` breaks ties, so rows sharing a timestamp don't swap between pages.
      orderBy: [{ at: "desc" }, { id: "desc" }],
      skip: first,
      take: PAGE_SIZE,
    }),
    db.auditEvent.count({
      where: {
        action: { in: [...REFUSALS] },
        at: { gt: new Date(Date.now() - 86_400_000) },
      },
    }),
    refusals(),
    stages(),
    mix(),
  ]);

  return (
    <>
      <AppHeader user={admin} active="/admin/audit" />

      <main className="mx-auto w-full max-w-[1180px] px-[26.4px] pb-[80px] pt-[35.2px]">
        <Kicker>Admin · the record</Kicker>
        <h1 className="m-0 mb-[13.2px] text-[46px] leading-[0.98] text-ink">
          Audit log
        </h1>
        <p className="m-0 mb-[26.4px] max-w-[620px] text-[16.5px] leading-[1.5] text-ink-2 text-pretty">
          Every action that changes who can get in, or what happens to
          someone&rsquo;s model. Nothing here is ever edited or removed.
          {refusalsToday > 0 && (
            <>
              {" "}
              <strong className="font-bold text-cherry-dk">
                {refusalsToday} refusal{refusalsToday === 1 ? "" : "s"} in the
                last day
              </strong>{" "}
              — worth a look if that is more than you expect.
            </>
          )}
        </p>

        <AuditDashboard refusals={refusalPanel} stages={stagePanel} mix={mixPanel} />

        <nav className="mb-[17.6px] flex flex-wrap gap-[4.4px]">
          {LENSES.map((l) => (
            <Link
              key={l.key}
              href={auditHref(l.key, undefined, 1)}
              aria-current={l.key === lens ? "page" : undefined}
              className={`stamp cursor-pointer rounded-chip border-[3px] border-ink px-[15px] py-[6px] font-mono text-[12px] font-bold uppercase tracking-[0.06em] ${
                l.key === lens ? "bg-cherry-dk text-cream" : "bg-porcelain text-ink hover:bg-sun"
              }`}
            >
              {l.label}
            </Link>
          ))}
        </nav>

        {lens === "uploads" && (
          <nav aria-label="Models" className="mb-[17.6px] flex flex-wrap gap-[4.4px]">
            {[{ key: undefined, label: "All models" }, ...STEPS].map((s) => (
              <Link
                key={s.key ?? "all"}
                href={auditHref("uploads", s.key, 1)}
                aria-current={s.key === step?.key ? "page" : undefined}
                className={`cursor-pointer rounded-chip border-2 border-ink px-[12px] py-[4px] font-mono text-[11px] font-bold uppercase tracking-[0.06em] ${
                  s.key === step?.key ? "bg-ink text-cream" : "bg-porcelain text-ink hover:bg-sun"
                }`}
              >
                {s.label}
              </Link>
            ))}
          </nav>
        )}

        <div className="overflow-x-auto rounded-panel border-[3px] border-ink bg-porcelain shadow-stamp">
          <table className="w-full min-w-[46rem] border-collapse">
            <thead>
              <tr className="border-b-[3px] border-ink bg-cream-2">
                {["When", "Action", "Who", "What", "From"].map((h) => (
                  <th
                    key={h}
                    className="px-[17.6px] py-[11px] text-left font-mono text-[11px] font-bold uppercase tracking-[0.08em] text-ink"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {events.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-[17.6px] py-[22px] font-mono text-[12px] uppercase text-ink-3">
                    Nothing recorded yet.
                  </td>
                </tr>
              )}
              {events.map((e) => (
                <tr key={e.id} className="border-b-2 border-dashed border-rule last:border-b-0">
                  <td className="whitespace-nowrap px-[17.6px] py-[11px] align-top font-mono text-[12px] tabular-nums text-ink-3">
                    <time dateTime={e.at.toISOString()} title={e.at.toISOString()}>
                      {relativeTime(e.at)}
                    </time>
                  </td>
                  <td className="whitespace-nowrap px-[17.6px] py-[11px] align-top">
                    <span
                      className={`rounded-chip border-2 border-ink px-[9px] py-[2px] font-mono text-[11px] font-bold ${tone(e.action)}`}
                    >
                      {e.action}
                    </span>
                  </td>
                  <td className="px-[17.6px] py-[11px] align-top text-[13.5px]">
                    {e.actorEmail ?? <span className="text-ink-3">—</span>}
                  </td>
                  <td className="px-[17.6px] py-[11px] align-top text-[13.5px]">
                    <span className="font-mono text-[12.5px]">{e.subject ?? "—"}</span>
                    {e.detail != null && (
                      <Detail detail={e.detail as Record<string, unknown>} />
                    )}
                  </td>
                  <td className="px-[17.6px] py-[11px] align-top font-mono text-[12px] text-ink-3">
                    {e.ip ?? "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="mt-[13.2px] flex flex-wrap items-center justify-between gap-[13.2px]">
          <p className="m-0 font-mono text-[11.5px] uppercase text-ink-3">
            {total === 0
              ? "No rows."
              : `Showing ${first + 1}–${first + events.length} of ${total}, newest first.`}
          </p>
          {pages > 1 && (
            <nav aria-label="Pages" className="flex items-center gap-[8.8px]">
              <PageLink href={page > 1 ? auditHref(lens, step?.key, page - 1) : null} rel="prev">
                ← Newer
              </PageLink>
              <span className="font-mono text-[11.5px] uppercase text-ink-3">
                Page {page} of {pages}
              </span>
              <PageLink href={page < pages ? auditHref(lens, step?.key, page + 1) : null} rel="next">
                Older →
              </PageLink>
            </nav>
          )}
        </div>
      </main>
    </>
  );
}

/** A pager button, or a dimmed label at either end. */
function PageLink({
  href,
  rel,
  children,
}: {
  href: string | null;
  rel: "prev" | "next";
  children: ReactNode;
}) {
  const base =
    "rounded-chip border-2 border-ink px-[12px] py-[4px] font-mono text-[11px] font-bold uppercase tracking-[0.06em]";
  if (!href) {
    return <span aria-disabled="true" className={`${base} bg-cream-2 text-ink-3 opacity-60`}>{children}</span>;
  }
  return (
    <Link href={href} rel={rel} className={`${base} cursor-pointer bg-porcelain text-ink hover:bg-sun`}>
      {children}
    </Link>
  );
}

/** The few fields worth showing inline; the rest stay in the database. */
function Detail({ detail }: { detail: Record<string, unknown> }) {
  // `error` is the one that matters most when something's wrong: an intake
  // failure's real cause, which the ticket itself only summarises.
  const interesting = ["title", "reason", "error", "bambuddy", "from", "to", "role"];
  const shown = interesting
    .filter((k) => detail[k] != null)
    .map((k) => `${k}: ${String(detail[k])}`);
  if (shown.length === 0) return null;
  return (
    <span className="mt-[3px] block text-[12.5px] text-ink-3">
      {shown.join(" · ")}
    </span>
  );
}
