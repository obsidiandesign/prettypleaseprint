/**
 * Renders the main screens to PNG so a design change can be looked at rather
 * than assumed.
 *
 *   npm run shots            # writes to ./shots (gitignored)
 *   SHOT_DIR=/tmp/x npm run shots
 *
 * Seeds a handful of tickets first, because an empty rail says nothing about
 * whether the rail works.
 *
 * DESTRUCTIVE: replaces stories and the demo client. Development only.
 */
import "./_env";
import { existsSync, mkdirSync } from "node:fs";
import puppeteer, { type Page } from "puppeteer-core";
import { db } from "../src/lib/db";
import { TEST_PASSWORD, ensureCredentials, usernameFor } from "./_accounts";

const APP = process.env.BETTER_AUTH_URL ?? "http://localhost:3000";
const OUT = process.env.SHOT_DIR ?? "shots";

const CHROME =
  process.env.CHROME_PATH ??
  [
    "/snap/chromium/current/usr/lib/chromium-browser/chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
  ].find((p) => existsSync(p));

/**
 * Sign a page in through the real form. The screenshots are of the app a
 * person uses, so the way into it should be too.
 */
async function signIn(page: Page, user: { id: string; email: string }): Promise<void> {
  await db.$executeRawUnsafe('DELETE FROM "rateLimit"');
  await ensureCredentials(APP, user.id, usernameFor(user.email));
  await page.goto(`${APP}/signin`, { waitUntil: "networkidle2" });
  await page.type("#username", usernameFor(user.email));
  await page.type("#password", TEST_PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForFunction(() => location.pathname !== "/signin", { timeout: 15_000 });
}

/** One ticket per stage, so every rail colour and state is on screen at once. */
const SEED = [
  ["Hook for the monitor arm", "Requested", "PETG", "Slate", "#4a5d78", "A beer", 1, false],
  ["Cable comb, 6 slots", "Slicing", "PLA", "Graphite", "#1b2126", "A coffee", 4, true],
  ["Replacement knob, grinder", "Printing", "PETG", "Teal", "#12645f", "A spool of filament", 2, false],
  ["Desk sign, meeting room", "Done", "PLA", "Bone white", "#eaecee", "Nerd stuff", 1, false],
  ["Gridfinity bin, 2×1", "Ready", "PLA", "Slate", "#4a5d78", "A beer", 6, false],
] as const;

async function main() {
  if (!CHROME) throw new Error("No Chrome or Chromium found. Set CHROME_PATH.");
  mkdirSync(OUT, { recursive: true });

  const admin = await db.user.findFirst({ where: { role: "admin" } });
  if (!admin) throw new Error("No admin — run npm run db:seed");

  await db.story.deleteMany();
  await db.user.deleteMany({ where: { email: "ayla@office.example" } });
  const ayla = await db.user.create({
    data: {
      email: "ayla@office.example", name: "Ayla Berg", initials: "AY",
      role: "client", emailVerified: true, invitedById: admin.id,
    },
  });

  for (const [title, status, material, colorName, colorHex, tip, qty, flagged] of SEED) {
    await db.story.create({
      data: {
        title, status: status as never, material, colorName, colorHex, tip,
        quantity: qty, flagged,
        note: "Clips onto the round arm tube and holds a headset. No rush.",
        uploaderId: ayla.id,
        modelUrl: "https://makerworld.com/en/models/000000-demo-fixture",
        resolvedTitle: title,
      },
    });
  }

  // A short exchange on the Printing ticket, so the thread is not empty in
  // the screenshot — an empty component says nothing about whether it works.
  const printingSeed = await db.story.findFirst({ where: { status: "Printing" } });
  if (printingSeed) {
    await db.comment.createMany({
      data: [
        { storyId: printingSeed.id, authorId: ayla.id,
          body: "Teal if you have it, otherwise anything dark." },
        { storyId: printingSeed.id, authorId: admin.id,
          body: "On the bed now, layer 84. Teal it is." },
      ],
    });
  }

  // One declined ticket, so the profile shows what the rail deliberately
  // does not carry.
  await db.story.create({
    data: {
      title: "Bracket that was too thin", uploaderId: ayla.id, status: "Declined",
      material: "PLA", colorName: "Bone white", colorHex: "#eaecee",
      tip: "Nothing, sorry", quantity: 1,
      modelUrl: "https://makerworld.com/en/models/000000-declined-fixture",
      resolvedTitle: "Bracket that was too thin",
    },
  });

  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 980, deviceScaleFactor: 1 });

  // Signed out first, while there is no session.
  await page.goto(`${APP}/signin`, { waitUntil: "networkidle2" });
  await page.screenshot({ path: `${OUT}/signin.png` });

  await signIn(page, ayla);

  const printing = await db.story.findFirst({ where: { status: "Printing" } });
  const pages: Array<[string, string]> = [
    ["board", `${APP}/board`],
    ["upload", `${APP}/upload`],
    ["profile", `${APP}/me`],
    ["story", `${APP}/story/${printing!.id}`],
  ];
  for (const [name, url] of pages) {
    await page.goto(url, { waitUntil: "networkidle2" });
    await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
  }

  // The printer owner's side. A separate browser context rather than signing
  // out: /api/auth/sign-out is POST-only, so navigating to it just hangs.
  const adminCtx = await browser.createBrowserContext();
  const adminPage = await adminCtx.newPage();
  await adminPage.setViewport({ width: 1280, height: 980, deviceScaleFactor: 1 });
  await signIn(adminPage, admin);
  {
    for (const [name, url] of [
      ["queue", `${APP}/queue`],
      ["books", `${APP}/me`],
      ["story-admin", `${APP}/story/${printing!.id}`],
    ] as Array<[string, string]>) {
      await adminPage.goto(url, { waitUntil: "networkidle2" });
      await adminPage.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
    }
  }
  await adminCtx.close();

  // Narrow, because the rail has to collapse without a media query.
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
  await page.goto(`${APP}/board`, { waitUntil: "networkidle2" });
  await page.screenshot({ path: `${OUT}/board-mobile.png`, fullPage: true });

  await browser.close();
  console.info(`wrote ${pages.length + 4} screenshots to ${OUT}/`);
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => db.$disconnect());
