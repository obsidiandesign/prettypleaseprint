/**
 * Choices a request is made from that Bambuddy's own live state doesn't
 * already answer — material and colour used to live here as a fixed list,
 * but the intake form reads those from `listSpools()` (src/lib/bambuddy.ts)
 * now, since "what's actually in stock" is the whole point. Tips are
 * owner-managed data (src/lib/benefits.ts), seeded by prisma/seed.ts.
 */
import { z } from "zod";

/** Shortcut quantities. A typed number is accepted too — see `QuantitySchema`. */
export const QUANTITY_PRESETS = [1, 2, 3, 4, 6] as const;

export const QuantitySchema = z.coerce
  .number()
  .int("Whole prints only.")
  .min(1, "At least one.")
  // Validated server-side, so the message cannot name the admin (this module
  // is shared with the client bundle). The upload form says who to ask.
  .max(24, "More than 24 is a production run — ask the printer owner first.");

/** "4 prints" / "1 print" */
export const quantityText = (n: number) => `${n} ${n === 1 ? "print" : "prints"}`;

/** Relative time, the way every card in the handoff shows it. */
export function relativeTime(date: Date): string {
  const diff = date.getTime() - Date.now();
  const abs = Math.abs(diff);
  if (abs < 45_000) return "just now";
  const units: [number, Intl.RelativeTimeFormatUnit][] = [
    [86_400_000 * 365, "year"],
    [86_400_000 * 30, "month"],
    [86_400_000 * 7, "week"],
    [86_400_000, "day"],
    [3_600_000, "hour"],
    [60_000, "minute"],
  ];
  const fmt = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  for (const [ms, unit] of units) {
    if (abs >= ms) return fmt.format(Math.round(diff / ms), unit);
  }
  return "just now";
}

// ---------------------------------------------------------------------------
// Feature requests — the 'frr' track
//
// The fixed choices a feature request is made from, exactly like the print
// catalogue above: the form renders from these and the server validates
// against them, so the two cannot drift.
// ---------------------------------------------------------------------------

export const FEATURE_PRIORITIES = ["low", "medium", "high"] as const;
export const DEFAULT_FEATURE_PRIORITY = "medium";

export const FEATURE_CATEGORIES = ["ui", "api", "bug", "other"] as const;
export const DEFAULT_FEATURE_CATEGORY = "other";

/** How each priority reads and colours, loudest first. */
export const PRIORITY_CHIP: Record<string, { bg: string; label: string }> = {
  high: { bg: "bg-cherry", label: "High" },
  medium: { bg: "bg-sun", label: "Medium" },
  low: { bg: "bg-chrome", label: "Low" },
};

/** Human labels for the category enum. */
export const CATEGORY_LABEL: Record<string, string> = {
  ui: "UI",
  api: "API",
  bug: "Bug",
  other: "Other",
};

const priorityValues = FEATURE_PRIORITIES as unknown as [string, ...string[]];
const categoryValues = FEATURE_CATEGORIES as unknown as [string, ...string[]];

export const FeatureWishSchema = z.object({
  title: z
    .string()
    .trim()
    .min(3, "Give it a title — a few words is plenty.")
    .max(120, "Keep the title under 120 characters."),
  description: z
    .string()
    .trim()
    .min(1, "Say what you are hoping for.")
    .max(4000, "That description is very long."),
  priority: z.enum(priorityValues),
  category: z.enum(categoryValues),
});

export type FeatureWish = z.infer<typeof FeatureWishSchema>;
