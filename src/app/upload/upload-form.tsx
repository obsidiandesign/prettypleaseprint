"use client";

import { useState } from "react";

import { createStory } from "@/app/actions/stories";
import { QUANTITY_PRESETS } from "@/lib/catalog";
import { Button, Label } from "@/components/ui";

export type Spool = {
  id: number;
  material: string;
  color_name: string | null;
  rgba: string | null;
};

/** Segmented control. Handoff §3: track #eaecee, 3px inset, 6px options. */
function Segmented<T extends string | number>({
  options,
  value,
  onChange,
  mono = false,
  label,
}: {
  options: readonly T[];
  value: T;
  onChange: (v: T) => void;
  mono?: boolean;
  label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-[6px]">
      {options.map((option) => {
        const active = option === value;
        return (
          <button
            key={String(option)}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(option)}
            className={`flex-1 cursor-pointer rounded-chip border-[3px] border-ink px-[10px] py-[8px] font-mono text-[12.5px] font-bold uppercase tracking-[0.06em] transition-colors ${
              active ? "bg-cherry-dk text-cream" : "bg-porcelain text-ink hover:bg-sun"
            }`}
          >
            {option}
          </button>
        );
      })}
    </div>
  );
}

/** Bambuddy's `rgba` comes back as e.g. "EBF1E0FF" — no leading `#`. */
function swatchColor(rgba: string | null): string {
  return rgba ? `#${rgba.replace(/^#/, "")}` : "#b6bcc2";
}

export function UploadForm({ owner, spools }: { owner: string; spools: Spool[] }) {
  const [quantity, setQuantity] = useState(1);
  const [spoolId, setSpoolId] = useState<number | "">(spools[0]?.id ?? "");
  const [submitting, setSubmitting] = useState(false);

  return (
    <form
      action={createStory}
      onSubmit={() => setSubmitting(true)}
      className="max-w-[780px]"
    >
      {/* ---- the link ---- */}
      <div>
        <Label htmlFor="modelUrl">Paste the model link</Label>
        <input
          id="modelUrl"
          name="modelUrl"
          required
          maxLength={2000}
          placeholder="https://makerworld.com/en/models/..."
          className="w-full rounded-card border-[3px] border-ink bg-porcelain px-[15px] py-[12px] font-mono text-[15px] text-ink placeholder:text-ink-3"
        />
      </div>

      {/* ---- title ---- */}
      <div className="mt-[22px]">
        <Label htmlFor="title">What is it?</Label>
        <input
          id="title"
          name="title"
          required
          maxLength={120}
          placeholder="Hook for the monitor arm"
          className="w-full rounded-card border-[3px] border-ink bg-porcelain px-[15px] py-[12px] text-[16px] text-ink placeholder:text-ink-3"
        />
      </div>

      {/* ---- quantity ---- */}
      <div className="mt-[22px] max-w-[320px]">
        <Label htmlFor="quantity-other">How many do you need?</Label>
        <Segmented
          label="Quantity"
          mono
          options={QUANTITY_PRESETS}
          value={QUANTITY_PRESETS.includes(quantity as never) ? quantity : 0}
          onChange={setQuantity}
        />
        <div className="mt-[8.8px] flex items-center gap-[8.8px]">
          <label htmlFor="quantity-other" className="font-mono text-[11.5px] uppercase tracking-[0.06em] text-ink-3">
            or type a number
          </label>
          <input
            id="quantity-other"
            name="quantity"
            type="number"
            min={1}
            max={24}
            value={quantity}
            onChange={(e) => setQuantity(Math.max(1, Number(e.target.value) || 1))}
            className="w-[80px] rounded-card border-[3px] border-ink bg-porcelain px-[10px] py-[6px] font-mono text-[14px] font-bold tabular-nums text-ink"
          />
        </div>
      </div>

      {/* ---- colour, live from Bambuddy's own inventory ---- */}
      <fieldset className="mt-[22px] border-0 p-0">
        <legend className="mb-[8.8px] font-mono text-[12px] font-bold uppercase tracking-[0.1em] text-ink-2">
          Colour — what&rsquo;s actually on the shelf
        </legend>
        {spools.length === 0 ? (
          <p className="m-0 rounded-card border-[3px] border-dashed border-ink-3 bg-cream-2 px-[15px] py-[12px] text-[14px] text-ink-2">
            Nothing in stock right now — check back once {owner} restocks.
          </p>
        ) : (
          <div className="flex flex-wrap gap-[13.2px]">
            {spools.map((s) => {
              const active = s.id === spoolId;
              return (
                <button
                  key={s.id}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  aria-label={`${s.color_name ?? "Unnamed"}, ${s.material}`}
                  onClick={() => setSpoolId(s.id)}
                  className="flex w-[92px] cursor-pointer flex-col items-center gap-[7px] border-0 bg-transparent p-0"
                >
                  <span
                    aria-hidden
                    className={`h-[48px] w-[48px] rounded-full border-[3px] border-ink transition-transform ${
                      active ? "scale-110 ring-[4px] ring-cherry-dk ring-offset-2 ring-offset-cream" : ""
                    }`}
                    style={{ background: swatchColor(s.rgba) }}
                  />
                  <span
                    className={`text-center font-mono text-[10.5px] font-bold uppercase leading-[1.2] tracking-[0.03em] ${
                      active ? "text-cherry-dk" : "text-ink-2"
                    }`}
                  >
                    {s.color_name ?? "Unnamed"}
                  </span>
                  <span className="text-center font-mono text-[9.5px] uppercase leading-[1.2] tracking-[0.03em] text-ink-3">
                    {s.material}
                  </span>
                </button>
              );
            })}
          </div>
        )}
        <input type="hidden" name="spoolId" value={spoolId} />
      </fieldset>

      {/* ---- needed by (optional) ---- */}
      <div className="mt-[22px] max-w-[220px]">
        <Label htmlFor="neededBy">Needed by (optional)</Label>
        <input
          id="neededBy"
          name="neededBy"
          type="date"
          className="w-full rounded-card border-[3px] border-ink bg-porcelain px-[15px] py-[10px] text-[15px] text-ink"
        />
      </div>

      {/* ---- note ---- */}
      <div className="mt-[22px]">
        <Label htmlFor="note">Anything {owner} should know</Label>
        <textarea
          id="note"
          name="note"
          rows={3}
          maxLength={2000}
          placeholder="No rush — needs to survive a bit of pulling."
          className="w-full resize-y rounded-card border-[3px] border-ink bg-porcelain px-[15px] py-[12px] text-[16px] text-ink placeholder:text-ink-3"
        />
      </div>

      {/* ---- actions ---- */}
      <div className="mt-[26.4px] flex flex-wrap items-center gap-[13.2px]">
        <Button type="submit" disabled={!spoolId || submitting} className="px-[30px]">
          {submitting ? "Sending…" : `Send it to ${owner}`}
        </Button>
        {submitting && (
          <span className="font-mono text-[11.5px] uppercase tracking-[0.06em] text-ink-3">
            Resolving and slicing — this can take a little while.
          </span>
        )}
      </div>
    </form>
  );
}
