/**
 * The filament materials a request can be sliced for.
 *
 * Colour picks a spool, and a spool has a material, so the material of a
 * ticket is whatever its main spool is. Each material is sliced from its own
 * Bambuddy Slicer Pipeline (printer, process, filament preset and bed type),
 * because the slicer's settings differ per filament: PETG wants other
 * temperatures, speeds and often another plate than PLA.
 *
 * To offer another material (TPU, ABS...), add a row here and set the
 * environment variable it names; the owner then switches it on at
 * /admin/materials. Nothing else needs to know the list.
 *
 * Pure on purpose (no database, no environment): the pickers, the server-side
 * checks and the slicer all agree on it through these functions.
 */

export type Material = {
  /** Stored in `app_settings.enabledMaterials`; never rename a shipped one. */
  key: string;
  label: string;
  /** The env var holding this material's Slicer Pipeline id. */
  pipelineEnv: string;
  /** Matches Bambuddy's free-text spool material ("PETG HF", "PLA Basic"). */
  matches: (spoolMaterial: string) => boolean;
  /** What the owner should know before switching it on. */
  note?: string;
};

export const MATERIALS: readonly Material[] = [
  {
    key: "PLA",
    label: "PLA",
    pipelineEnv: "BAMBUDDY_PIPELINE_ID",
    matches: (m) => m.toUpperCase().includes("PLA"),
  },
  {
    key: "PETG",
    label: "PETG",
    pipelineEnv: "BAMBUDDY_PIPELINE_PETG",
    // Fibre-filled PETG needs a hardened nozzle and its own profile: not this one.
    matches: (m) => /PETG/i.test(m) && !/CF|GF|CARBON|GLASS|FIBRE|FIBER/i.test(m),
    note: "Make a Slicer Pipeline in Bambuddy with your PETG process, filament preset and bed type, and set BAMBUDDY_PIPELINE_PETG to its id.",
  },
];

/** PLA is the baseline every install has: always offered, never switched off. */
export const ALWAYS_ON = "PLA";

export function materialByKey(key: string): Material | undefined {
  return MATERIALS.find((m) => m.key === key);
}

/** Which material a spool's free-text material is, or null for one we don't slice. */
export function materialOf(spoolMaterial: string | null | undefined): Material | null {
  if (!spoolMaterial) return null;
  return MATERIALS.find((m) => m.matches(spoolMaterial)) ?? null;
}

/**
 * The material a ticket is sliced for, from its main spool's material.
 * Tickets from before materials may have none recorded: those were all PLA.
 * One that records a material we don't slice is `undefined`, never guessed at.
 */
export function ticketMaterial(spoolMaterial: string | null | undefined): Material | undefined {
  if (!spoolMaterial) return materialByKey(ALWAYS_ON);
  return materialOf(spoolMaterial) ?? undefined;
}

/** "PLA", "PLA or PETG", "PLA, PETG or TPU" — for a sentence. */
export function listLabels(materials: readonly Material[]): string {
  const labels = materials.map((m) => m.label);
  if (labels.length <= 1) return labels[0] ?? "";
  return `${labels.slice(0, -1).join(", ")} or ${labels[labels.length - 1]}`;
}
