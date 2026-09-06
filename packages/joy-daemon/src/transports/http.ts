// HTTP transport: a node:http router generated from the operation catalog,
// plus the debug-page extras that aren't operations (static HTML, SSE event
// stream). Localhost-only; mutating routes require the per-instance token
// printed at startup (H3: blocks drive-by cross-origin POSTs).
//
// Every catalog op is reachable here — same handlers the relay RPCs use, so
// the two surfaces cannot drift.

import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { readFileSync } from "fs";
import { join } from "path";
import { machineOps, sessionOps, type HttpMethod, type MachineOp, type SessionOp } from "../domain/operations";
import { DirectoryCreationApprovalRequired, type SessionRegistry } from "../domain/registry";
import { sessionRecords, latestRecordSeq, subscribeRecords } from "../relay/relay";
import { buildOpenApiSpec } from "./openapi";
import { handleV2 } from "./v2";
import { boundedWriter } from "../domain/bounded";

/** Pending bytes one long-lived event client may hold before it is dropped
 *  (#597). res.write() queues without limit, so a client that stopped reading
 *  grew the daemon's memory with every broadcast. Sessions can emit MBs in a
 *  burst, so the bound is generous; a client this far behind is not reading. */
const EVENT_CLIENT_MAX_BUFFERED_BYTES = 8 * 1024 * 1024;
/** How long the opening-history flush waits for a stalled socket to drain
 *  before the client is dropped (Astra on #597, Wave B). */
const EVENT_HISTORY_DRAIN_DEADLINE_MS = 10_000;
/** Largest single socket write during the opening-history flush. One history
 *  ITEM can be the whole serialized chat (12 MiB in the #597 reproduction):
 *  written in one res.write() it sits in the response buffer entire before
 *  any drain check, so the advertised pending-bytes bound held for every
 *  item but the first (Astra on 4a69e55c). Items are ENCODED into byte
 *  chunks of this size — whole characters only, so the stream and its
 *  SSE/NDJSON framing arrive unchanged. The encoding is incremental: a
 *  `Buffer.from(item)` of the whole frame, then sliced, kept the entire
 *  12 MiB backing store alive behind every pending 64 KiB slice while a
 *  stalled response awaited drain (Astra on b2aa492d) — now no more than
 *  one chunk plus one history item is resident per stream. */
const EVENT_HISTORY_WRITE_CHUNK_BYTES = 64 * 1024;

/**
 * Frame an SSE event whose data is a JSON array, one element at a time. The
 * bytes are exactly `event: <name>\ndata: ${JSON.stringify([...items])}\n\n`,
 * but no whole-array string is ever built: the /events opening `history`
 * frame is the largest allocation on this surface (12 MiB for a full chat),
 * and building it per client, per connect, is what the incremental encoder
 * in streamHistoryThenFollow is there to avoid (#597 residual).
 */
export function* sseJsonArrayEvent(event: string, items: Iterable<unknown>): Generator<string> {
  yield `event: ${event}\ndata: [`;
  let first = true;
  for (const item of items) {
    yield (first ? "" : ",") + (JSON.stringify(item) ?? "null");
    first = false;
  }
  yield "]\n\n";
}

/**
 * Stream a long-lived event response: the opening history first, with REAL
 * backpressure, then live records through the bounded writer.
 *
 * The first #597 fix routed the history through boundedWriter synchronously.
 * That bound is a pending-bytes cap, and a legitimate 12 MiB history (192
 * records of 64 KiB — within the record-count limits) exceeds it in one
 * synchronous loop before the socket has flushed a single byte: a FAST reader
 * was destroyed before receiving any body (Astra, Wave B). The history is now
 * written one item at a time; whenever res.write() reports a full buffer the
 * loop awaits 'drain' — a reading client receives everything, a non-reading
 * one is dropped when the drain deadline passes. Live records that arrive
 * during the flush are buffered (bounded by the same cap) so none are lost,
 * then handed over to the bounded writer once the history is on the wire.
 */
export async function streamHistoryThenFollow(opts: {
  res: ServerResponse;
  history: Iterable<string>;
  /** Live-record source; null for a one-shot (non-follow) response. */
  subscribe: ((fn: (chunk: string) => void) => () => void) | null;
  label: string;
  drainDeadlineMs?: number;
  maxBufferedBytes?: number;
  historyChunkBytes?: number;
}): Promise<void> {
  const { res, label } = opts;
  const maxBytes = opts.maxBufferedBytes ?? EVENT_CLIENT_MAX_BUFFERED_BYTES;
  const drainMs = opts.drainDeadlineMs ?? EVENT_HISTORY_DRAIN_DEADLINE_MS;
  // ≥ 4: the widest UTF-8 sequence must fit an empty chunk, else no progress.
  const chunkBytes = Math.max(4, opts.historyChunkBytes ?? EVENT_HISTORY_WRITE_CHUNK_BYTES);
  let unsubscribe: () => void = () => {};
  const drop = (why: string) => {
    unsubscribe();
    process.stderr.write(`[http] ${label} client ${why} — dropped\n`);
    try { res.destroy(); } catch { /* already closed */ }
  };
  // Subscribe FIRST (buffering) so nothing published while the history is on
  // the wire is lost; the caller computed `history` synchronously before this
  // call, so every buffered record is newer than it.
  const buffered: string[] = [];
  let bufferedBytes = 0;
  let live: (chunk: string) => void = (chunk) => {
    bufferedBytes += Buffer.byteLength(chunk);
    if (bufferedBytes > maxBytes) { drop(`fell behind by more than ${maxBytes} bytes during the history flush`); return; }
    buffered.push(chunk);
  };
  if (opts.subscribe) {
    unsubscribe = opts.subscribe((chunk) => live(chunk));
    res.on("close", () => unsubscribe());
  }
  const drained = (): Promise<boolean> => new Promise((resolve) => {
    const timer = setTimeout(() => { cleanup(); resolve(false); }, drainMs);
    const ok = () => { cleanup(); resolve(true); };
    const gone = () => { cleanup(); resolve(false); };
    const cleanup = () => { clearTimeout(timer); res.off("drain", ok); res.off("close", gone); res.off("error", gone); };
    res.on("drain", ok); res.on("close", gone); res.on("error", gone);
  });
  // Bounded writes: the history is UTF-8 encoded straight into fixed-size
  // chunks (whole characters only — encodeInto never splits a surrogate pair
  // or a multi-byte sequence), each chunk a drain checkpoint, so the pending
  // bytes never exceed the socket's high-water mark plus one chunk — whatever
  // an item's size. Each chunk is its own allocation (never the shared pool,
  // never a slice of a whole-frame buffer): what a pending write retains is
  // that chunk and nothing more.
  const encoder = new TextEncoder();
  let chunk = Buffer.allocUnsafeSlow(chunkBytes);
  let filled = 0;
  // Send the filled chunk; false → this response is over (destroyed, or it
  // did not drain in time and was dropped).
  const flush = async (): Promise<boolean> => {
    if (filled === 0) {
      if (res.destroyed) { unsubscribe(); return false; }
      return true;
    }
    const out = chunk.subarray(0, filled);
    chunk = Buffer.allocUnsafeSlow(chunkBytes);
    filled = 0;
    if (res.destroyed) { unsubscribe(); return false; }
    if (!res.write(out)) {
      if (!(await drained())) {
        if (!res.destroyed) drop(`did not drain the opening history within ${drainMs}ms`);
        else unsubscribe();
        return false;
      }
    }
    return true;
  };
  for (const item of opts.history) {
    let pos = 0;
    while (pos < item.length) {
      const { read, written } = encoder.encodeInto(pos === 0 ? item : item.slice(pos), chunk.subarray(filled));
      pos += read;
      filled += written;
      // Chunk full (or the next character does not fit its remainder): ship it.
      if (pos < item.length && !(await flush())) return;
    }
  }
  if (!(await flush())) return;
  if (!opts.subscribe) { res.end(); return; }
  // Hand over: what arrived meanwhile, then live records, all bounded.
  const write = boundedWriter(res, maxBytes, () => {
    unsubscribe();
    process.stderr.write(`[http] ${label} client exceeded ${maxBytes} pending bytes — dropped\n`);
  });
  for (const chunk of buffered) write(chunk);
  buffered.length = 0;
  live = write;
}

interface CompiledRoute {
  method: HttpMethod;
  regex: RegExp;
  paramNames: string[];
  op: MachineOp | SessionOp;
}

function compilePath(path: string): { regex: RegExp; paramNames: string[] } {
  const paramNames: string[] = [];
  const pattern = path
    .split("/")
    .map(seg => {
      if (seg.startsWith(":")) {
        paramNames.push(seg.slice(1));
        return "([^/]+)";
      }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("/");
  return { regex: new RegExp(`^${pattern}$`), paramNames };
}

// Collect a request body and parse it as JSON. Empty / non-JSON bodies resolve
// to undefined (matches the Bun version's swallow-on-parse-error behavior).
let versionMemo: string | null = null;
function daemonVersion(): string {
  if (!versionMemo) {
    try {
      versionMemo = String(JSON.parse(readFileSync(join(import.meta.dirname, "../../package.json"), "utf-8")).version ?? "0.0.0");
    } catch {
      versionMemo = "0.0.0";
    }
  }
  return versionMemo;
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  // 10MB cap: unbounded accumulation into a string let any local process OOM
  // the daemon (which holds live sessions) with one giant POST body.
  const MAX_BODY = 10 * 1024 * 1024;
  return new Promise(resolve => {
    // Collect BYTES and decode once: `data += chunk` stringified each Buffer
    // on its own, so a multi-byte character split across arrivals became
    // U+FFFD (#62 family; Astra on da868c80).
    const parts: Buffer[] = [];
    let size = 0;
    let overflow = false;
    req.on("data", (chunk: Buffer) => {
      if (overflow) return;
      parts.push(chunk); size += chunk.length;
      if (size > MAX_BODY) { overflow = true; parts.length = 0; req.destroy(); resolve(undefined); }
    });
    req.on("end", () => { if (!overflow) { try { resolve(JSON.parse(Buffer.concat(parts).toString("utf8"))); } catch { resolve(undefined); } } });
    req.on("error", () => resolve(undefined));
  });
}

export function startHttpServer(opts: {
  registry: SessionRegistry;
  port: number;
  publicDir: string;
  token: string;
  /** Fires with the BOUND port once listening — the daemon uses this to write
   *  the real port into daemon.json when it asked for a dynamic one (port 0). */
  onListening?: (port: number) => void;
  /** Tests: shorten the history drain deadline / buffered-bytes cap. */
  eventStream?: { drainDeadlineMs?: number; maxBufferedBytes?: number; historyChunkBytes?: number };
}): ReturnType<typeof createServer> {
  const { registry, port, publicDir, token, onListening } = opts;
  const eventStream = opts.eventStream ?? {};

  const routes: CompiledRoute[] = [];
  for (const op of machineOps) {
    const { regex, paramNames } = compilePath(op.http.path);
    routes.push({ method: op.http.method, regex, paramNames, op });
  }
  for (const op of sessionOps) {
    if (!op.http) continue;
    const { regex, paramNames } = compilePath(op.http.path);
    routes.push({ method: op.http.method, regex, paramNames, op });
  }

  const allowedOrigins = new Set([
    `http://localhost:${port}`,
    `http://127.0.0.1:${port}`,
  ]);

  const server = createServer(async (req, res) => {
    const method = (req.method ?? "GET") as string;
    // A malformed request target (`GET http://[ HTTP/1.1`) made `new URL`
    // throw before the try below — an unhandled rejection that killed the
    // whole daemon, from an unauthenticated local client (issue #80).
    let url: URL;
    try { url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`); }
    catch { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "bad request target" })); return; }
    const origin = (req.headers.origin as string | undefined) ?? "";

    const corsHeaders: Record<string, string> = {
      "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-Joy-Token",
    };
    // Only echo back known origins; unknown origins get no ACAO header (blocks reads)
    if (allowedOrigins.has(origin)) {
      corsHeaders["Access-Control-Allow-Origin"] = origin;
    }

    const send = (status: number, headers: Record<string, string>, body?: string) => {
      res.writeHead(status, headers);
      res.end(body);
    };
    const html = (file: string) => {
      let body: string;
      try {
        body = readFileSync(join(publicDir, file), "utf-8");
      } catch {
        // Missing static asset must not crash the daemon — 404 instead of throwing.
        return send(404, { ...corsHeaders, "Content-Type": "text/plain; charset=utf-8" }, "not found");
      }
      return send(200, { ...corsHeaders, "Content-Type": "text/html; charset=utf-8" }, body);
    };
    const json = (data: unknown, status = 200) =>
      send(status, { ...corsHeaders, "Content-Type": "application/json" }, JSON.stringify(data));

    try {
    if (method === "OPTIONS") return send(204, corsHeaders);

    // DNS-rebinding defense: a hostile page whose DNS flips to 127.0.0.1 makes
    // SAME-ORIGIN requests (no CORS involved) — but it necessarily carries its
    // own Host header. Reject anything not addressed to localhost, closing
    // unauthenticated GET exfiltration (/sessions/:id/log serves the full
    // transcript; /events streams chat history) while keeping the debug pages
    // browser-loadable via localhost.
    const host = String(req.headers.host ?? "").replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
    if (host !== "localhost" && host !== "127.0.0.1" && host !== "::1") {
      return json({ error: "forbidden host" }, 403);
    }

    // Token check on all mutating routes (PUT/PATCH exist on the v2 surface only)
    if (method === "POST" || method === "DELETE" || method === "PUT" || method === "PATCH") {
      if (req.headers["x-joy-token"] !== token) return json({ error: "unauthorized" }, 401);
    }

    // v2 machine-plane surface — additive, dispatched before the v1 catalog.
    if (url.pathname === "/v2" || url.pathname.startsWith("/v2/")) {
      if (await handleV2({ registry, method, url, req, res, corsHeaders })) return;
    }

    // OpenAPI dump of the operation catalog — keyed even though it's a GET
    // (the API surface itself is not public information). Accepts the header,
    // a bearer, or ?token= (browser URLs can't set headers; localhost-only +
    // per-instance token makes the query form acceptable here).
    const openApiAuthed = () => {
      const bearer = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
      return req.headers["x-joy-token"] === token || bearer === token || url.searchParams.get("token") === token;
    };
    if (method === "GET" && url.pathname === "/openapi.json") {
      if (!openApiAuthed()) return json({ error: "unauthorized" }, 401);
      const addr = server.address();
      const boundPort = addr && typeof addr === "object" ? addr.port : port;
      return json(buildOpenApiSpec({ port: boundPort, version: daemonVersion() }));
    }
    // Browsable API docs: /docs renders the spec with Redoc (CDN script — the
    // page runs in the user's browser, which can reach the CDN). The spec is
    // EMBEDDED in the page (#596): it used to be fetched from
    // `/openapi.json?token=<query token>`, so a request authenticated by the
    // X-Joy-Token header or a bearer got a 200 page whose spec request
    // carried an empty token and 401'd — the docs never rendered. Embedding
    // means whichever credential opened the page is the one that counts.
    if (method === "GET" && url.pathname === "/docs") {
      if (!openApiAuthed()) return json({ error: "unauthorized" }, 401);
      const addr = server.address();
      const boundPort = addr && typeof addr === "object" ? addr.port : port;
      // `<` is escaped so a `</script>` inside a description cannot end the
      // inline script; U+2028/2029 are JSON-legal but not JS-legal in strings.
      const specJs = JSON.stringify(buildOpenApiSpec({ port: boundPort, version: daemonVersion() }))
        .replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
      const page = `<!doctype html><html><head><title>joy-daemon API</title>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{margin:0}</style></head><body>
<div id="redoc"></div>
<script src="https://cdn.redoc.ly/redoc/latest/bundles/redoc.standalone.js"></script>
<script>Redoc.init(${specJs}, {}, document.getElementById("redoc"));</script>
</body></html>`;
      return send(200, { ...corsHeaders, "Content-Type": "text/html; charset=utf-8" }, page);
    }

    // ── Debug-page extras (not operations) ──────────────────────────────

    if (method === "GET" && url.pathname === "/") return html("index.html");
    if (method === "GET" && /^\/session\/[^/]+$/.test(url.pathname)) return html("session.html");
    if (method === "GET" && /^\/session\/[^/]+\/screenshot$/.test(url.pathname)) return html("screenshot.html");

    // Per-session record stream (joy events / wait / ask): NDJSON, history
    // first (?after=<seq> or ?last=<n>), then live records while ?follow=1.
    // Each line: { seq, at, record, localId? }; the first line is
    // { hello: true, seq } so a follower knows where history ended.
    const evm = method === "GET" ? url.pathname.match(/^\/sessions\/([^/]+)\/events$/) : null;
    if (evm) {
      const sid = decodeURIComponent(evm[1]);
      if (!registry.get(sid)) return json({ error: "session_not_found" }, 404);
      const after = url.searchParams.has("after") ? Number(url.searchParams.get("after")) : undefined;
      const last = url.searchParams.has("last") ? Number(url.searchParams.get("last")) : undefined;
      const follow = url.searchParams.get("follow") === "1";
      res.writeHead(200, { ...corsHeaders, "Content-Type": "application/x-ndjson", "Cache-Control": "no-cache", "X-Accel-Buffering": "no" });
      const history = sessionRecords(sid, { after, last });
      const upTo = latestRecordSeq(sid);
      // History with backpressure, then live records through the bound
      // (#597; Astra on da868c80 and Wave B) — see streamHistoryThenFollow.
      const lines = (function* () {
        yield JSON.stringify({ hello: true, seq: upTo }) + "\n";
        for (const r of history) yield JSON.stringify(r) + "\n";
      })();
      await streamHistoryThenFollow({
        res, history: lines, label: `/sessions/${sid}/events`, ...eventStream,
        subscribe: follow ? (fn) => subscribeRecords(sid, (r) => fn(JSON.stringify(r) + "\n")) : null,
      });
      return;
    }
    if (method === "GET" && url.pathname === "/events") {
      res.writeHead(200, {
        ...corsHeaders,
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      });
      // The opening history is the largest write of all: streamed with
      // backpressure, then live events through the bound (#597, Wave B).
      // The chat rows are framed one record at a time (sseJsonArrayEvent):
      // the whole-array string was a 12 MiB allocation per connecting client.
      const opening = (function* () {
        yield* sseJsonArrayEvent("history", registry.chatHistory());
        yield `event: sessions_history\ndata: ${JSON.stringify(registry.list().map(s => s.toJSON()))}\n\n`;
      })();
      await streamHistoryThenFollow({
        res, history: opening, label: "/events", ...eventStream,
        subscribe: (fn) => registry.subscribeSse((s) => fn(s)),
      });
      return;
    }

    // ── Catalog routes ──────────────────────────────────────────────────

    for (const route of routes) {
      if (route.method !== method) continue;
      const match = url.pathname.match(route.regex);
      if (!match) continue;

      // Params: path captures + query string + JSON body (POST).
      const params: Record<string, unknown> = {};
      for (const [k, v] of url.searchParams) params[k] = v;
      if (method === "POST") {
        const body = await readJsonBody(req);
        if (body && typeof body === "object") Object.assign(params, body);
      }
      route.paramNames.forEach((name, i) => { params[name] = match[i + 1]; });

      try {
        if (route.op.scope === "machine") {
          const result = await route.op.handler(registry, params, { via: "http" });
          if (route.op.httpShape) {
            const shaped = route.op.httpShape(result);
            return json(shaped.body, shaped.status);
          }
          return json(result);
        }
        // Session-scoped: resolve the session from :id.
        const session = registry.get(String(params.id ?? ""));
        if (!session) return json({ error: "session_not_found" }, 404);
        const result = await route.op.handler(session, params);
        return json(result);
      } catch (e) {
        if (e instanceof DirectoryCreationApprovalRequired) {
          return json({ error: "dir_not_found", cwd: e.directory }, 422);
        }
        return json({ error: String(e) }, 500);
      }
    }

    return send(404, corsHeaders, "not found");
    } catch (e) {
      // Belt-and-suspenders: no single request may take the daemon down. Log
      // and 500 if the response hasn't started yet.
      process.stderr.write(`[http] request error: ${e}\n`);
      if (!res.headersSent) {
        try { send(500, { ...corsHeaders, "Content-Type": "application/json" }, JSON.stringify({ error: String(e) })); } catch { /* response already gone */ }
      }
    }
  });

  // Disable the idle-socket timeout so long-lived SSE (/events) responses
  // aren't dropped (the Bun version used idleTimeout: 0). Leave requestTimeout
  // and headersTimeout at their defaults — SSE is a long *response*, not a long
  // *request*, so those don't threaten it but do guard stuck request bodies.
  server.timeout = 0;
  // Belt-and-suspenders to the pidfile lock: if the port is already taken
  // (another daemon, or an unrelated process), exit cleanly instead of crashing
  // with an uncaught EADDRINUSE.
  server.on("error", (e: NodeJS.ErrnoException) => {
    if (e.code === "EADDRINUSE") {
      process.stderr.write(`[server] port ${port} already in use — another daemon? exiting.\n`);
      process.exit(1);
    }
    throw e;
  });
  server.listen(port, "127.0.0.1", () => {
    const addr = server.address();
    if (onListening && addr && typeof addr === "object") onListening(addr.port);
  });
  return server;
}
