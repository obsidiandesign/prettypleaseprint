import { printerName, requireUser } from "@/lib/authz";
import { isPla, listSpools } from "@/lib/bambuddy";
import { AppHeader } from "@/components/app-header";
import { Kicker, Notice } from "@/components/ui";
import { UploadForm } from "./upload-form";

export const dynamic = "force-dynamic";

export default async function UploadPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const [{ error }, user] = await Promise.all([searchParams, requireUser("/upload")]);
  const owner = await printerName();

  // A live read, not cached data — the whole point of the colour picker is
  // that it can't drift from what's actually on the shelf. A Bambuddy hiccup
  // here means an empty picker rather than a broken page.
  let spools: Awaited<ReturnType<typeof listSpools>> = [];
  let inventoryError = false;
  try {
    spools = (await listSpools()).filter((s) => isPla(s.material));
  } catch {
    inventoryError = true;
  }

  return (
    <>
      <AppHeader user={user} active="/upload" />
      <main className="mx-auto w-full max-w-[1180px] px-[26.4px] pb-[80px] pt-[35.2px]">
        <div className="max-w-[780px]">
          <Kicker>New order</Kicker>
          <h1 className="m-0 mb-[13.2px] text-[46px] leading-[0.98] text-ink">
            Pretty please print
          </h1>
          <p className="m-0 mb-[26.4px] text-[16.5px] leading-[1.5] text-ink-2 text-pretty">
            Paste a link to the model — a MakerWorld page is easiest. {owner}
            {" "}gets a ping, it slices on its own, and your order goes up on
            the rail as a ticket you can follow.
          </p>
        </div>

        {error && (
          <div className="mb-[22px] max-w-[780px]">
            <Notice tone="warn">{error}</Notice>
          </div>
        )}
        {inventoryError && (
          <div className="mb-[22px] max-w-[780px]">
            <Notice tone="warn">
              Couldn&rsquo;t reach Bambuddy for the colour list just now — try
              refreshing this page in a moment.
            </Notice>
          </div>
        )}

        <UploadForm owner={owner} spools={spools} />
      </main>
    </>
  );
}
