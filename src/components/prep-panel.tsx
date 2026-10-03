"use client";

import { useState, type FormEvent } from "react";

import { postWithProgress, uploadFailure } from "@/lib/upload-client";

/**
 * The printer owner's side of "Needs prep": download the model, prepare it
 * in Bambu Studio, attach the result. A sliced `.gcode.3mf` (for this
 * printer) is queued exactly as it is; a project `.3mf` is sliced with its
 * settings. Uploads with progress, then reloads the ticket to show where it
 * landed.
 */
export function PrepPanel({ storyId, downloadName, error }: { storyId: number; downloadName: string; error: string | null }) {
  const [file, setFile] = useState<File | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const busy = progress !== null;

  async function attach(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file) return setProblem("Choose the prepared .3mf first.");
    setProblem(null);
    setProgress(0);
    const result = await postWithProgress(`/api/stories/${storyId}/prepared`, new FormData(event.currentTarget), setProgress);
    if (result.status === 200) {
      window.location.assign(`/story/${storyId}?toast=${encodeURIComponent("Prepared file attached")}`);
      return;
    }
    setProblem(uploadFailure(result));
    setProgress(null);
  }

  return (
    <div className="flex flex-col gap-[13.2px]">
      <p className="m-0 text-[14.5px] leading-[1.5] text-ink">
        Open the model in Bambu Studio, fix what it needs — supports, orientation, plates, colours —
        then attach the result: <strong>sliced for this printer</strong> (a <code>.gcode.3mf</code>, queued
        exactly as you sliced it) or the <strong>project</strong> (a <code>.3mf</code>, sliced here with its settings).
      </p>
      {error && (
        <p role="alert" className="m-0 rounded-card border-[3px] border-ink bg-cherry-wash px-[13px] py-[9px] text-[14px] text-cherry-dk">
          {error}
        </p>
      )}
      <div>
        <a
          href={`/api/stories/${storyId}/file`}
          download={downloadName}
          className="stamp inline-block rounded-chip border-[3px] border-ink bg-porcelain px-[15px] py-[8px] text-[14px] font-bold text-ink hover:bg-sun"
        >
          Download the model
        </a>
        <span className="ml-[10px] font-mono text-[11.5px] text-ink-3">{downloadName}</span>
      </div>
      <form onSubmit={attach} className="flex flex-wrap items-center gap-[10px] rounded-card border-[3px] border-ink bg-sun-wash p-[11px]">
        <label htmlFor={`prepared-${storyId}`} className="sr-only">
          The prepared file
        </label>
        <input
          id={`prepared-${storyId}`}
          name="file"
          type="file"
          accept=".3mf"
          required
          disabled={busy}
          onChange={(e) => {
            setFile(e.target.files?.[0] ?? null);
            setProblem(null);
          }}
          className="min-w-[220px] flex-1 font-mono text-[13px] text-ink file:mr-[10px] file:cursor-pointer file:rounded-chip file:border-[3px] file:border-ink file:bg-porcelain file:px-[11px] file:py-[4px] file:font-mono file:text-[12px] file:font-bold file:uppercase"
        />
        <button
          type="submit"
          disabled={busy}
          className="stamp cursor-pointer rounded-chip border-[3px] border-ink bg-cherry-dk px-[15px] py-[7px] text-[13.5px] font-bold text-cream disabled:cursor-not-allowed disabled:opacity-60"
        >
          {busy ? (progress! < 1 ? `Uploading ${Math.round(progress! * 100)}%` : "Handing it to Bambuddy…") : "Attach prepared file"}
        </button>
      </form>
      {problem && (
        <p role="alert" className="m-0 text-[14px] text-cherry-dk">
          {problem}
        </p>
      )}
    </div>
  );
}
