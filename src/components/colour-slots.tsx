import { setStoryColours } from "@/app/actions/stories";
import { AMS_SLOTS } from "@/lib/scope";
import { Button, Notice } from "@/components/ui";

export type ColourSlot = {
  slotId: number;
  designColor: string | null;
  usedGrams: number;
  spoolId: number | null;
  colorName: string | null;
  colorHex: string | null;
};

/**
 * One row per distinct colour+finish on the shelf (see `dedupeSpools`).
 * `memberIds` lists every physical spool `id` collapses — a slot's saved
 * `spoolId` only reads as "no longer on the shelf" if it's absent from
 * every group's `memberIds`, not just unequal to the representative `id`.
 */
export type ShelfSpool = { id: number; name: string; hex: string | null; memberIds: number[] };

const NO_COLOUR = "#b6bcc2";
const swatchOf = (hex: string | null) => (hex ? `#${hex.replace(/^#/, "")}` : NO_COLOUR);

function Swatch({ hex, label }: { hex: string | null; label: string }) {
  return (
    <span
      role="img"
      aria-label={label}
      className="inline-block h-[18px] w-[18px] flex-none rounded-full border-2 border-ink"
      style={{ background: swatchOf(hex) }}
    />
  );
}

/**
 * A multi-colour model's colours, on its ticket.
 *
 * One row per colour the model uses, main part first: the designer's colour
 * (a hint, since every request prints in PLA from what's on the shelf) and
 * what will actually be used. With `spools`, it's also the form to change
 * them; without, it's read-only (the print has started, the viewer isn't the
 * requester or the owner, or Bambuddy's inventory couldn't be read).
 *
 * The main slot has no "printer's choice": it carries the ticket's own colour.
 */
export function ColourSlots({
  storyId,
  slots,
  spools,
  inventoryError = false,
  from,
}: {
  storyId: number;
  slots: ColourSlot[];
  spools: ShelfSpool[] | null;
  inventoryError?: boolean;
  from: string;
}) {
  const selectClass =
    "w-full rounded-card border-[3px] border-ink bg-porcelain px-[10px] py-[6px] text-[14px] font-bold text-ink";

  const gramsKnown = slots.some((s) => s.usedGrams > 0);
  const rows = slots.map((slot, i) => {
    const main = i === 0;
    // Grams are only known for a file that was already sliced; an ordinary
    // MakerWorld project reports 0 for every slot, and "0 g" reads as broken.
    const usage = gramsKnown ? ` · ${Math.round(slot.usedGrams)} g` : "";
    const heading = (
      <span className="flex items-center gap-[8.8px] font-mono text-[11.5px] font-bold uppercase tracking-[0.06em] text-ink-3">
        <Swatch hex={slot.designColor} label={`Designer's colour ${slot.designColor ?? "unknown"}`} />
        {gramsKnown ? (main ? "Main part" : `Colour ${i + 1}`) : `Colour ${i + 1}${main ? " · main" : ""}`}
        {usage}
      </span>
    );

    if (!spools) {
      return (
        <li key={slot.slotId} className="flex flex-wrap items-center justify-between gap-[8.8px]">
          {heading}
          <span className="flex items-center gap-[8.8px] text-[15px] text-ink">
            {slot.spoolId === null ? (
              <span className="text-ink-2">Printer&rsquo;s choice</span>
            ) : (
              <>
                <Swatch hex={slot.colorHex} label="" />
                {slot.colorName}
              </>
            )}
          </span>
        </li>
      );
    }

    // A pick whose spool has since left the shelf still shows, so saving the
    // form doesn't silently change it. Saving it again is refused, by design.
    // "Left the shelf" means no spool of that colour+finish remains at all —
    // a saved id that moved to a different representative after dedupe
    // (its reel got used up but a sibling of the same colour is still there)
    // isn't gone, so the group's current id is what gets preselected.
    const group = slot.spoolId === null ? undefined : spools.find((s) => s.memberIds.includes(slot.spoolId!));
    const gone = slot.spoolId !== null && !group;
    const selectedId = group ? group.id : slot.spoolId;
    return (
      <li key={slot.slotId} className="grid gap-[6px]">
        <label htmlFor={`slot-${storyId}-${slot.slotId}`}>{heading}</label>
        <select
          id={`slot-${storyId}-${slot.slotId}`}
          name={`slot-${slot.slotId}`}
          defaultValue={selectedId === null ? "" : String(selectedId)}
          className={selectClass}
        >
          {!main && <option value="">Printer&rsquo;s choice (close to the designer&rsquo;s)</option>}
          {gone && (
            <option value={String(slot.spoolId)}>{slot.colorName} (no longer on the shelf)</option>
          )}
          {spools.map((s) => (
            <option key={s.id} value={String(s.id)}>
              {s.name}
            </option>
          ))}
        </select>
      </li>
    );
  });

  return (
    <section className="mt-[26.4px] rounded-panel border-[3px] border-ink bg-porcelain p-[22px] shadow-stamp">
      <h2 className="m-0 mb-[6px] font-display text-[22px] text-ink">Colours</h2>
      <p className="m-0 mb-[13.2px] text-[14px] leading-[1.45] text-ink-2">
        This model uses {slots.length} colours. The small dots are the designer&rsquo;s;
        pick what to print each part in from what&rsquo;s on the shelf.
      </p>

      {slots.length > AMS_SLOTS && (
        <div className="mb-[13.2px]">
          <Notice tone="warn">
            That&rsquo;s more colours than the printer can hold at once ({AMS_SLOTS}).
            The printer owner will need to swap filament by hand, or talk to you
            about leaving some out.
          </Notice>
        </div>
      )}
      {inventoryError && (
        <div className="mb-[13.2px]">
          <Notice tone="warn">
            Couldn&rsquo;t reach Bambuddy for the colour list just now, so these
            can&rsquo;t be changed at the moment. Try refreshing in a minute.
          </Notice>
        </div>
      )}

      {spools ? (
        <form action={setStoryColours} className="grid gap-[13.2px]">
          <input type="hidden" name="storyId" value={storyId} />
          <input type="hidden" name="from" value={from} />
          <ul className="m-0 grid list-none gap-[13.2px] p-0">{rows}</ul>
          <div>
            <Button type="submit" variant="secondary">
              Save colours
            </Button>
          </div>
        </form>
      ) : (
        <ul className="m-0 grid list-none gap-[10px] p-0">{rows}</ul>
      )}
    </section>
  );
}
