/**
 * The parts of the Bambuddy inventory model with no fetch, no `server-only`
 * — pulled out of bambuddy.ts so they can be exercised directly in a test
 * (the real `server-only` package refuses to load outside Next's own
 * bundler; see scripts/verify-lib.ts).
 */

export type Spool = {
  id: number;
  material: string;
  color_name: string | null;
  rgba: string | null;
  archived_at: string | null;
};

/**
 * Only PLA can be requested — the one Slicer Pipeline (see `pipelineId` in
 * bambuddy.ts) is a fixed standard-PLA recipe, so any other material would
 * slice cleanly and print wrong. The intake form filters its picker with
 * this, and `createStoryFromLink` enforces it server-side.
 */
export function isPla(material: string): boolean {
  return material.toUpperCase().includes("PLA");
}

export type SpoolGroup = Spool & { memberIds: number[] };

/**
 * Collapsing key for "the same colour and finish" — trimmed and
 * case-folded, because Bambuddy doesn't guarantee two reels of what's
 * plainly the same filament agree on casing or stray whitespace (a spool
 * added by hand next to one the AMS auto-detected is the common way this
 * happens). Matching the raw strings exactly left duplicates on the shelf
 * that looked identical to a person but didn't dedupe.
 */
function groupKey(spool: Spool): string {
  const fold = (s: string) => s.trim().toLowerCase();
  return `${fold(spool.color_name ?? "")}|${fold(spool.rgba ?? "")}|${fold(spool.material)}`;
}

/**
 * Collapses physical spools that are the same colour and finish (e.g. three
 * reels of "Jade White PLA Basic") into one entry, so the picker shows one
 * swatch per distinct colour+finish instead of one per reel. The first spool
 * seen in each group stands in as the representative; `memberIds` records
 * every id it covers, so code that cares whether a *previously chosen* spool
 * is still on the shelf can check the group rather than just the
 * representative.
 *
 * Returned alphabetically by colour name (then finish, for two finishes of
 * the same colour) — the picker's order used to follow whatever order
 * Bambuddy's inventory API happened to return, which reads as arbitrary
 * once there's more than a handful of spools on the shelf.
 */
export function dedupeSpools(spools: Spool[]): SpoolGroup[] {
  const groups = new Map<string, SpoolGroup>();
  for (const spool of spools) {
    const key = groupKey(spool);
    const existing = groups.get(key);
    if (existing) {
      existing.memberIds.push(spool.id);
    } else {
      groups.set(key, { ...spool, memberIds: [spool.id] });
    }
  }
  return [...groups.values()].sort((a, b) =>
    (a.color_name ?? "").localeCompare(b.color_name ?? "", undefined, { sensitivity: "base" }) ||
    a.material.localeCompare(b.material, undefined, { sensitivity: "base" }),
  );
}
