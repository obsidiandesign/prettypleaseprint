/**
 * A minimal stand-in for a Bambuddy instance, for suites that need to drive
 * real wiring (an actual HTTP round trip through src/lib/bambuddy.ts)
 * without a live Bambuddy to talk to.
 *
 * Unconfigured routes answer 503 — the same shape a real, unreachable
 * Bambuddy would leave the app seeing, and the one case intake is already
 * built to retry rather than fail on. Configure only the routes a given
 * check actually needs.
 */
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

export type FakeResponse = { status: number; body?: unknown };
export type FakeRoute = (parsed: { body: string; url: URL }) => FakeResponse | Promise<FakeResponse>;

export type FakeBambuddy = {
  url: string;
  apiKey: string;
  /** Requests received so far, in order — for asserting Bambuddy was actually called. */
  calls: { method: string; path: string }[];
  set(method: string, path: string, handler: FakeRoute): void;
  clear(method: string, path: string): void;
  stop(): Promise<void>;
};

export async function startFakeBambuddy(): Promise<FakeBambuddy> {
  const routes = new Map<string, FakeRoute>();
  const calls: { method: string; path: string }[] = [];

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      void handle(req, Buffer.concat(chunks).toString("utf8"));
    });

    async function handle(request: IncomingMessage, body: string) {
      const url = new URL(request.url ?? "/", "http://fake-bambuddy");
      const method = request.method ?? "GET";
      calls.push({ method, path: url.pathname });
      const handler = routes.get(`${method} ${url.pathname}`);
      if (!handler) {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ detail: `fake Bambuddy: no route configured for ${method} ${url.pathname}` }));
        return;
      }
      try {
        const result = await handler({ body, url });
        res.writeHead(result.status, { "content-type": "application/json" });
        res.end(result.body === undefined ? "" : JSON.stringify(result.body));
      } catch (error) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ detail: String(error) }));
      }
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    apiKey: "fake-bambuddy-test-key",
    calls,
    set(method, path, handler) {
      routes.set(`${method} ${path}`, handler);
    },
    clear(method, path) {
      routes.delete(`${method} ${path}`);
    },
    stop() {
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
