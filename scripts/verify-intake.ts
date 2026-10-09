import "./_env";
/**
 * Business logic with a fake Bambuddy standing in for the real one — a
 * real HTTP round trip through src/lib/bambuddy.ts, and a real database
 * row, rather than just the pure functions verify:lib already covers in
 * isolation.
 *
 *   npm run verify:intake
 *
 * Unlike the other suites, this one brings its own `next dev` up rather
 * than expecting one already running: `src/lib/stories.ts` and
 * `src/lib/bambuddy.ts` both start with `import "server-only"`, and the
 * real published `server-only` package throws unconditionally outside
 * Next's own bundler — there is no way to call either file's exports from
 * a plain tsx script. Every existing `verify:*` suite already works around
 * this by driving everything over HTTP instead of importing them; this one
 * does the same; it just can't assume a server is already up, since
 * nothing about it needs Bambuddy pointed anywhere specific. `BAMBUDDY_URL`
 * is only ever read from `next dev`'s own process environment at request
 * time, which is fixed the moment that process is spawned — so the fake
 * Bambuddy has to exist *before* `next dev` starts, not just before this
 * script's checks run.
 *
 * DESTRUCTIVE: wipes users and stories. Development database only.
 */
import { spawn } from "node:child_process";
import { db } from "../src/lib/db";
import { storyRef } from "../src/lib/scope";
import { makeCheck, section } from "./_check";
import { startFakeBambuddy } from "./_fake-bambuddy";
import { ensureCredentials, signInWithPassword, usernameFor } from "./_accounts";

const PORT = Number(process.env.PPP_TEST_PORT ?? 3100);
const APP = `http://127.0.0.1:${PORT}`;
const CRON_SECRET = "verify-intake-cron-secret";

/** Cookie-carried, the same shape every other suite's client uses. */
class Client {
  jar = new Map<string, string>();
  private store(r: Response) {
    for (const line of r.headers.getSetCookie()) {
      const [pair] = line.split(";");
      const i = pair!.indexOf("=");
      const k = pair!.slice(0, i).trim();
      const v = pair!.slice(i + 1).trim();
      if (!v || line.includes("Max-Age=0")) this.jar.delete(k);
      else this.jar.set(k, v);
    }
  }
  async raw(url: string, init: RequestInit = {}): Promise<Response> {
    const headers: Record<string, string> = { origin: APP, ...((init.headers as object) ?? {}) };
    if (this.jar.size) headers.cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ");
    const r = await fetch(url, { ...init, redirect: "manual", headers });
    this.store(r);
    return r;
  }
  async json<T = Record<string, unknown>>(url: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
    const r = await this.raw(url, { ...init, headers: { "content-type": "application/json", ...((init.headers as object) ?? {}) } });
    const text = await r.text();
    let body: unknown = {};
    try { body = text ? JSON.parse(text) : {}; } catch { body = { error: `not JSON: ${text.slice(0, 160)}` }; }
    return { status: r.status, body: body as T };
  }
}

async function signIn(user: { id: string; email: string }): Promise<Client> {
  const c = new Client();
  await db.$executeRawUnsafe('DELETE FROM "rateLimit"');
  await ensureCredentials(APP, user.id, usernameFor(user.email));
  await signInWithPassword(c, APP, usernameFor(user.email));
  return c;
}

async function waitForHealth(timeoutMs = 60_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`${APP}/api/health`);
      if (r.ok) return;
    } catch {
      /* not listening yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error("the app never became healthy");
}

async function main() {
  const fake = await startFakeBambuddy();
  // Every physical spool a check needs; individual checks reconfigure the
  // route to simulate a bad shelf or an unreachable Bambuddy.
  fake.set("GET", "/api/v1/inventory/spools", () => ({
    status: 200,
    body: [{ id: 1, material: "PLA Basic", color_name: "Jade White", rgba: "EBF1E0FF", archived_at: null }],
  }));

  console.info(`  starting next dev on :${PORT} against fake Bambuddy ${fake.url} ...`);
  let bootLog = "";
  // The local binary, not `npx next dev`: npx wraps it in an extra process
  // that doesn't forward SIGTERM to the real `next-server` underneath, so
  // `child.kill()` below would leave it running on the port afterward.
  const child = spawn("./node_modules/.bin/next", ["dev", "-p", String(PORT)], {
    env: {
      ...process.env,
      BAMBUDDY_URL: fake.url,
      BAMBUDDY_API_KEY: fake.apiKey,
      BAMBUDDY_PIPELINE_ID: "1",
      BAMBUDDY_PIPELINE_PETG: "2",
      CRON_SECRET,
      BETTER_AUTH_URL: APP,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (d: Buffer) => (bootLog += d));
  child.stderr?.on("data", (d: Buffer) => (bootLog += d));

  const { check, summary } = makeCheck();

  try {
    await waitForHealth();

    section("setup");
    await db.$executeRawUnsafe('DELETE FROM "rateLimit"');
    await db.auditEvent.deleteMany();
    await db.notification.deleteMany();
    await db.story.deleteMany();
    await db.verification.deleteMany();
    await db.session.deleteMany();
    await db.user.deleteMany({ where: { role: "client" } });

    const admin = await db.user.findFirst({ where: { role: "admin" } });
    if (!admin) throw new Error("No admin — run npm run db:seed");
    const ayla = await db.user.create({
      data: { email: "ayla@office.example", name: "Ayla Berg", initials: "AY",
               role: "client", emailVerified: true, invitedById: admin.id },
    });
    const client = await signIn(ayla);
    console.info(`  admin=${admin.email}  client=${ayla.email}`);

    // -----------------------------------------------------------------
    section("POST /api/stories — only a spool that is on the shelf and printable");
    const body = (spoolId: number) => JSON.stringify({
      title: "A test bracket", modelUrl: "https://makerworld.com/en/models/1-a-bracket",
      spoolId, quantity: 1,
    });

    fake.set("GET", "/api/v1/inventory/spools", () => ({
      status: 200,
      body: [
        { id: 1, material: "PLA Basic", color_name: "Jade White", rgba: "EBF1E0FF", archived_at: null },
        { id: 2, material: "PETG", color_name: "Charcoal", rgba: "2B2B2BFF", archived_at: null },
      ],
    }));
    const petg = await client.json<{ error?: string }>(`${APP}/api/stories`, { method: "POST", body: body(2) });
    check("a spool whose material is not switched on is refused with 400", petg.status === 400, JSON.stringify(petg));
    check("and the refusal names what can be printed", (petg.body.error ?? "").toLowerCase().includes("pla"), petg.body.error ?? "");

    const unknown = await client.json<{ error?: string }>(`${APP}/api/stories`, { method: "POST", body: body(999) });
    check("an unknown spool id is refused with 409 (stale picker)", unknown.status === 409, JSON.stringify(unknown));

    fake.set("GET", "/api/v1/inventory/spools", () => ({ status: 500, body: { detail: "boom" } }));
    const unreachable = await client.json<{ error?: string }>(`${APP}/api/stories`, { method: "POST", body: body(1) });
    check("Bambuddy down for the inventory read is a 503, not a 500 page",
          unreachable.status === 503, JSON.stringify(unreachable));

    // A working shelf again, and take the PLA spool for real. The
    // MakerWorld-resolve route is deliberately left unconfigured — the fake
    // answers 503, standing in for "Bambuddy briefly unreachable" at the
    // intake step right after spool validation passes.
    fake.set("GET", "/api/v1/inventory/spools", () => ({
      status: 200,
      body: [{ id: 1, material: "PLA Basic", color_name: "Jade White", rgba: "EBF1E0FF", archived_at: null }],
    }));
    const filed = await client.json<{ story?: { id: number; status: string } }>(
      `${APP}/api/stories`, { method: "POST", body: body(1) });
    check("filing with a valid PLA spool succeeds (201)", filed.status === 201, JSON.stringify(filed));
    const madeId = filed.body.story?.id;
    const row = madeId ? await db.story.findUnique({ where: { id: madeId } }) : null;
    check("the ticket is created with the spool's own colour/material",
          row?.material === "PLA Basic" && row?.colorName === "Jade White", JSON.stringify(row));
    check("intake's failure to resolve the link leaves the ticket Requested with a retry message, not thrown back to the caller",
          row?.status === "Requested" &&
          row?.errorMessage === "Bambuddy couldn't take this request. It'll retry automatically.",
          JSON.stringify(row));
    check("the printer owner is told about the first failure, distinctly from the new-request notice",
          madeId !== undefined &&
          (await db.notification.count({
            where: { recipientId: admin.id, storyId: madeId, text: { contains: "needs attention" } },
          })) === 1);
    check("and it's in the trail for the owner to actually diagnose",
          (await db.auditEvent.count({ where: { action: "story.intake_failed" } })) === 1);

    // -----------------------------------------------------------------
    section("POST /api/cron/sync — the Declined/Failed split, through the real wiring");

    async function queuedStory(title: string, batchId: number) {
      return db.story.create({
        data: {
          title, uploaderId: ayla.id, status: "Slicing", quantity: 1, note: "",
          material: "PLA Basic", colorName: "Jade White", colorHex: "#EBF1E0",
          modelUrl: "https://makerworld.com/en/models/1-a-bracket",
          queueBatchId: batchId,
        },
      });
    }
    const batch = (counts: Partial<Record<
      "pending_count" | "printing_count" | "completed_count" | "failed_count" | "cancelled_count" | "skipped_count",
      number
    >>) => ({
      id: 1, status: "open",
      pending_count: 0, printing_count: 0, completed_count: 0, failed_count: 0, cancelled_count: 0, skipped_count: 0,
      ...counts,
    });

    const allCancelled = await queuedStory("All cancelled by the owner", 501);
    const realFailure = await queuedStory("One entry actually failed", 502);
    const stillGoing = await queuedStory("Still on the bed", 503);
    const allDone = await queuedStory("Both copies printed clean", 504);
    const removed = await queuedStory("Deleted from Bambuddy's queue entirely", 505);

    fake.set("GET", "/api/v1/queue/batches/501", () => ({ status: 200, body: batch({ cancelled_count: 3 }) }));
    fake.set("GET", "/api/v1/queue/batches/502", () => ({ status: 200, body: batch({ failed_count: 1, cancelled_count: 1 }) }));
    fake.set("GET", "/api/v1/queue/batches/503", () => ({ status: 200, body: batch({ printing_count: 1, pending_count: 1 }) }));
    fake.set("GET", "/api/v1/queue/batches/504", () => ({ status: 200, body: batch({ completed_count: 2 }) }));
    fake.set("GET", "/api/v1/queue/batches/505", () => ({ status: 404, body: { detail: "not found" } }));

    const noAuth = await fetch(`${APP}/api/cron/sync`, { method: "POST" });
    check("the cron route refuses without the shared secret", noAuth.status === 401, String(noAuth.status));

    const synced = await fetch(`${APP}/api/cron/sync`, {
      method: "POST",
      headers: { authorization: `Bearer ${CRON_SECRET}` },
    });
    check("an authorised sync pass succeeds", synced.ok, String(synced.status));

    const after = await db.story.findMany({
      where: { id: { in: [allCancelled.id, realFailure.id, stillGoing.id, allDone.id, removed.id] } },
    });
    const statusOf = (id: number) => after.find((s) => s.id === id)?.status;
    const noteOf = (id: number) => after.find((s) => s.id === id)?.errorMessage;

    check("every entry cancelled (none failed) reads as Declined — THE regression this pins",
          statusOf(allCancelled.id) === "Declined", JSON.stringify(after.find((s) => s.id === allCancelled.id)));
    check("with a note that reads as the owner's own decision, not a failure",
          noteOf(allCancelled.id)?.includes("cancelled in Bambuddy by the printer owner") === true,
          noteOf(allCancelled.id) ?? "");
    check("a real failure in the mix is Failed, not Declined", statusOf(realFailure.id) === "Failed");
    check("one printing and one still pending is Printing", statusOf(stillGoing.id) === "Printing");
    check("every entry completed, nothing lost, is Done with no note",
          statusOf(allDone.id) === "Done" && noteOf(allDone.id) === null);
    check("a batch Bambuddy no longer has at all is Declined too, not Failed",
          statusOf(removed.id) === "Declined");

    check("the requester was told their cancelled ticket is now Declined",
          (await db.notification.findFirst({ where: { storyId: allCancelled.id }, orderBy: { createdAt: "desc" } }))
            ?.text.includes("Declined") === true);
    check("every status change is in the trail, by reference",
          (await db.auditEvent.count({
            where: { action: "story.status_changed", subject: { in: [allCancelled, realFailure, stillGoing, allDone, removed].map((s) => storyRef(s.id)) } },
          })) === 5);

    check("Bambuddy was actually called for each queued batch, not short-circuited",
          [501, 502, 503, 504, 505].every((id) => fake.calls.some((c) => c.path === `/api/v1/queue/batches/${id}`)),
          JSON.stringify(fake.calls));

    // -----------------------------------------------------------------
    section("materials — PETG is the owner's switch, and slices with its own pipeline");

    const shelf = [
      { id: 1, material: "PLA Basic", color_name: "Jade White", rgba: "EBF1E0FF", archived_at: null },
      { id: 2, material: "PETG HF", color_name: "Charcoal", rgba: "2B2B2BFF", archived_at: null },
      { id: 3, material: "PETG HF", color_name: "Sky Blue", rgba: "3A8FD9FF", archived_at: null },
      { id: 4, material: "PETG-CF", color_name: "Carbon", rgba: "111111FF", archived_at: null },
    ];
    fake.set("GET", "/api/v1/inventory/spools", () => ({ status: 200, body: shelf }));
    const setEnabled = (materials: string[]) =>
      db.appSettings.upsert({
        where: { id: 1 },
        create: { id: 1, enabledMaterials: materials },
        update: { enabledMaterials: materials },
      });
    const file = (spoolId: number) => client.json<{ error?: string; story?: { id: number } }>(
      `${APP}/api/stories`, { method: "POST", body: body(spoolId) });

    await setEnabled([]);
    const offByDefault = await file(2);
    check("with PETG not switched on, a PETG spool is refused (400) and the refusal offers PLA",
          offByDefault.status === 400 && /pla/i.test(offByDefault.body.error ?? "") && !/petg/i.test(offByDefault.body.error ?? ""),
          JSON.stringify(offByDefault));

    // Two pipelines that differ in everything the slicer's settings depend on.
    const pipeline = (id: number, name: string, printerId: number, filament: string, process: string, bed: string) => ({
      status: 200,
      body: {
        id, name,
        printer_preset: { source: "cloud", id: "PRINTER_A1" },
        process_preset: { source: "cloud", id: process },
        filament_presets: [{ source: "cloud", id: filament }],
        bed_type: bed,
        target_kind: "printer", target_printer_id: printerId, target_model_class: null,
      },
    });
    fake.set("GET", "/api/v1/slicer-pipelines/1", () => pipeline(1, "PLA", 11, "FIL_PLA", "PROC_PLA", "textured_pei"));
    fake.set("GET", "/api/v1/slicer-pipelines/2", () => pipeline(2, "PETG", 22, "FIL_PETG", "PROC_PETG", "cool_plate"));

    const sliced: { filament_presets: { id: string }[]; process_preset: { id: string }; bed_type: string }[] = [];
    const queued: { printer_id?: number; manual_start?: boolean }[] = [];
    fake.set("GET", "/api/v1/makerworld/status", () => ({ status: 200, body: { has_cloud_token: true, can_download: true } }));
    fake.set("POST", "/api/v1/makerworld/resolve", () => ({
      status: 200,
      body: { model_id: 1, profile_id: null, design: { title: "A bracket" }, instances: [], already_imported_library_ids: [] },
    }));
    fake.set("POST", "/api/v1/makerworld/import", () => ({
      status: 200, body: { library_file_id: 700, filename: "bracket.3mf", was_existing: false },
    }));
    fake.set("GET", "/api/v1/library/files/700/filament-requirements", () => ({
      status: 200, body: { filaments: [{ slot_id: 1, type: "PLA", color: "#FFFFFF", used_grams: 0 }] },
    }));
    fake.set("GET", "/api/v1/library/files/700/plates", () => ({
      status: 200, body: { is_multi_plate: false, plates: [{ index: 1, name: null }], design_overrides: [] },
    }));
    fake.set("POST", "/api/v1/library/files/700/slice", ({ body: raw }) => {
      sliced.push(JSON.parse(raw));
      return { status: 202, body: { job_id: 900 } };
    });
    fake.set("GET", "/api/v1/slice-jobs/900", () => ({
      status: 200,
      body: {
        job_id: 900, status: "completed", completed_at: "2026-10-08T12:00:00Z",
        result: { library_file_id: 800, print_time_seconds: 3600, filament_used_g: 12 },
      },
    }));
    fake.set("POST", "/api/v1/queue/", ({ body: raw }) => {
      queued.push(JSON.parse(raw));
      return {
        status: 201,
        body: {
          id: 1000 + queued.length, status: "pending", archive_id: null, library_file_id: 800,
          started_at: null, completed_at: null, error_message: null, waiting_reason: null, batch_id: null,
        },
      };
    });

    await setEnabled(["PETG"]);
    const pla = await file(1);
    check("with PETG on, PLA is still filed (201)", pla.status === 201, JSON.stringify(pla));
    check("a PLA ticket is sliced with the PLA pipeline's process, filament and bed",
          sliced.length === 1 &&
            sliced[0]!.process_preset.id === "PROC_PLA" &&
            sliced[0]!.filament_presets.every((f) => f.id === "FIL_PLA") &&
            sliced[0]!.bed_type === "textured_pei",
          JSON.stringify(sliced));
    check("and queued for the PLA pipeline's printer, waiting for a person",
          queued.length === 1 && queued[0]!.printer_id === 11 && queued[0]!.manual_start === true, JSON.stringify(queued));

    const petgFiled = await file(2);
    check("with PETG on, a PETG spool is filed (201)", petgFiled.status === 201, JSON.stringify(petgFiled));
    const petgId = petgFiled.body.story?.id;
    const petgRow = petgId ? await db.story.findUnique({ where: { id: petgId } }) : null;
    check("the PETG ticket records the spool's material", petgRow?.material === "PETG HF", JSON.stringify(petgRow));
    check("a PETG ticket is sliced with the PETG pipeline's process, filament and bed — not PLA's",
          sliced.length === 2 &&
            sliced[1]!.process_preset.id === "PROC_PETG" &&
            sliced[1]!.filament_presets.every((f) => f.id === "FIL_PETG") &&
            sliced[1]!.bed_type === "cool_plate",
          JSON.stringify(sliced[1]));
    check("and queued for the PETG pipeline's printer, still waiting for a person",
          queued.length === 2 && queued[1]!.printer_id === 22 && queued[1]!.manual_start === true, JSON.stringify(queued));
    check("the ticket went on to Ready, with no manual re-slice or re-add",
          petgRow?.status === "Ready" && petgRow?.queueItemIds.length === 1, JSON.stringify(petgRow));

    const carbon = await file(4);
    check("fibre-filled PETG is refused even with PETG on", carbon.status === 400, JSON.stringify(carbon));

    // A colour change may swap spools, but never the material the ticket was sliced for.
    const colours = (storyId: number, spoolId: number) => client.json<{ error?: string }>(
      `${APP}/api/stories/${storyId}/colours`, { method: "PUT", body: JSON.stringify({ slots: [{ slotId: 1, spoolId }] }) });
    const toPla = await colours(petgId!, 1);
    check("a PETG ticket cannot be recoloured with a PLA spool (400, naming PETG)",
          toPla.status === 400 && /petg/i.test(toPla.body.error ?? ""), JSON.stringify(toPla));
    const toBlue = await colours(petgId!, 3);
    check("but another PETG colour is fine", toBlue.status === 200, JSON.stringify(toBlue));
    const recoloured = await db.story.findUnique({ where: { id: petgId! } });
    check("and the ticket keeps its PETG material, now Sky Blue",
          recoloured?.material === "PETG HF" && recoloured?.colorName === "Sky Blue", JSON.stringify(recoloured));
    const plaId = pla.body.story?.id;
    const plaToPetg = await colours(plaId!, 2);
    check("nor can a PLA ticket be recoloured with a PETG spool", plaToPetg.status === 400, JSON.stringify(plaToPetg));

    // Switching it off stops new requests; what is already made carries on.
    await setEnabled([]);
    const afterOff = await file(2);
    check("switched off again, a new PETG request is refused", afterOff.status === 400, JSON.stringify(afterOff));
    const stillEditable = await colours(petgId!, 2);
    check("an existing PETG ticket is unaffected by the switch", stillEditable.status === 200, JSON.stringify(stillEditable));
    check("the pipelines were each fetched from Bambuddy, not assumed",
          fake.calls.some((c) => c.path === "/api/v1/slicer-pipelines/1") &&
            fake.calls.some((c) => c.path === "/api/v1/slicer-pipelines/2"));
  } catch (error) {
    console.error("\n--- next dev output (tail) ---\n" + bootLog.slice(-4000));
    throw error;
  } finally {
    child.kill("SIGTERM");
    await fake.stop();
  }

  process.exitCode = summary();
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => db.$disconnect());
