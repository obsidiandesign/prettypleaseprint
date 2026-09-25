import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";

import { syncOpenStories } from "@/lib/bambuddy-sync";

/**
 * The scheduled half of the Bambuddy sync (see src/lib/bambuddy-sync.ts).
 *
 * Not a user route — there's no session to check, since nothing here is a
 * person's action. Authorised instead by a shared secret in the
 * Authorization header, meant to be called by whatever cron this deployment
 * actually has (the host's crontab curling this URL, most likely — see
 * .env.example). Missing `CRON_SECRET` refuses every request rather than
 * falling open, and the comparison is constant-time so a wrong guess can't
 * be narrowed down by how fast it was rejected.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;

  const header = request.headers.get("authorization") ?? "";
  const expected = `Bearer ${secret}`;
  if (header.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(header), Buffer.from(expected));
}

export async function POST(request: Request) {
  if (!authorized(request)) {
    return NextResponse.json({ error: "Not authorized." }, { status: 401 });
  }

  try {
    const result = await syncOpenStories();
    return NextResponse.json(result);
  } catch (error) {
    console.error("[cron/sync] failed", error);
    return NextResponse.json({ error: "Sync failed." }, { status: 500 });
  }
}
