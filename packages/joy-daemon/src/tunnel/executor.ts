// Daemon-side tunnel executor: attaches to the relay nucleus (lease +
// long-poll), unseals incoming HTTP requests, dispatches them to the daemon's
// OWN local HTTP surface, and streams sealed responses back. This is the
// machine-plane transport of the v2 split — the daemon surface reached at
// /daemons/{machineId}/... on the relay.
//
// Dispatch is a real fetch against 127.0.0.1 rather than an in-process call:
// the local HTTP surface IS the contract (same code path the CLI hits), so
// tunneled and local requests cannot drift apart.
import { deriveTunnelKey, SealedWriter, CHUNK_MAX, TamperError } from "./sealedStream";
import { openHeadAndBody, requestBinding, type RequestHead, type ResponseHead } from "./wire";

export interface ExecutorOpts {
  relayUrl: string;            // nucleus base, e.g. http://127.0.0.1:PORT
  accountToken: string;        // bearer for lease acquisition
  machineKey: Uint8Array;      // per-machine key (access.key machineKey) → tunnel key
  /** Borrow the nucleus lane's lease instead of acquiring a competing one.
   *  acquireLease RELEASES any prior lease for the machine, so two acquirers
   *  on one machineId evict each other in a loop (observed live: the lane and
   *  this executor ping-ponging, lease epoch climbing forever). When this is
   *  provided the executor never calls acquire. */
  borrowLease?: () => { leaseId: string; leaseToken: string } | null;
  machineId: string;           // daemon identity (lease daemon_id)
  targetBase: string;          // local surface, e.g. http://127.0.0.1:4997
  targetHeaders?: Record<string, string>; // e.g. X-Joy-Token for the local API
  log?: (line: string) => void;
}

export interface ExecutorHandle { stop(): Promise<void>; leaseId: () => string | null }

/** Blocked hop-by-hop / transport headers — the daemon-side fetch and the
 *  client re-add their own. Everything else passes through sealed. */
const STRIP = new Set(["host", "connection", "content-length", "transfer-encoding", "keep-alive", "upgrade"]);

export function startTunnelExecutor(opts: ExecutorOpts): ExecutorHandle {
  const log = opts.log ?? (() => {});
  const key = deriveTunnelKey(opts.machineKey, opts.machineId);
  let stopped = false;
  let lease: { id: string; token: string } | null = null;
  let renewTimer: ReturnType<typeof setInterval> | null = null;

  async function acquire(): Promise<void> {
    const r = await fetch(`${opts.relayUrl}/joy/v2/daemon/leases`, {
      method: "POST",
      headers: { authorization: `Bearer ${opts.accountToken}`, "content-type": "application/json" },
      body: JSON.stringify({ machineId: opts.machineId, capabilities: { tunnel: 1 } }),
    });
    if (!r.ok) throw new Error(`lease acquire failed: ${r.status} ${await r.text()}`);
    const j = await r.json() as { leaseId: string; leaseToken: string; ttlSeconds: number };
    lease = { id: j.leaseId, token: j.leaseToken };
    // Renew at half TTL — a missed beat expires the lease and 412s the loops,
    // which we treat as "re-acquire", not as fatal.
    if (renewTimer) clearInterval(renewTimer);
    renewTimer = setInterval(() => {
      if (opts.borrowLease) return; // the nucleus lane renews the lease it owns
      void fetch(`${opts.relayUrl}/joy/v2/daemon/leases/${lease!.id}`, {
        method: "PUT", headers: { "x-joy-lease-token": lease!.token },
      }).catch(() => {});
    }, Math.max(2, j.ttlSeconds / 2) * 1000);
  }

  async function execute(requestId: string, payloadB64: string): Promise<void> {
    const postFrames = async (bytes: Uint8Array, done: boolean) => {
      const r = await fetch(`${opts.relayUrl}/joy/v2/daemon/tunnel/${requestId}/frames${done ? "?done=1" : ""}`, {
        method: "POST",
        headers: (() => {
          const l = activeLease();
          if (!l) throw new Error("no lease for frame post");
          return { "x-joy-lease-id": l.id, "x-joy-lease-token": l.token, "content-type": "application/octet-stream" };
        })(),
        body: bytes as any,
      });
      if (!r.ok) throw new Error(`frames post failed: ${r.status}`);
    };

    const payload = Buffer.from(payloadB64, "base64");
    // Every response head names the request it answers (wire.ts: binding) —
    // the client refuses a response bound to any other request, so a relay
    // cannot answer request B with the bytes it recorded for request A.
    const r = requestBinding(payload);
    let head: RequestHead, body: Uint8Array;
    try {
      ({ head, body } = openHeadAndBody<RequestHead>(key, payload));
    } catch (e) {
      // Unsealable request (wrong client key, corrupted in transit): answer
      // sealed with OUR key so a legitimate client still gets a readable 400;
      // an illegitimate one learns nothing it could not already infer.
      const w = new SealedWriter(key);
      const headBytes = new TextEncoder().encode(JSON.stringify({ s: 400, h: { "x-tunnel-error": e instanceof TamperError ? "unsealable" : "bad_request" }, r } satisfies ResponseHead));
      await postFrames(Buffer.concat([w.header(), w.push(headBytes, true)]), true);
      return;
    }

    // Dispatch to the local surface; network errors become a sealed 502.
    let status = 502; let respHeaders: Record<string, string> = { "x-tunnel-error": "daemon_fetch_failed" };
    let respBody: ReadableStream<Uint8Array> | null = null;
    try {
      const h: Record<string, string> = { ...opts.targetHeaders };
      for (const [k, v] of Object.entries(head.h ?? {})) if (!STRIP.has(k.toLowerCase())) h[k] = v;
      const resp = await fetch(opts.targetBase + head.p, {
        method: head.m, headers: h,
        body: body.length > 0 ? (body as any) : undefined,
      });
      status = resp.status;
      respHeaders = {};
      resp.headers.forEach((v, k) => { if (!STRIP.has(k.toLowerCase())) respHeaders[k] = v; });
      respBody = resp.body;
    } catch { /* sealed 502 below */ }

    // Stream the response back: head frame first, then body chunks as the
    // local surface produces them — this is what makes SSE and large files
    // work through the tunnel without buffering.
    const w = new SealedWriter(key);
    const headBytes = new TextEncoder().encode(JSON.stringify({ s: status, h: respHeaders, r } satisfies ResponseHead));
    if (respBody === null) {
      await postFrames(Buffer.concat([w.header(), w.push(headBytes, true)]), true);
      return;
    }
    let pendingWire: Uint8Array[] = [w.header(), w.push(headBytes, false)];
    const reader = respBody.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      let v = value as Uint8Array;
      for (let off = 0; off < v.length; off += CHUNK_MAX) {
        pendingWire.push(w.push(v.subarray(off, Math.min(off + CHUNK_MAX, v.length)), false));
      }
      // Flush per read — keeps memory flat and latency low for SSE.
      await postFrames(Buffer.concat(pendingWire.map(Buffer.from)), false);
      pendingWire = [];
    }
    pendingWire.push(w.push(new Uint8Array(0), true));
    await postFrames(Buffer.concat(pendingWire.map(Buffer.from)), true);
  }

  /** The lease this executor should present: the lane's (borrowed) or its
   *  own. Null while the lane has not acquired one yet. */
  const activeLease = (): { id: string; token: string } | null => {
    if (opts.borrowLease) {
      const b = opts.borrowLease();
      return b ? { id: b.leaseId, token: b.leaseToken } : null;
    }
    return lease ? { id: lease.id, token: lease.token } : null;
  };

  const loop = (async () => {
    if (!opts.borrowLease) await acquire();
    while (!stopped) {
      try {
        // Borrowed mode: use the lane's CURRENT lease; if it has none yet,
        // wait rather than acquiring (which would evict the lane).
        const borrowed = opts.borrowLease?.();
        if (opts.borrowLease && !borrowed) { await sleep(1000); continue; }
        const leaseId = borrowed ? borrowed.leaseId : lease!.id;
        const leaseToken = borrowed ? borrowed.leaseToken : lease!.token;
        const r = await fetch(`${opts.relayUrl}/joy/v2/daemon/leases/${leaseId}/claims/tunnel`, {
          method: "POST",
          headers: { "x-joy-lease-token": leaseToken, "content-type": "application/json" },
          body: JSON.stringify({ waitMs: 25_000 }),
        });
        if (r.status === 401 || r.status === 412) {
          // Borrowed lease rotated — pick up the new one next pass.
          if (opts.borrowLease) { await sleep(1000); continue; }
          await acquire(); continue;
        } // lease lapsed/fenced
        if (!r.ok) { await sleep(1000); continue; }
        const { requests } = await r.json() as { requests: { requestId: string; payload: string }[] };
        // Concurrent execution: one slow request must not head-of-line block
        // the next claim — but errors stay per-request (a failed execute
        // times out relay-side; the loop keeps serving).
        for (const q of requests) void execute(q.requestId, q.payload).catch((e) => log(`tunnel execute ${q.requestId}: ${e}`));
      } catch {
        if (!stopped) await sleep(1000);
      }
    }
  })();

  return {
    leaseId: () => lease?.id ?? null,
    async stop() {
      stopped = true;
      if (renewTimer) clearInterval(renewTimer);
      await Promise.race([loop, sleep(100)]);
    },
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
