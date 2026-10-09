import { requireAdmin } from "@/lib/authz";
import { materialPipelineId } from "@/lib/bambuddy";
import { ALWAYS_ON, MATERIALS } from "@/lib/materials";
import { getSettings } from "@/lib/settings";
import { AppHeader } from "@/components/app-header";
import { Kicker, Notice } from "@/components/ui";
import { Toast } from "@/components/toast";
import { setMaterialAction } from "./actions";

export const dynamic = "force-dynamic";

/**
 * Which filament materials people can ask for. Admin-only: `requireAdmin`
 * answers 404. Plain server-rendered forms, like the other admin screens.
 *
 * A material is offered once it is switched on here *and* its Slicer Pipeline
 * is configured, because the slicer's settings differ per filament and a
 * request in a material with no recipe could not be sliced.
 */
export default async function MaterialsPage({
  searchParams,
}: {
  searchParams: Promise<{ toast?: string; error?: string }>;
}) {
  const [{ toast, error }, admin] = await Promise.all([searchParams, requireAdmin()]);
  const { enabledMaterials } = await getSettings();

  return (
    <>
      <AppHeader user={admin} active="/admin/materials" />

      <main className="mx-auto w-full max-w-[880px] px-[26.4px] pb-[80px] pt-[35.2px]">
        <Kicker>Materials</Kicker>
        <h1 className="m-0 mt-[6px] mb-[8px] font-display text-[30px] leading-[1.05] text-ink">
          What can be printed
        </h1>
        <p className="m-0 mb-[22px] max-w-[62ch] text-[15px] text-ink-2">
          The colour someone picks is a spool, and the spool&rsquo;s material
          decides which Bambuddy Slicer Pipeline slices the request, so its
          process, filament and bed settings are the ones you set for that
          material. Turning one off only stops new requests; tickets already
          made in it carry on.
        </p>

        {error && (
          <div className="mb-[17.6px]">
            <Notice tone="warn">{error}</Notice>
          </div>
        )}

        <div className="flex flex-col gap-[13.2px]">
          {MATERIALS.map((m) => {
            const always = m.key === ALWAYS_ON;
            const configured = materialPipelineId(m.key) > 0;
            const on = always || enabledMaterials.includes(m.key);
            const offered = on && configured;
            return (
              <form
                key={m.key}
                action={setMaterialAction}
                className={`flex flex-wrap items-center justify-between gap-[13.2px] rounded-panel border-[3px] border-ink p-[17.6px] shadow-stamp ${
                  offered ? "bg-mint-wash" : "bg-cream-2"
                }`}
              >
                <input type="hidden" name="key" value={m.key} />
                <input type="hidden" name="enabled" value={on ? "false" : "true"} />
                <div className="flex-[1_1_300px]">
                  <p className="m-0 mb-[4px] font-mono text-[12px] font-bold uppercase tracking-[0.1em] text-ink-2">
                    {m.label} · {offered ? "on" : on ? "on, not set up" : "off"}
                  </p>
                  <p className="m-0 text-[14.5px] text-ink-2">
                    {always
                      ? "The standard material: always offered."
                      : !configured
                        ? `No Slicer Pipeline yet. ${m.note ?? `Set ${m.pipelineEnv} to a pipeline id.`}`
                        : offered
                          ? `People can pick ${m.label} spools. Sliced with Slicer Pipeline ${materialPipelineId(m.key)}.`
                          : `${m.label} spools are hidden from the colour picker.`}
                  </p>
                </div>
                {!always && (
                  <button
                    type="submit"
                    disabled={!on && !configured}
                    className={`stamp cursor-pointer rounded-chip border-[3px] border-ink px-[20px] py-[10px] text-[14px] font-bold disabled:cursor-not-allowed disabled:opacity-50 ${
                      on ? "bg-porcelain text-ink hover:bg-sun" : "bg-cherry-dk text-cream hover:bg-cherry"
                    }`}
                  >
                    {on ? "Turn it off" : "Turn it on"}
                  </button>
                )}
              </form>
            );
          })}
        </div>
      </main>

      {toast && <Toast>{toast}</Toast>}
    </>
  );
}
