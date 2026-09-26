import "./_env";
/**
 * End-to-end check of the owner-managed benefits (the tip catalogue).
 *
 *   npm run verify:benefits
 *
 * Drives the real admin forms the way a JavaScript-off browser does, and the
 * real intake endpoint, asserting what a person observes: the DB row, what the
 * intake form and the board show, and what the server accepts. Also the tip
 * jar's on/off switch (src/lib/settings.ts), which gates all of it. `src/lib/benefits.ts` is
 * `server-only` so it cannot be imported here — everything goes through HTTP.
 *
 * DESTRUCTIVE: wipes users, stories, benefits and settings. Development
 * database only.
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

/** React SSR puts `<!-- -->` between static text and an interpolation. */
const rendered = (html: string) => html.replace(/<!--\s*-->/g, "");

/**
 * The markup a person sees, without the `<script>` payloads. `next dev` ships
 * every server component's props in its debug info — the whole story row,
 * tip included — which a production build does not, so asserting on the raw
 * page would fail in dev for a value nobody can see.
 */
const visible = (html: string) => rendered(html).replace(/<script\b[\s\S]*?<\/script>/g, "");

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
  await db.appSettings.deleteMany(); // no row: the defaults, tip jar off
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
  // A ticket that offered a tip, to watch it appear and disappear.
  const tipped = await db.story.create({
    data: {
      title: "Tipped order", uploaderId: ayla.id, colorName: "Slate", colorHex: "#4a5d78",
      tip: "A beer", material: "PLA", quantity: 1, note: "",
      modelUrl: "https://makerworld.com/en/models/000000-tipped-fixture",
    },
  });
  const apiTip = async (b: Browser) =>
    ((await (await b.go(`${APP}/api/stories/${tipped.id}`)).json()) as { tip?: string }).tip;
  // Every field valid except, possibly, the tip — and spoolId names no real
  // spool, so a request that gets past the tip check stops at Bambuddy.
  const file = (b: Browser, tip: string) =>
    b.raw(`${APP}/api/stories`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Tip check", modelUrl: "https://makerworld.com/en/models/123456", spoolId: 999999,
        quantity: 1, tip,
      }),
    });

  section("the tip jar starts off, and off hides it everywhere");
  let uploadPage = rendered(await (await client.go(`${APP}/upload`)).text());
  check("the intake form asks for no tip",
        !uploadPage.includes('name="tip"') && !uploadPage.includes("currently prefers"));
  const board = visible(await (await client.go(`${APP}/board`)).text());
  const at = board.indexOf("A beer");
  check("the board shows no tip on the ticket", at < 0, board.slice(Math.max(0, at - 300), at + 60));
  check("the profile shows no beer count",
        !rendered(await (await client.go(`${APP}/me`)).text()).includes("Beers owed"));
  check("the API sends the tip as empty", (await apiTip(client)) === "", `got ${JSON.stringify(await apiTip(client))}`);
  check("the stored tip is kept", (await db.story.findUnique({ where: { id: tipped.id } }))?.tip === "A beer");
  const ignored = await file(client, "Not on any list");
  const ignoredBody = await ignored.text();
  // Past the tip check, the next stop is Bambuddy's spool list: a 503 with no
  // Bambuddy configured, or a 409 for the made-up spool with one. Either way
  // the tip was not what answered.
  check("a posted tip is ignored, not refused",
        (ignored.status === 503 || ignored.status === 409) && !ignoredBody.includes("tip"),
        `${ignored.status} ${ignoredBody}`);

  section("the owner turns it on");
  page = await (await ruben.go(`${APP}/admin/benefits`)).text();
  await ruben.submit(`${APP}/admin/benefits`, page, findForm(page, ['name="enabled"', 'value="true"']), {});
  check("the switch is stored", (await db.appSettings.findUnique({ where: { id: 1 } }))?.tipJarEnabled === true);
  check("turning it on is audited", (await db.auditEvent.count({ where: { action: "tipjar.enabled" } })) === 1);

  uploadPage = rendered(await (await client.go(`${APP}/upload`)).text());
  check("the intake form offers the active benefits",
        uploadPage.includes('name="tip"') && uploadPage.includes("A big pizza") && uploadPage.includes("A coffee"));
  check("and stars the preferred one", uploadPage.includes("currently prefers: A big pizza"));
  check("the board shows the tip",
        visible(await (await client.go(`${APP}/board`)).text()).includes("A beer"));
  check("the profile shows the beer count",
        rendered(await (await client.go(`${APP}/me`)).text()).includes("Beers owed"));
  check("the API sends the tip", (await apiTip(client)) === "A beer");
  const refused = await file(client, "Not on any list");
  const refusedBody = await refused.text();
  check("a tip that is not an active benefit is refused",
        refused.status === 400 && refusedBody.includes("tip"), `${refused.status} ${refusedBody}`);

  section("and off again");
  page = await (await ruben.go(`${APP}/admin/benefits`)).text();
  await ruben.submit(`${APP}/admin/benefits`, page, findForm(page, ['name="enabled"', 'value="false"']), {});
  check("the switch is stored", (await db.appSettings.findUnique({ where: { id: 1 } }))?.tipJarEnabled === false);
  check("turning it off is audited", (await db.auditEvent.count({ where: { action: "tipjar.disabled" } })) === 1);
  check("the form stops asking",
        !rendered(await (await client.go(`${APP}/upload`)).text()).includes('name="tip"'));

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
  await db.appSettings.deleteMany();
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
