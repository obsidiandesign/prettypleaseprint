/**
 * The `check`/`section` pair every verify script writes by hand (see
 * verify-queue.ts). Pulled out once two more scripts wanted the exact same
 * ten lines — not a generic test framework, just the shared bookkeeping.
 */

export function makeCheck() {
  let passed = 0;
  const failures: string[] = [];
  function check(name: string, ok: boolean, detail = "") {
    console.info(`  ${ok ? "ok  " : "FAIL"}  ${name}${ok || !detail ? "" : `\n          ${detail}`}`);
    if (ok) passed++;
    else failures.push(name);
  }
  function summary(): number {
    console.info(
      `\n${passed} checks passed, ${failures.length} failed` +
        (failures.length ? `:\n  - ${failures.join("\n  - ")}` : ""),
    );
    return failures.length ? 1 : 0;
  }
  return { check, summary };
}

export const section = (t: string) =>
  console.info(`\n── ${t} ${"─".repeat(Math.max(0, 54 - t.length))}`);
