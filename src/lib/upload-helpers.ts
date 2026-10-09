/**
 * Pure helpers for the upload form, kept free of any import that would drag
 * in a server action (and with it `server-only`) just to reach two string
 * functions. See scripts/verify-lib.ts.
 */

/** "Bracket v2 (snap fit).stl" -> "Bracket v2 (snap fit)" for the title. */
export function titleFromFilename(name: string): string {
  return name.replace(/(\.gcode)?\.(stl|3mf)$/i, "").replace(/[_]+/g, " ").trim().slice(0, 120);
}

/** Bambuddy's `rgba` comes back as e.g. "EBF1E0FF" — no leading `#`. */
export function swatchColor(rgba: string | null): string {
  return rgba ? `#${rgba.replace(/^#/, "")}` : "#b6bcc2";
}
