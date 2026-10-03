"use client";

import { useState, type FormEvent } from "react";

import { createStory } from "@/app/actions/stories";
import { QUANTITY_PRESETS } from "@/lib/catalog";
import { postWithProgress, uploadFailure } from "@/lib/upload-client";
import { Button, Label } from "@/components/ui";

const MAX_UPLOAD_MB = 100;

/** "Bracket v2 (snap fit).stl" -> "Bracket v2 (snap fit)" for the title. */
function titleFromFilename(name: string): string {
  return name.replace(/(\.gcode)?\.(stl|3mf)$/i, "").replace(/[_]+/g, " ").trim().slice(0, 120);
}

export type Spool = {
  id: number;
  material: string;
  color_name: string | null;
  rgba: string | null;
};

/** One owner-managed tip option, passed from the server (see upload/page.tsx). */
export type Benefit = { label: string; preferred: boolean };

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

export function UploadForm({
  owner,
  spools,
  benefits,
}: {
  owner: string;
  spools: Spool[];
  /** The tip jar's options, or `null` when the owner has it switched off. */
  benefits: Benefit[] | null;
}) {
  // Default to a preferred benefit if the owner has marked one, else the first
  // on the list, else none.
  const preferredLabels = (benefits ?? []).filter((b) => b.preferred).map((b) => b.label);
  const [tip, setTip] = useState(preferredLabels[0] ?? benefits?.[0]?.label ?? "");
  const [quantity, setQuantity] = useState(1);
  const [spoolId, setSpoolId] = useState<number | "">(spools[0]?.id ?? "");
  const [submitting, setSubmitting] = useState(false);
  // A MakerWorld link goes through the server action as before; a file goes
  // to the API with upload progress (see onSubmit).
  const [source, setSource] = useState<"link" | "file">("link");
  const [title, setTitle] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    if (source === "link") {
      setSubmitting(true); // the server action takes it from here
      return;
    }
    event.preventDefault();
    setUploadError(null);
    if (!file) return setUploadError("Choose an .stl or .3mf file first.");
    if (file.size > MAX_UPLOAD_MB * 1024 * 1024) {
      return setUploadError(`That file is over the ${MAX_UPLOAD_MB} MB limit.`);
    }
    setSubmitting(true);
    setProgress(0);
    const result = await postWithProgress("/api/stories", new FormData(event.currentTarget), setProgress);
    const story = result.json?.story as { id?: number } | undefined;
    if (result.status === 201 && story?.id) {
      window.location.assign(`/story/${story.id}?sent=1`);
      return;
    }
    setUploadError(uploadFailure(result));
    setSubmitting(false);
    setProgress(null);
  }

  return (
    <form
      action={createStory}
      onSubmit={onSubmit}
      encType={source === "file" ? "multipart/form-data" : undefined}
      className="max-w-[780px]"
    >
      {/* ---- where the model comes from ---- */}
      <div role="tablist" aria-label="Where the model comes from" className="mb-[17.6px] flex flex-wrap gap-[6px]">
        {([
          ["link", "Paste a MakerWorld link"],
          ["file", "Upload a file"],
        ] as const).map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={source === value}
            onClick={() => {
              setSource(value);
              setUploadError(null);
            }}
            className={`cursor-pointer rounded-chip border-[3px] border-ink px-[15px] py-[8px] font-mono text-[12.5px] font-bold uppercase tracking-[0.06em] transition-colors ${
              source === value ? "bg-cherry-dk text-cream" : "bg-porcelain text-ink hover:bg-sun"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {source === "link" ? (
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
      ) : (
        <div>
          <Label htmlFor="file">The model file</Label>
          <input
            id="file"
            name="file"
            type="file"
            required
            accept=".stl,.3mf,model/stl,model/3mf"
            onChange={(e) => {
              const chosen = e.target.files?.[0] ?? null;
              setFile(chosen);
              setUploadError(null);
              if (chosen && !title) setTitle(titleFromFilename(chosen.name));
            }}
            className="block w-full cursor-pointer rounded-card border-[3px] border-dashed border-ink bg-porcelain px-[15px] py-[14px] font-mono text-[14px] text-ink file:mr-[13px] file:cursor-pointer file:rounded-chip file:border-[3px] file:border-ink file:bg-sun file:px-[13px] file:py-[5px] file:font-mono file:text-[12px] file:font-bold file:uppercase"
          />
          <p className="m-0 mt-[8px] text-[13.5px] leading-[1.45] text-ink-3">
            An .stl or .3mf, up to {MAX_UPLOAD_MB} MB — from Printables, Thingiverse or anywhere.
            An STL goes to {owner} to prepare in Bambu Studio first; a 3MF project is sliced
            straight away.
          </p>
          <div className="mt-[17.6px]">
            <Label htmlFor="sourceLink">Where&rsquo;s it from? (optional)</Label>
            <input
              id="sourceLink"
              name="sourceLink"
              type="url"
              maxLength={2000}
              placeholder="https://www.printables.com/model/..."
              className="w-full rounded-card border-[3px] border-ink bg-porcelain px-[15px] py-[12px] font-mono text-[15px] text-ink placeholder:text-ink-3"
            />
          </div>
        </div>
      )}

      {/* ---- title ---- */}
      <div className="mt-[22px]">
        <Label htmlFor="title">What is it?</Label>
        <input
          id="title"
          name="title"
          required
          maxLength={120}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
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
        <p className="m-0 mb-[10px] text-[13.5px] leading-[1.45] text-ink-3">
          For the main part. If the model has more colours, you&rsquo;ll pick
          those on the ticket once it&rsquo;s been read.
        </p>
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

      {/* ---- the tip jar, when the owner has it on ---- */}
      {benefits && benefits.length > 0 && (
        <section
          aria-labelledby="tip-heading"
          className="mt-[26.4px] rounded-panel border-[3px] border-ink bg-aqua-wash p-[22px] shadow-stamp"
        >
          <h2 id="tip-heading" className="m-0 mb-[4px] font-display text-[22px] text-ink">
            And what&rsquo;s in it for {owner}?
          </h2>
          <p className="m-0 mb-[8px] text-[14.5px] text-ink-2">
            Optional. Nobody is counting. {owner} is counting a little.
          </p>
          {preferredLabels.length > 0 && (
            <p className="m-0 mb-[15px] font-mono text-[12px] font-bold uppercase tracking-[0.04em] text-cherry-dk">
              ★ {owner} currently prefers: {preferredLabels.join(", ")}
            </p>
          )}
          <div role="radiogroup" aria-labelledby="tip-heading" className="flex flex-wrap gap-[8.8px]">
            {benefits.map((b) => {
              const active = b.label === tip;
              return (
                <button
                  key={b.label}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => setTip(active ? "" : b.label)}
                  className={`stamp cursor-pointer rounded-chip border-[3px] border-ink px-[18px] py-[9px] text-[14px] font-bold transition-colors ${
                    active ? "bg-cherry-dk text-cream" : "bg-porcelain text-ink hover:bg-sun"
                  }`}
                >
                  {b.preferred && (
                    <span aria-label="preferred" title="Preferred">
                      ★{" "}
                    </span>
                  )}
                  {b.label}
                </button>
              );
            })}
          </div>
          <input type="hidden" name="tip" value={tip} />
        </section>
      )}

      {/* ---- actions ---- */}
      {uploadError && (
        <p role="alert" className="m-0 mt-[22px] rounded-card border-[3px] border-ink bg-cherry-wash px-[15px] py-[11px] text-[15px] text-cherry-dk">
          {uploadError}
        </p>
      )}
      <div className="mt-[26.4px] flex flex-wrap items-center gap-[13.2px]">
        <Button type="submit" disabled={!spoolId || submitting} className="px-[30px]">
          {submitting ? "Sending…" : `Send it to ${owner}`}
        </Button>
        {submitting && progress !== null && progress < 1 && (
          <span className="flex items-center gap-[10px] font-mono text-[11.5px] uppercase tracking-[0.06em] text-ink-3">
            <span
              role="progressbar"
              aria-label="Upload progress"
              aria-valuenow={Math.round(progress * 100)}
              aria-valuemin={0}
              aria-valuemax={100}
              className="inline-block h-[10px] w-[140px] overflow-hidden rounded-full border-2 border-ink bg-porcelain"
            >
              <span className="block h-full bg-sun" style={{ width: `${Math.round(progress * 100)}%` }} />
            </span>
            Uploading {Math.round(progress * 100)}%
          </span>
        )}
        {submitting && (progress === null || progress >= 1) && (
          <span className="font-mono text-[11.5px] uppercase tracking-[0.06em] text-ink-3">
            {source === "file" ? "Handing it to Bambuddy — a moment." : "Resolving and slicing — this can take a little while."}
          </span>
        )}
      </div>
    </form>
  );
}
