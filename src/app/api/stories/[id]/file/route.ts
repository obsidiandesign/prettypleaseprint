import { withActor } from "@/lib/api";
import { modelFileFor, storyIdOr400 } from "@/lib/stories";

/**
 * Download the model behind a ticket — the "Download original" button on a
 * ticket in "Needs prep" — streamed from Bambuddy's library. Printer owner
 * only. Behind the session like every page, so a signed-out request is 401.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withActor<{ id: string }>(
  async (_request, actor, { id }) => {
    const file = await modelFileFor(actor, storyIdOr400(id));
    // RFC 6266: an ASCII fallback, plus the exact name for browsers that read it.
    const ascii = file.filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
    return new Response(file.body, {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
        ...(file.size && { "Content-Length": file.size }),
        "Cache-Control": "private, no-store",
      },
    });
  },
  { admin: true },
);
