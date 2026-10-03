/**
 * Send a multipart form with upload progress, for the two places a model file
 * is uploaded: the order form and the printer owner's "attach prepared
 * file". `fetch` has no upload progress, so this is XHR — same origin, so the
 * session cookie and the API's Origin check both just work.
 *
 * Resolves with the status and parsed JSON either way; the API's refusals
 * arrive as `{ error }`, already written for a person.
 */
export function postWithProgress(
  url: string,
  body: FormData,
  onProgress: (fraction: number) => void,
): Promise<{ status: number; json: Record<string, unknown> | null }> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      let json: Record<string, unknown> | null = null;
      try {
        json = JSON.parse(xhr.responseText);
      } catch {
        // not JSON: an HTML error page from a proxy, most likely
      }
      resolve({ status: xhr.status, json });
    };
    xhr.onerror = () => resolve({ status: 0, json: null });
    xhr.send(body);
  });
}

/** What to tell a person when an upload didn't go through. */
export function uploadFailure(result: { status: number; json: Record<string, unknown> | null }): string {
  if (typeof result.json?.error === "string") return result.json.error;
  if (result.status === 0) return "The upload didn't reach the app — check your connection and try again.";
  if (result.status === 413) return "That file is too big to upload.";
  return `The upload failed (${result.status}). Try again in a moment.`;
}
