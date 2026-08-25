// Client half of the tunnel: seal an HTTP request, POST it to the relay's
// /joy/v1/daemons/{machineId}/http, unseal the streamed response. This is
// what `joy --machine <id>` will use, and the reference implementation for
// the app's version (libsodium crypto_aead_chacha20poly1305_ietf pairs with
// the node:crypto AEAD in sealedStream.ts).
import { deriveTunnelKey } from "./sealedStream";
import { sealRequest, StreamingOpen, concatAll, type ResponseHead } from "./wire";

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
 *  arrives inside the envelope. */
export class TunnelError extends Error {
  constructor(public status: number, public code: string) {
    super(`tunnel: ${status} ${code}`);
    this.name = "TunnelError";
  }
}

export async function tunnelFetch(opts: TunnelFetchOpts): Promise<TunnelResponse> {
  const key = deriveTunnelKey(opts.masterSecret, opts.machineId);
  const wire = sealRequest(key, { m: opts.method, p: opts.path, h: opts.headers ?? {} }, opts.body ?? new Uint8Array(0));

  const entry = opts.entryBase ?? "/joy/v1/daemons";
  // entryBase is a PATH, never an authority: raw concatenation would let
  // "@evil.example/x" rehost the URL and leak the account bearer there.
  if (!/^\/[A-Za-z0-9/._-]*$/.test(entry)) throw new Error(`invalid entryBase: ${entry}`);
  const r = await fetch(`${opts.relayUrl}${entry}/${encodeURIComponent(opts.machineId)}/http`, {
    method: "POST",
    headers: { authorization: `Bearer ${opts.accountToken}`, "content-type": "application/octet-stream" },
    body: wire as any,
  });
  if (r.headers.get("content-type")?.includes("application/json")) {
    // Relay-level rejection (daemon_offline, 403, timeout) — NOT a daemon answer.
    const j = await r.json().catch(() => ({ error: "relay_error" })) as { error?: string };
    throw new TunnelError(r.status, j.error ?? "relay_error");
  }
  if (!r.ok || !r.body) throw new TunnelError(r.status, "relay_error");

  const open = new StreamingOpen<ResponseHead>(key);
  const chunks: Uint8Array[] = [];
  const reader = r.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const c of open.feed(value as Uint8Array)) {
      chunks.push(c);
      opts.onChunk?.(c);
    }
  }
  open.finish(); // throws TamperError on truncation/tamper — never a silent partial
  if (open.head === null) throw new TunnelError(502, "empty_response");
  return { status: open.head.s, headers: open.head.h, body: concatAll(chunks) };
}
