/**
 * Pure-function checks — no database, no Bambuddy, no server. Every
 * function here is either explicitly documented as pure (scope.ts,
 * model-files.ts) or has no dependency that would stop it being called
 * directly, so the alternative to a check like this is finding out about a
 * broken branch from a user instead.
 *
 *   npm run verify:lib
 *
 * Deliberately NOT exhaustive over every input — the point is pinning the
 * branches that have already mattered once (the Declined/Failed split that
 * shipped wrong, the filament count that crashed the slicer, the spool
 * dedup just added) rather than a combinatorial sweep.
 */
import { makeCheck, section } from "./_check";
import {
  assertDecline,
  assertFeatureTransition,
  AuthzError,
  deriveStatus,
  filamentColoursFor,
  filamentCountFor,
  isFeatureTerminal,
  isTerminal,
  nextFeatureStatus,
  queueOutcome,
  type Actor,
} from "../src/lib/scope";
import { dedupeSpools, type Spool } from "../src/lib/bambuddy-pure";
import {
  ALWAYS_ON,
  MATERIALS,
  listLabels,
  materialByKey,
  materialOf,
  ticketMaterial,
  type Material,
} from "../src/lib/materials";
import { quantityText, relativeTime } from "../src/lib/catalog";
import { checkModelFile, safeModelFilename } from "../src/lib/model-files";
import { isHttpUrl, isMakerWorldModelUrl } from "../src/lib/url-rules";
import { swatchColor, titleFromFilename } from "../src/lib/upload-helpers";

const { check, summary } = makeCheck();

const admin: Actor = { id: "a", name: "Ruben", email: "r@x.test", initials: "RH", role: "admin" };
const client: Actor = { id: "c", name: "Ayla", email: "a@x.test", initials: "AY", role: "client" };

function throws(fn: () => void): boolean {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

// ---------------------------------------------------------------------------
section("materialOf — which recipe a spool's free-text material belongs to");
const keyOf = (m: string | null | undefined) => materialOf(m)?.key ?? null;
check("a Basic PLA spool is PLA", keyOf("PLA Basic") === "PLA");
check("case doesn't matter", keyOf("pla matte") === "PLA" && keyOf("petg hf") === "PETG");
check("the PLA finishes people actually stock are all PLA",
      ["PLA Matte", "PLA Silk", "PLA Tough", "PLA Translucent", "PLA+"].every((m) => keyOf(m) === "PLA"));
check("plain PETG and its common variants are PETG",
      ["PETG", "PETG HF", "PETG Translucent", "Bambu PETG Basic"].every((m) => keyOf(m) === "PETG"));
check("PLA-CF still counts as PLA (the pre-materials behaviour, kept on purpose)", keyOf("PLA-CF") === "PLA");
check("fibre-filled PETG is NOT PETG, however it is spelled — it needs a hardened nozzle",
      ["PETG-CF", "PETG CF", "PETG-CF10", "PETGCF", "PETG-GF", "PETG Carbon", "PETG Glass Fibre", "petg-cf"]
        .every((m) => keyOf(m) === null),
      JSON.stringify(["PETG-CF", "PETGCF", "PETG-CF10"].map(keyOf)));
check("a material we don't slice matches nothing", keyOf("TPU 95A") === null && keyOf("ABS") === null);
check("nothing recorded matches nothing", keyOf("") === null && keyOf(null) === null && keyOf(undefined) === null);

// ---------------------------------------------------------------------------
section("ticketMaterial — what a ticket is sliced for");
check("a ticket from before materials (none recorded) is PLA, as every one was",
      ticketMaterial(null)?.key === "PLA" && ticketMaterial("")?.key === "PLA");
check("a recorded PETG ticket is PETG", ticketMaterial("PETG HF")?.key === "PETG");
check("a recorded material we don't slice is undefined — never guessed to be PLA",
      ticketMaterial("TPU 95A") === undefined && ticketMaterial("PETG-CF") === undefined);

// ---------------------------------------------------------------------------
section("the material registry");
check("keys are unique", new Set(MATERIALS.map((m) => m.key)).size === MATERIALS.length);
check("each material has its own pipeline env var",
      new Set(MATERIALS.map((m) => m.pipelineEnv)).size === MATERIALS.length);
check("PLA is first — the order form lists materials in this order and preselects the first",
      MATERIALS[0]?.key === "PLA");
check("the always-on material is PLA and is in the registry", ALWAYS_ON === "PLA" && materialByKey(ALWAYS_ON) !== undefined);
check("PLA keeps the original BAMBUDDY_PIPELINE_ID variable, so existing installs don't change",
      materialByKey("PLA")?.pipelineEnv === "BAMBUDDY_PIPELINE_ID");
check("an unknown key is not a material", materialByKey("UNOBTAINIUM") === undefined);
check("no material claims another's spools",
      ["PLA Basic", "PETG HF", "PETG", "PLA Matte"].every(
        (name) => MATERIALS.filter((m) => m.matches(name)).length === 1,
      ));

const named = (label: string): Material => ({ key: label, label, pipelineEnv: label, matches: () => false });
check("listLabels reads naturally for one, two and three",
      listLabels([]) === "" &&
        listLabels([named("PLA")]) === "PLA" &&
        listLabels([named("PLA"), named("PETG")]) === "PLA or PETG" &&
        listLabels([named("PLA"), named("PETG"), named("TPU")]) === "PLA, PETG or TPU");

// ---------------------------------------------------------------------------
section("dedupeSpools — one swatch per colour+finish, not per reel");
const shelf: Spool[] = [
  { id: 1, material: "PLA Basic", color_name: "Jade White", rgba: "EBF1E0FF", archived_at: null },
  { id: 2, material: "PLA Basic", color_name: "Jade White", rgba: "EBF1E0FF", archived_at: null },
  { id: 3, material: "PLA Matte", color_name: "Jade White", rgba: "EBF1E0FF", archived_at: null },
  { id: 4, material: "PLA Basic", color_name: "Charcoal", rgba: "2B2B2BFF", archived_at: null },
];
const grouped = dedupeSpools(shelf);
check("three distinct colour+finish combos collapse three reels into three groups",
      grouped.length === 3, `got ${grouped.length}`);
const jadeBasic = grouped.find((g) => g.color_name === "Jade White" && g.material === "PLA Basic");
check("the duplicate reels land in one group", jadeBasic?.memberIds.length === 2, JSON.stringify(jadeBasic));
check("a different finish of the same colour stays its own group",
      grouped.some((g) => g.material === "PLA Matte" && g.memberIds.length === 1));
check("a representative id is one of its own members",
      jadeBasic !== undefined && jadeBasic.memberIds.includes(jadeBasic.id));
const nullish = dedupeSpools([
  { id: 9, material: "PLA Basic", color_name: null, rgba: null, archived_at: null },
  { id: 10, material: "PLA Basic", color_name: null, rgba: null, archived_at: null },
]);
check("null colour/rgba still groups consistently rather than throwing", nullish.length === 1);
// The actual bug report: two reels that read as the same colour to a
// person didn't dedupe because the strings didn't match byte-for-byte —
// a spool added by hand next to one the AMS auto-detected, say.
const messy = dedupeSpools([
  { id: 20, material: "PLA Basic", color_name: "Jade White", rgba: "ebf1e0ff", archived_at: null },
  { id: 21, material: " pla basic ", color_name: " Jade White ", rgba: "EBF1E0FF", archived_at: null },
]);
check("mismatched case and stray whitespace still collapse to one group — THE repeat-filament bug",
      messy.length === 1 && messy[0]?.memberIds.length === 2, JSON.stringify(messy));
check("the picker lists colours alphabetically, not in whatever order Bambuddy returned them",
      grouped.map((g) => g.color_name).join(",") === "Charcoal,Jade White,Jade White",
      grouped.map((g) => g.color_name).join(","));
check("and within one colour, by finish",
      grouped.filter((g) => g.color_name === "Jade White").map((g) => g.material).join(",") === "PLA Basic,PLA Matte");

// ---------------------------------------------------------------------------
section("filamentCountFor — the slicer crash's root cause");
check("an unsliced project (0 known slots) falls back to the template's count",
      filamentCountFor(0, 4) === 4);
check("a project with its own slot count wins over a larger fallback",
      filamentCountFor(3, 4) === 3);
check("single-colour (1 slot) wins even over a larger fallback",
      filamentCountFor(1, 4) === 1);

// ---------------------------------------------------------------------------
section("filamentColoursFor — a second colour silently copying the first");
// THE bug report: slot ids aren't guaranteed contiguous from 1 (a
// single-colour model's only slot has been seen numbered 3) — treating
// position i as slot id i+1 read the wrong slot for every colour after
// the first whenever the real ids skipped a number, and Bambuddy's slicer
// filled the resulting blank with slot 1's own colour instead of leaving
// it unset.
const nonContiguousSlots = [
  { slot_id: 1, color: "#0000FF" }, // the designer's blue, main
  { slot_id: 3, color: "#FFFFFF" }, // the designer's white, secondary — note: not slot 2
];
const bluePick = [{ slotId: 1, colorHex: "#2244CC", designColor: null }];
check("with no pick for the secondary slot, its own designer colour is used — not slot 1's",
      filamentColoursFor(2, nonContiguousSlots, bluePick).join(",") === "#2244CC,#FFFFFF",
      filamentColoursFor(2, nonContiguousSlots, bluePick).join(","));

const bothPicked = [
  { slotId: 1, colorHex: "#2244CC", designColor: null },
  { slotId: 3, colorHex: "#EEEEEE", designColor: null },
];
check("and once the requester picks the secondary colour too, that wins outright",
      filamentColoursFor(2, nonContiguousSlots, bothPicked).join(",") === "#2244CC,#EEEEEE");

check("contiguous slot ids (the common case) still work the same as before",
      filamentColoursFor(
        2,
        [{ slot_id: 1, color: "#0000FF" }, { slot_id: 2, color: "#FFFFFF" }],
        [{ slotId: 1, colorHex: "#2244CC", designColor: null }, { slotId: 2, colorHex: "#EEEEEE", designColor: null }],
      ).join(",") === "#2244CC,#EEEEEE");

check("a slot Bambuddy never reported at all gets Bambuddy's own default, not a thrown error",
      filamentColoursFor(3, nonContiguousSlots, bothPicked).join(",") === "#2244CC,#EEEEEE,",
      filamentColoursFor(3, nonContiguousSlots, bothPicked).join(","));

// ---------------------------------------------------------------------------
section("queueOutcome — the Declined/Failed split that shipped wrong once");
const zero = { pending: 0, printing: 0, completed: 0, failed: 0, cancelled: 0, skipped: 0 };
check("every entry removed from Bambuddy's queue reads as Declined, not Failed",
      queueOutcome(zero).status === "Declined");
check("some printing is Printing even with others pending",
      queueOutcome({ ...zero, printing: 1, pending: 2 }).status === "Printing");
check("pending and completed together still reads Printing (more is coming)",
      queueOutcome({ ...zero, pending: 1, completed: 1 }).status === "Printing");
check("pending alone is Ready", queueOutcome({ ...zero, pending: 2 }).status === "Ready");
check("all completed, nothing else, is Done with no note",
      queueOutcome({ ...zero, completed: 2 }).status === "Done" &&
      queueOutcome({ ...zero, completed: 2 }).note === null);
check("some completed and some cancelled is still Done, but notes the shortfall",
      queueOutcome({ ...zero, completed: 1, cancelled: 1 }).status === "Done" &&
      queueOutcome({ ...zero, completed: 1, cancelled: 1 }).note?.includes("1 of 2") === true);
// The actual regression: every entry cancelled by the owner, none ever
// failed outright — this must be Declined, the same as declining by hand.
check("all cancelled, nothing failed, is Declined — THE regression this pins",
      queueOutcome({ ...zero, cancelled: 3 }).status === "Declined",
      JSON.stringify(queueOutcome({ ...zero, cancelled: 3 })));
check("a single cancelled entry's note is singular",
      queueOutcome({ ...zero, cancelled: 1 }).note === "Cancelled in Bambuddy by the printer owner.");
check("a real failure in the mix is Failed, not Declined",
      queueOutcome({ ...zero, failed: 1, cancelled: 1 }).status === "Failed");

// ---------------------------------------------------------------------------
section("deriveStatus — legacy pipeline-run path");
check("a pending queue item is Ready", deriveStatus({ queueItemStatus: "pending" }) === "Ready");
check("a cancelled queue item is Declined, not Failed",
      deriveStatus({ queueItemStatus: "cancelled" }) === "Declined");
check("a skipped queue item is Declined too",
      deriveStatus({ queueItemStatus: "skipped" }) === "Declined");
check("a failed queue item is Failed", deriveStatus({ queueItemStatus: "failed" }) === "Failed");
check("queue item status wins over pipeline run status when both are present",
      deriveStatus({ queueItemStatus: "pending", pipelineRunStatus: "failed" }) === "Ready");
check("a cancelled pipeline run (no queue item yet) is Declined",
      deriveStatus({ pipelineRunStatus: "cancelled" }) === "Declined");
check("an in-progress run reads as Slicing", deriveStatus({ pipelineRunStatus: "in_progress" }) === "Slicing");
check("neither piece of state present is Requested", deriveStatus({}) === "Requested");
check("Done/Failed/Declined are terminal", isTerminal("Done") && isTerminal("Failed") && isTerminal("Declined"));
check("Slicing and Ready are not", !isTerminal("Slicing") && !isTerminal("Ready"));

// ---------------------------------------------------------------------------
section("assertDecline — admin-only, and only before Bambuddy has state");
check("an admin may decline a fresh request", !throws(() => assertDecline(admin, "Requested")));
check("an admin may decline from Prep (nothing queued yet)", !throws(() => assertDecline(admin, "Prep")));
check("an admin may NOT decline once it's Printing", throws(() => assertDecline(admin, "Printing")));
check("a client may never decline, whatever the status", throws(() => assertDecline(client, "Requested")));
check("the refusal is an AuthzError", (() => {
  try { assertDecline(client, "Requested"); return false; } catch (e) { return e instanceof AuthzError; }
})());

// ---------------------------------------------------------------------------
section("the feature-request flow ('frr')");
check("Requested steps to Accepted", nextFeatureStatus("Requested") === "Accepted");
check("Done has no next step", nextFeatureStatus("Done") === null);
check("Done is terminal, same as a print", isFeatureTerminal("Done"));
check("Declined is terminal even off the flow array", isFeatureTerminal("Declined"));
check("InProgress is not terminal", !isFeatureTerminal("InProgress"));
check("the owner may step one stage forward", !throws(() => assertFeatureTransition(admin, "Requested", "Accepted")));
check("the owner may decline only from Requested",
      !throws(() => assertFeatureTransition(admin, "Requested", "Declined")) &&
      throws(() => assertFeatureTransition(admin, "Accepted", "Declined")));
check("the owner may not skip a stage", throws(() => assertFeatureTransition(admin, "Accepted", "Shipped")));
check("a requester can't move their own request", throws(() => assertFeatureTransition(client, "Requested", "Accepted")));

// ---------------------------------------------------------------------------
section("catalog — display text");
check('one print reads "1 print", singular', quantityText(1) === "1 print");
check('anything else is plural, including zero', quantityText(4) === "4 prints" && quantityText(0) === "0 prints");
check('"just now" for something seconds old',
      relativeTime(new Date(Date.now() - 1000)) === "just now");
check("a couple of hours ago reads in hours, not minutes",
      /hours? ago/.test(relativeTime(new Date(Date.now() - 2 * 3_600_000))));
check("a couple of hours from now reads \"in ... hours\"",
      /^in \d+ hours?$/.test(relativeTime(new Date(Date.now() + 2 * 3_600_000))));

// ---------------------------------------------------------------------------
section("link validation — what a ticket is allowed to hyperlink to");
check("an https URL is fine", isHttpUrl("https://makerworld.com/en/models/123"));
check("an http URL is fine too", isHttpUrl("http://example.test/x"));
check("javascript: is refused", !isHttpUrl("javascript:alert(1)"));
check("a bare string with no scheme is refused", !isHttpUrl("not a url"));
check("a MakerWorld model page is recognised",
      isMakerWorldModelUrl("https://makerworld.com/en/models/123456-a-name"));
check("MakerWorld's .cn domain counts too",
      isMakerWorldModelUrl("https://makerworld.com.cn/en/models/123456"));
check("MakerWorld's own homepage (no /models/N) does not",
      !isMakerWorldModelUrl("https://makerworld.com/en"));
check("a lookalike host is refused",
      !isMakerWorldModelUrl("https://makerworld.com.evil.test/en/models/123"));

// ---------------------------------------------------------------------------
section("upload — filename and swatch helpers");
check('strips the extension and underscores for a title',
      titleFromFilename("Bracket_v2_(snap_fit).STL") === "Bracket v2 (snap fit)");
check("a pre-sliced .gcode.3mf loses both suffixes",
      titleFromFilename("plate_1.gcode.3mf") === "plate 1");
check("an overlong name is capped at 120 characters",
      titleFromFilename(`${"x".repeat(200)}.stl`).length === 120);
check('Bambuddy\'s bare hex gets a leading "#"', swatchColor("EBF1E0FF") === "#EBF1E0FF");
check("a hex that already has one isn't doubled", swatchColor("#EBF1E0FF") === "#EBF1E0FF");
check("no colour at all falls back to the neutral grey", swatchColor(null) === "#b6bcc2");

// ---------------------------------------------------------------------------
section("checkModelFile — refusing early, against the bytes, not the name");
check("an empty file is refused", !checkModelFile("x.stl", Buffer.alloc(0), { sliced: false }).ok);
check("a file over the 100 MB limit is refused",
      !checkModelFile("x.stl", Buffer.allocUnsafe(100 * 1024 * 1024 + 1), { sliced: false }).ok);

const binaryStl = (() => {
  const triangles = 2;
  const buf = Buffer.allocUnsafe(84 + 50 * triangles);
  buf.writeUInt32LE(triangles, 80);
  return buf;
})();
check("a well-formed binary STL is recognised by its triangle math, not its header text",
      checkModelFile("part.stl", binaryStl, { sliced: false }).ok === true);

const asciiStl = Buffer.from("solid part\nfacet normal 0 0 0\nendfacet\nendsolid part\n", "latin1");
check("an ASCII STL is recognised too", checkModelFile("part.stl", asciiStl, { sliced: false }).ok === true);

const notAnStl = Buffer.from("this is just some text, not a model", "latin1");
check("text that merely has an .stl name is refused",
      checkModelFile("fake.stl", notAnStl, { sliced: false }).ok === false);

const zip3mf = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("not really a project but has the zip magic")]);
check("a project 3MF (zip magic, no sliced plates) is accepted",
      checkModelFile("model.3mf", zip3mf, { sliced: false }).ok === true);

const slicedZip3mf = Buffer.concat([
  Buffer.from([0x50, 0x4b, 0x03, 0x04]),
  Buffer.from("Metadata/plate_1.gcode more bytes after it"),
]);
check("an already-sliced 3MF is refused from a requester's upload (slicer can't re-slice it)",
      checkModelFile("model.3mf", slicedZip3mf, { sliced: false }).ok === false);
check("but accepted from the owner's prepared-file flow, which allows it",
      checkModelFile("model.3mf", slicedZip3mf, { sliced: true }).ok === true);

const notA3mf = Buffer.from("PK is not actually here", "latin1");
check("a .3mf without the zip magic is refused, whatever its name claims",
      checkModelFile("model.3mf", notA3mf, { sliced: false }).ok === false);

check("an unrecognised extension is refused with a kind-specific message",
      checkModelFile("model.png", zip3mf, { sliced: false }).ok === false);

check("path separators are stripped to a base filename",
      safeModelFilename("../../etc/passwd.stl") === "passwd.stl");
check("hostile characters in a filename are sanitised, not rejected outright",
      safeModelFilename('weird<>:"|?*name.stl').startsWith("weird"));
check("an overlong filename's stem is capped, extension kept",
      safeModelFilename(`${"x".repeat(300)}.stl`).endsWith(".stl") &&
      safeModelFilename(`${"x".repeat(300)}.stl`).length <= 104);

process.exitCode = summary();
