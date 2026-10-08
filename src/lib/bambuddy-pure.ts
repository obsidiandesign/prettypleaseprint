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
 * Collapses physical spools that are the same colour and finish (e.g. three
 * reels of "Jade White PLA Basic") into one entry, so the picker shows one
 * swatch per distinct colour+finish instead of one per reel. The first spool
 * seen in each group stands in as the representative; `memberIds` records
 * every id it covers, so code that cares whether a *previously chosen* spool
 * is still on the shelf can check the group rather than just the
 * representative.
 */
export function dedupeSpools(spools: Spool[]): SpoolGroup[] {
  const groups = new Map<string, SpoolGroup>();
  for (const spool of spools) {
    const key = `${spool.color_name ?? ""} ${spool.rgba ?? ""} ${spool.material}`;
    const existing = groups.get(key);
    if (existing) {
      existing.memberIds.push(spool.id);
    } else {
      groups.set(key, { ...spool, memberIds: [spool.id] });
    }
  }
  return [...groups.values()];
}
