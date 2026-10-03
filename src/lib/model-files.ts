/**
 * What an uploaded model file is, checked against its bytes.
 *
 * A file is only ever passed through to Bambuddy's library — this app keeps
 * no copy — so the check here is about refusing early and saying why, not
 * about parsing geometry: Bambuddy and its slicer do that. Still against the
 * bytes rather than trusting the name, so a renamed PDF is refused here
 * rather than failing obscurely in the slicer.
 *
 * Pure (no `server-only`, no I/O) so it can be tested directly.
 */

/** The largest upload accepted. One is held in memory while it's passed on. */
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

/**
 * What a file is, which decides what intake does with it:
 *   "stl"        geometry only — waits for the printer owner to prepare it
 *   "3mf"        a project — sliced, with its own (designer's) settings
 *   "gcode.3mf"  already sliced — queued exactly as it is
 */
export type ModelKind = "stl" | "3mf" | "gcode.3mf";

export type ModelFileCheck = { ok: true; kind: ModelKind; filename: string } | { ok: false; reason: string };

const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const PLATE_PREFIX = Buffer.from("Metadata/plate_", "latin1");

/** Whether a 3MF carries sliced G-code (`Metadata/plate_N.gcode`). */
function hasSlicedPlates(bytes: Buffer): boolean {
  let at = bytes.indexOf(PLATE_PREFIX);
  while (at !== -1) {
    const tail = bytes.subarray(at + PLATE_PREFIX.length, at + PLATE_PREFIX.length + 12).toString("latin1");
    if (/^\d+\.gcode/.test(tail)) return true;
    at = bytes.indexOf(PLATE_PREFIX, at + 1);
  }
  return false;
}

function isStl(bytes: Buffer): boolean {
  // Binary: an 80-byte header, a triangle count, then exactly 50 bytes per
  // triangle. Checked first, because a binary header may itself begin "solid".
  if (bytes.length >= 84) {
    const triangles = bytes.readUInt32LE(80);
    if (triangles > 0 && bytes.length === 84 + 50 * triangles) return true;
  }
  // ASCII: "solid …" with facets.
  const head = bytes.subarray(0, 4096).toString("latin1").trimStart().toLowerCase();
  return head.startsWith("solid") && head.includes("facet");
}

/**
 * A filename safe to pass on and show: the base name only, ordinary
 * characters, sensibly short, keeping its extension.
 */
export function safeModelFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const lower = base.toLowerCase();
  const ext = lower.endsWith(".gcode.3mf") ? ".gcode.3mf" : lower.endsWith(".3mf") ? ".3mf" : lower.endsWith(".stl") ? ".stl" : "";
  const stem = base
    .slice(0, base.length - ext.length)
    .replace(/[^\w .()+-]+/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
  return `${stem || "model"}${ext}`;
}

/**
 * Check an upload. `sliced` says whether an already-sliced `.gcode.3mf` is
 * acceptable: the printer owner may attach one after preparing a model; a
 * requester's upload is sliced here, and Bambuddy's slicer can't read one.
 */
export function checkModelFile(name: string, bytes: Buffer, { sliced }: { sliced: boolean }): ModelFileCheck {
  if (bytes.length === 0) return { ok: false, reason: "That file is empty." };
  if (bytes.length > MAX_UPLOAD_BYTES) {
    return { ok: false, reason: `That file is over the ${MAX_UPLOAD_BYTES / 1024 / 1024} MB limit.` };
  }

  const filename = safeModelFilename(name);
  const lower = filename.toLowerCase();

  if (lower.endsWith(".stl")) {
    return isStl(bytes)
      ? { ok: true, kind: "stl", filename }
      : { ok: false, reason: "That doesn't look like an STL file, whatever its name says." };
  }

  if (lower.endsWith(".3mf")) {
    if (!bytes.subarray(0, 4).equals(ZIP_MAGIC)) {
      return { ok: false, reason: "That doesn't look like a 3MF file, whatever its name says." };
    }
    const isSliced = lower.endsWith(".gcode.3mf") || hasSlicedPlates(bytes);
    if (!isSliced) return { ok: true, kind: "3mf", filename };
    if (!sliced) {
      return {
        ok: false,
        reason: "That 3MF is already sliced — upload the project (or the STL) instead, and it'll be sliced for this printer.",
      };
    }
    return { ok: true, kind: "gcode.3mf", filename: lower.endsWith(".gcode.3mf") ? filename : filename.replace(/\.3mf$/i, ".gcode.3mf") };
  }

  return { ok: false, reason: sliced ? "Attach a .3mf (project or sliced)." : "Upload an .stl or .3mf file." };
}
