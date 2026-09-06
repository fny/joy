// Client half of the tunnel: seal an HTTP request, POST it to the relay's
// /joy/v2/machines/{machineId}/http, unseal the streamed response. This is
// what `joy --machine <id>` will use, and the reference implementation for
// the app's version (libsodium crypto_secretbox_easy on both ends — see
// sealedStream.ts for why secretbox).
import { deriveTunnelKey } from "./sealedStream";
import { sealRequest, StreamingOpen, concatAll, requestBinding, type ResponseHead } from "./wire";

export interface TunnelFetchOpts {
  relayUrl: string;
  accountToken: string;
  masterSecret: Uint8Array;
  machineId: string;
  method: string;
  path: string;                       // daemon-local, e.g. /sessions
  headers?: Record<string, string>;
  body?: Uint8Array;
  onChunk?: (chunk: Uint8Array) => void; // streaming consumers (SSE, large files)
  /** Relay entry route. Default: the v1 path; pass "/joy/v2/machines" for the
   *  v2 entry — the tunnel protocol behind either entry is identical. */
  entryBase?: string;
}

export interface TunnelResponse { status: number; headers: Record<string, string>; body: Uint8Array }

/** Relay-level failures (offline daemon, auth) surface as TunnelError with
 *  the relay's status — DISTINCT from sealed daemon responses, whose status
 *  arrives inside the envelope. `connection_slow` (502) is the one
 *  transport failure raised here: the sealed head arrived but the stream
 *  ended before its FINAL frame — the relay dropped a client that could not
 *  drain within its deadline (429 client_slow to the daemon), or the link
 *  died mid-body. It is NOT tamper: the bytes that did arrive verified. */
export class TunnelError extends Error {
  constructor(public status: number, public code: string) {
    super(`tunnel: ${status} ${code}`);
    this.name = "TunnelError";
  }
}

/** 503s that say "not now", not "not reachable": the relay-wide inbox budget
 *  (`relay_busy`) or this daemon's parked inbox (`daemon_busy`) is full. Both
 *  carry `retry-after`; both clear on their own as the daemon drains. Distinct
 *  from `daemon_offline`, which no wait fixes. */
export const RETRYABLE_RELAY_CODES = new Set(["relay_busy", "daemon_busy"]);
export const TUNNEL_MAX_ATTEMPTS = 3;
const RETRY_AFTER_DEFAULT_MS = 1_000;
const RETRY_AFTER_MAX_MS = 5_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** `retry-after` in ms (seconds form only, as the relay sends it), bounded. */
export function retryAfterMs(header: string | null | undefined): number {
  if (header === null || header === undefined || header.trim() === '') return RETRY_AFTER_DEFAULT_MS;
  const n = Number(header);
  if (!Number.isFinite(n) || n < 0) return RETRY_AFTER_DEFAULT_MS;
  return Math.min(RETRY_AFTER_MAX_MS, Math.round(n * 1000));
}

export async function tunnelFetch(opts: TunnelFetchOpts): Promise<TunnelResponse> {
  const key = deriveTunnelKey(opts.masterSecret, opts.machineId);
  const entry = opts.entryBase ?? "/joy/v2/machines";
  // entryBase is a PATH, never an authority: raw concatenation would let
  // "@evil.example/x" rehost the URL and leak the account bearer there.
  if (!/^\/[A-Za-z0-9/._-]*$/.test(entry)) throw new Error(`invalid entryBase: ${entry}`);
  const url = `${opts.relayUrl}${entry}/${encodeURIComponent(opts.machineId)}/http`;
  // Idempotent reads may be re-asked once after a cut stream; a write may
  // have executed on the daemon, so its truncation is surfaced as is.
  const idempotent = opts.method === "GET" || opts.method === "HEAD";
  let truncatedRetried = false;
  for (let attempt = 1; ; attempt++) {
    // Sealed per attempt: a fresh stream id and `t`, so a retry never looks
    // like a replay to the daemon's guard (replayGuard.ts) and the clock the
    // daemon checks is the one at send time.
    const wire = sealRequest(key, { m: opts.method, p: opts.path, h: opts.headers ?? {}, t: Date.now() }, opts.body ?? new Uint8Array(0));
    // fetch resolves as soon as the relay's HEADERS arrive — while the body
    // is still uploading — so an admission refusal (503 busy/offline, 413
    // over the declared size) is seen before the 32 MiB finishes.
    const r = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${opts.accountToken}`, "content-type": "application/octet-stream" },
      body: wire as any,
    });
    if (r.headers.get("content-type")?.includes("application/json")) {
      // Relay-level rejection (daemon_offline, 403, timeout) — NOT a daemon answer.
      const j = await r.json().catch(() => ({ error: "relay_error" })) as { error?: string };
      const code = j.error ?? "relay_error";
      if (r.status === 503 && RETRYABLE_RELAY_CODES.has(code) && attempt < TUNNEL_MAX_ATTEMPTS) {
        await sleep(retryAfterMs(r.headers.get("retry-after")));
        continue;
      }
      throw new TunnelError(r.status, code);
    }
    if (!r.ok || !r.body) throw new TunnelError(r.status, "relay_error");

    // The response must be bound to THIS request (head.r = our stream id) —
    // StreamingOpen throws TamperError on the head frame otherwise, before any
    // status or body is surfaced. A relay replaying a recorded response to a
    // different request therefore fails closed instead of reading as success.
    const open = new StreamingOpen<ResponseHead>(key, requestBinding(wire));
    const chunks: Uint8Array[] = [];
    const reader = r.body.getReader();
    let cut = false; // stream ended (or the socket died) after the head, before FINAL
    try {
      for (;;) {
        let step: Awaited<ReturnType<typeof reader.read>>;
        try { step = await reader.read(); }
        catch (e) { if (open.head !== null) { cut = true; break; } throw e; }
        if (step.done) break;
        for (const c of open.feed(step.value as Uint8Array)) {
          chunks.push(c);
          opts.onChunk?.(c);
        }
      }
    } finally { reader.cancel().catch(() => {}); }
    if (open.head !== null && !open.finished) cut = true;
    if (cut) {
      // Re-ask once — unless a streaming consumer already saw chunks it
      // would then see twice.
      if (idempotent && !truncatedRetried && (opts.onChunk === undefined || chunks.length === 0)) { truncatedRetried = true; continue; }
      throw new TunnelError(502, "connection_slow");
    }
    open.finish(); // throws TamperError on truncation/tamper — never a silent partial
    if (open.head === null) throw new TunnelError(502, "empty_response");
    return { status: open.head.s, headers: open.head.h, body: concatAll(chunks) };
  }
}
