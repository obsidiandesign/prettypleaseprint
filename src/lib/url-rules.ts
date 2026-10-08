/**
 * URL-shape checks shared by the request forms — pure (no `server-only`, no
 * I/O), so they can be exercised directly rather than only through
 * stories.ts, which the real `server-only` package refuses to load outside
 * Next's own bundler (see scripts/verify-lib.ts).
 */

/**
 * True only for an absolute http(s) URL. `modelUrl` is rendered as an
 * `<a href>`, so anything else — `javascript:`, `data:` — is script waiting
 * for a click. The story page checks again before linking, which also covers
 * legacy rows whose link is the empty string.
 */
export function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

/**
 * A MakerWorld model page — the only kind of link intake can hand to
 * Bambuddy (`resolveMakerWorldUrl`). Anything else would fail to resolve on
 * every sync pass forever, so it's refused up front instead.
 */
export function isMakerWorldModelUrl(value: string): boolean {
  try {
    const { hostname, pathname } = new URL(value);
    const host = hostname.toLowerCase();
    const onMakerWorld = ["makerworld.com", "makerworld.com.cn"].some(
      (site) => host === site || host.endsWith(`.${site}`),
    );
    return onMakerWorld && /\/models\/\d+/.test(pathname);
  } catch {
    return false;
  }
}
