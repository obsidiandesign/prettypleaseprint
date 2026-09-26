import "./_env";
/**
 * End-to-end check of the owner-managed benefits (the tip catalogue).
 *
 *   npm run verify:benefits
 *
 * Drives the real admin forms the way a JavaScript-off browser does, and the
 * real upload endpoint, asserting what a person observes: the DB row, what the
 * upload form shows, and what the server accepts. `src/lib/benefits.ts` is
 * `server-only` so it cannot be imported here — everything goes through HTTP.
 *
 * DESTRUCTIVE: wipes users, stories and benefits. Development database only.
 */
import { db } from "../src/lib/db";
import { ensureCredentials, signInWithPassword, usernameFor } from "./_accounts";

const APP = process.env.BETTER_AUTH_URL ?? "http://localhost:3000";

let passed = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail = "") {
  console.info(`  ${ok ? "ok  " : "FAIL"}  ${name}${ok || !detail ? "" : `\n          ${detail}`}`);
  ok ? passed++ : failures.push(name);
}
const section = (t: string) =>
  console.info(`\n── ${t} ${"─".repeat(Math.max(0, 54 - t.length))}`);

const unescapeHtml = (s: string) =>
  s.replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

class Browser {
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
  private headers(): Record<string, string> {
    const h: Record<string, string> = { origin: APP };
    if (this.jar.size) h.cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ");
    return h;
  }
  async raw(url: string, init: RequestInit = {}) {
    const r = await fetch(url, { ...init, redirect: "manual", headers: { ...(init.headers ?? {}), ...this.headers() } });
    this.store(r);
    return r;
  }
  async go(url: string, init: RequestInit = {}) {
    let r = await this.raw(url, init);
    for (let i = 0; i < 8; i++) {
      const loc = r.headers.get("location");
      if (!loc || r.status < 300 || r.status >= 400) break;
      r = await this.raw(new URL(loc, url).toString());
    }
    return r;
  }
  /** Replay one server-action form (its hidden inputs + overrides). */
  async submit(url: string, html: string, formIndex: number, values: Record<string, string>) {
    const forms = html.match(/<form\b[\s\S]*?<\/form>/g) ?? [];
    const form = forms[formIndex];
    if (!form) throw new Error(`no form #${formIndex} on ${url}`);
    const body = new FormData();
    for (const tag of form.match(/<input\b[^>]*>/g) ?? []) {
      if (!tag.includes('type="hidden"')) continue;
      const n = /name="([^"]*)"/.exec(tag)?.[1];
      const v = /value="([^"]*)"/.exec(tag)?.[1] ?? "";
      if (n) body.append(unescapeHtml(n), unescapeHtml(v));
    }
    for (const [k, v] of Object.entries(values)) body.set(k, v);
    return this.raw(url, { method: "POST", body });
  }
}

/** Index of the first form whose markup contains every substring. */
function findForm(html: string, contains: string[]): number {
  const forms = html.match(/<form\b[\s\S]*?<\/form>/g) ?? [];
  return forms.findIndex((f) => contains.every((s) => f.includes(s)));
}

async function signIn(user: { id: string; email: string }): Promise<Browser> {
  const b = new Browser();
  await db.$executeRawUnsafe('DELETE FROM "rateLimit"');
  await ensureCredentials(APP, user.id, usernameFor(user.email));
  await signInWithPassword(b, APP, usernameFor(user.email));
  return b;
}

async function main() {
  section("setup");
  await db.$executeRawUnsafe('DELETE FROM "rateLimit"');
  await db.auditEvent.deleteMany();
  await db.notification.deleteMany();
  await db.story.deleteMany();
  await db.benefit.deleteMany();
  await db.verification.deleteMany();
  await db.session.deleteMany();
  await db.invite.deleteMany();
  await db.user.deleteMany({ where: { role: "client" } });

  const admin = await db.user.findFirst({ where: { role: "admin" } });
  if (!admin) throw new Error("No admin — run npm run db:seed");
  const ayla = await db.user.create({
    data: { email: "ayla@office.example", name: "Ayla Berg", initials: "AY", role: "client", emailVerified: true, invitedById: admin.id },
  });

  // A known starting catalogue.
  await db.benefit.createMany({
    data: [
      { label: "A beer", sortOrder: 1 },
      { label: "A coffee", sortOrder: 2 },
      { label: "Nothing, sorry", sortOrder: 3 },
    ],
  });

  const ruben = await signIn(admin);
  const client = await signIn(ayla);
  console.info(`  admin=${admin.email}  client=${ayla.email}`);

  // ------------------------------------------------------------------
  section("the benefits screen is owner-only");
  const denied = await client.go(`${APP}/admin/benefits`);
  check("a client gets 404, not 403", denied.status === 404, `status ${denied.status}`);
  const adminPage = await (await ruben.go(`${APP}/admin/benefits`)).text();
  check("the owner sees the catalogue", adminPage.includes("A beer") && adminPage.includes("A coffee"));

  // ------------------------------------------------------------------
  section("the owner manages the list");
  // Add
  await ruben.submit(`${APP}/admin/benefits`, adminPage, findForm(adminPage, ['name="label"', 'Add']), { label: "A pizza" });
  const pizza = await db.benefit.findUnique({ where: { label: "A pizza" } });
  check("a benefit can be added", !!pizza);
  check("adding is audited", (await db.auditEvent.count({ where: { action: "benefit.created", subject: "A pizza" } })) === 1);

  // A duplicate is refused with a message.
  let page = await (await ruben.go(`${APP}/admin/benefits`)).text();
  const dup = await ruben.submit(`${APP}/admin/benefits`, page, findForm(page, ['name="label"', 'Add']), { label: "A beer" });
  check("a duplicate label is refused", (dup.headers.get("location") ?? "").includes("error="),
        dup.headers.get("location") ?? "");
  check("and no second row is created", (await db.benefit.count({ where: { label: "A beer" } })) === 1);

  // Mark preferred
  page = await (await ruben.go(`${APP}/admin/benefits`)).text();
  await ruben.submit(`${APP}/admin/benefits`, page, findForm(page, [`value="${pizza!.id}"`, 'name="preferred"']), {});
  check("a benefit can be marked preferred",
        (await db.benefit.findUnique({ where: { id: pizza!.id } }))?.preferred === true);
  check("the change is audited", (await db.auditEvent.count({ where: { action: "benefit.updated" } })) >= 1);

  // Rename
  page = await (await ruben.go(`${APP}/admin/benefits`)).text();
  await ruben.submit(`${APP}/admin/benefits`, page, findForm(page, [`value="${pizza!.id}"`, 'name="label"']), { label: "A big pizza" });
  check("a benefit can be renamed",
        (await db.benefit.findUnique({ where: { id: pizza!.id } }))?.label === "A big pizza");

  // Retire, then restore
  const beer = await db.benefit.findUnique({ where: { label: "A beer" } });
  page = await (await ruben.go(`${APP}/admin/benefits`)).text();
  await ruben.submit(`${APP}/admin/benefits`, page, findForm(page, [`value="${beer!.id}"`, 'name="active"', 'value="false"']), {});
  check("a benefit can be retired",
        (await db.benefit.findUnique({ where: { id: beer!.id } }))?.active === false);
  page = await (await ruben.go(`${APP}/admin/benefits`)).text();
  await ruben.submit(`${APP}/admin/benefits`, page, findForm(page, [`value="${beer!.id}"`, 'name="active"', 'value="true"']), {});
  check("and restored",
        (await db.benefit.findUnique({ where: { id: beer!.id } }))?.active === true);

  // ------------------------------------------------------------------
  // The tip jar doesn't fit a link-first, family-facing intake form the way
  // it fit an office upload form — see the note where Story.tip's schema
  // comment lives. It's deliberately not wired into src/app/upload/upload-
  // form.tsx while it's decided whether/how to repurpose it, so what's worth
  // asserting here is that absence, not a validation path that no longer
  // exists (there is no more "the server decides the tip" — CreateStorySchema
  // has no tip field at all).
  section("the tip jar is not offered on the new intake form");
  const uploadPage = await (await client.go(`${APP}/upload`)).text();
  check("the intake form does not render the benefit catalogue",
        !uploadPage.includes("A big pizza") && !uploadPage.includes("currently prefers"),
        "a tip-jar section reappeared on /upload — repurposed on purpose, or a stale import?");

  // ------------------------------------------------------------------
  section("history keeps the tip it was made with");
  const past = await db.story.create({
    data: {
      title: "Old order", uploaderId: ayla.id, colorName: "Slate", colorHex: "#4a5d78",
      tip: "A beer", material: "PETG", quantity: 1, note: "",
      modelUrl: "https://makerworld.com/en/models/000000-history-fixture",
    },
  });
  await db.benefit.deleteMany({ where: { label: "A beer" } }); // remove it from the list entirely
  check("a story keeps its tip string after the benefit is gone",
        (await db.story.findUnique({ where: { id: past.id } }))?.tip === "A beer");

  // ------------------------------------------------------------------
  section("teardown — restore the default benefits");
  await db.benefit.deleteMany();
  const defaults = ["A beer", "A coffee", "A spool of filament", "Nerd stuff", "Nothing, sorry"];
  await db.benefit.createMany({ data: defaults.map((label, i) => ({ label, sortOrder: i + 1 })) });
  check("defaults restored for the next run", (await db.benefit.count()) === defaults.length);

  console.info(
    `\n${passed} checks passed, ${failures.length} failed` +
      (failures.length ? `:\n  - ${failures.join("\n  - ")}` : ""),
  );
  process.exitCode = failures.length ? 1 : 0;
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => db.$disconnect());
