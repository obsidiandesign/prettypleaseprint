import "./_env";
/**
 * Do the migrations in prisma/migrations add up to prisma/schema.prisma?
 *
 *   SHADOW_DATABASE_URL=postgresql://... npm run check:migrations
 *
 * Replays every migration, in order, onto an empty scratch database and diffs
 * the result against the schema. Two things go wrong silently otherwise, and
 * neither breaks a typecheck or a test that runs against a database built by
 * `prisma db push`:
 *
 *   - someone edits schema.prisma and forgets `prisma migrate dev`, so a
 *     deployment that runs `migrate deploy` has no such column; and
 *   - a migration written by hand (some here are) differs from what the schema
 *     says, or fails to apply to a database at all.
 *
 * The scratch database is WIPED on every run: Prisma resets a shadow database
 * before using it. So the URL must be a different database from DATABASE_URL,
 * and this refuses to run if it is the same one.
 */
import { spawnSync } from "node:child_process";

const shadow = process.env.SHADOW_DATABASE_URL;
if (!shadow) {
  console.error(
    "SHADOW_DATABASE_URL is not set. Point it at an EMPTY scratch database (it is wiped on every run), e.g.\n" +
      "  SHADOW_DATABASE_URL=postgresql://ppp:...@localhost:5432/ppp_shadow npm run check:migrations",
  );
  process.exit(1);
}
if (shadow === process.env.DATABASE_URL) {
  console.error("SHADOW_DATABASE_URL is the same as DATABASE_URL, and would be wiped. Use a separate database.");
  process.exit(1);
}

const run = spawnSync(
  "npx",
  [
    "prisma", "migrate", "diff",
    "--from-migrations", "prisma/migrations",
    "--to-schema-datamodel", "prisma/schema.prisma",
    "--shadow-database-url", shadow,
    "--exit-code",
    "--script",
  ],
  { encoding: "utf8" },
);

// 0: identical. 2: they differ (the SQL to bridge them is on stdout).
// Anything else is Prisma failing, most often a migration that doesn't apply.
if (run.status === 0) {
  console.info("ok  the migrations add up to the schema");
  process.exit(0);
}
if (run.status === 2) {
  console.error("FAIL  schema.prisma has changes that no migration creates (or a migration doesn't match it).");
  console.error("      Prisma would need to run this SQL to bring a migrated database in line:\n");
  console.error(run.stdout.trim().replace(/^/gm, "        "));
  console.error("\n      Fix: `npm run db:migrate -- --name <what_changed>`, then commit the new migration.");
  process.exit(1);
}
console.error("FAIL  Prisma could not replay the migrations onto an empty database:\n");
console.error((run.stderr || run.stdout).trim());
process.exit(1);
