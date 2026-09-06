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
import { openHeadAndBody, requestBinding, sealResponse, type RequestHead, type ResponseHead } from "./wire";
import { SeenStreamIds, staleReason } from "./replayGuard";
import { joyRelayAccessKey } from "../paths";

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
  /** Replay guard to share/inspect (tests); defaults to a fresh 10k / 15 min one. */
  replayGuard?: SeenStreamIds;
}

export interface ExecutorHandle { stop(): Promise<void>; leaseId: () => string | null }

/** Blocked hop-by-hop / transport headers — the daemon-side fetch and the
 *  client re-add their own. Everything else passes through sealed. */
const STRIP = new Set(["host", "connection", "content-length", "transfer-encoding", "keep-alive", "upgrade"]);

/** The relay perimeter key, when configured (#82). Every other relay client
 *  (nucleus lane, RelayClient, pairing, the app) sends it; the executor's
 *  three fetches did not, so flipping the gate 401'd every tunnel claim —
 *  which the loop read as "lease rotated" and retried forever, silently,
 *  while the message plane kept working. Read per request (like the lane):
 *  the env loader may run after module import. */
function relayKeyHeaders(): Record<string, string> {
  const k = joyRelayAccessKey();
  return k ? { "x-joy-relay-key": k } : {};
}

/** Resolve the sealed request path against the local surface, or null when it
 *  cannot be dispatched there (#119). `targetBase + head.p` trusted the
 *  client's `p` verbatim: `@evil.example/x` became
 *  `http://127.0.0.1:4997@evil.example/x` — host evil.example, our loopback
 *  as userinfo — and `//evil.example/x` rehomed the same way, both sending
 *  the daemon's X-Joy-Token to an arbitrary host. Only a `/`-rooted path
 *  that resolves to the target's own origin is dispatched.
 *
 *  A raw space is the one whitespace accepted — encoded to %20 before
 *  validation, as the old concatenation's fetch used to do — so a client
 *  that forgot to encode a file name keeps working; C0/C1 controls and DEL
 *  are refused outright (`new URL` would silently STRIP tab/LF/CR, and the
 *  local surface must never see a path this function did not see).
 *
 *  What the local parser sees must be exactly what was validated here: the
 *  request-target on the wire is pathname+search, and http.ts parses it with
 *  `new URL(req.url, base)` — a `..`-collapsed `/..//evil.example/x` resolves
 *  on our origin but reaches the wire as `//evil.example/x`, which that
 *  parser reads as host evil.example, path /x. Refused: a `//` pathname, and
 *  any request-target that does not re-parse to the same origin/path/query. */
export function resolveLocalPath(targetBase: string, p: unknown): string | null {
  if (typeof p !== "string" || !/^\/(?![/\\@])[^\x00-\x1f\x7f-\x9f]*$/.test(p)) return null;
  try {
    const base = new URL(targetBase);
    const u = new URL(p.replace(/ /g, "%20"), base);
    if (u.origin !== base.origin || u.username || u.password) return null;
    if (u.pathname.startsWith("//")) return null;
    const wire = u.pathname + u.search;
    const again = new URL(wire, base);
    if (again.origin !== base.origin || again.pathname !== u.pathname || again.search !== u.search) return null;
    return base.origin + wire; // never a fragment: fetch drops it, and the wire never carries it
  } catch { return null; }
}

export function startTunnelExecutor(opts: ExecutorOpts): ExecutorHandle {
  const log = opts.log ?? (() => {});
  const key = deriveTunnelKey(opts.machineKey, opts.machineId);
  const seen = opts.replayGuard ?? new SeenStreamIds();
  let stopped = false;
  let lease: { id: string; token: string } | null = null;
  let renewTimer: ReturnType<typeof setInterval> | null = null;
  // The gate, not the lease: a 401 whose body says `relay key required` is
  // said ONCE per outage in words — it used to look exactly like a
  // per-machine tunnel outage (#82). The flag clears on the next accepted
  // keyed call, so a later gate flip or key rotation is logged again rather
  // than being silent for the life of the process.
  let gateRefusalLogged = false;
  function noteGateRefusal(status: number, bodyText: string, what: string): void {
    if (status !== 401 || gateRefusalLogged) return;
    let error = "";
    try { error = String((JSON.parse(bodyText) as { error?: string } | null)?.error ?? ""); } catch { /* not json */ }
    if (error !== "relay key required") return;
    gateRefusalLogged = true;
    log(`tunnel ${what} refused: relay key required — the relay gate is on and this daemon presents no/the wrong x-joy-relay-key (JOY_RELAY_ACCESS_KEY or perimeter.key; re-run \`joy auth\`)`);
  }
  function noteGateAccepted(what: string): void {
    if (!gateRefusalLogged) return;
    gateRefusalLogged = false;
    log(`tunnel ${what} accepted again — the relay takes this daemon's x-joy-relay-key`);
  }

  async function acquire(): Promise<void> {
    const r = await fetch(`${opts.relayUrl}/joy/v2/daemon/leases`, {
      method: "POST",
      headers: { ...relayKeyHeaders(), authorization: `Bearer ${opts.accountToken}`, "content-type": "application/json" },
      body: JSON.stringify({ machineId: opts.machineId, capabilities: { tunnel: 1 } }),
    });
    if (!r.ok) {
      const text = await r.text();
      noteGateRefusal(r.status, text, "lease acquire");
      throw new Error(`lease acquire failed: ${r.status} ${text}`);
    }
    noteGateAccepted("lease acquire");
    const j = await r.json() as { leaseId: string; leaseToken: string; ttlSeconds: number };
    lease = { id: j.leaseId, token: j.leaseToken };
    // Renew at half TTL — a missed beat expires the lease and 412s the loops,
    // which we treat as "re-acquire", not as fatal.
    if (renewTimer) clearInterval(renewTimer);
    renewTimer = setInterval(() => {
      if (opts.borrowLease) return; // the nucleus lane renews the lease it owns
      void fetch(`${opts.relayUrl}/joy/v2/daemon/leases/${lease!.id}`, {
        method: "PUT", headers: { ...relayKeyHeaders(), "x-joy-lease-token": lease!.token },
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
          return { ...relayKeyHeaders(), "x-joy-lease-id": l.id, "x-joy-lease-token": l.token, "content-type": "application/octet-stream" };
        })(),
        body: bytes as any,
      });
      if (!r.ok) {
        // 404 request_gone (client left / idle deadline) or 403 wrong_daemon:
        // the exchange is over — the caller must stop reading its local
        // response (#83). Carry the relay's code so the log says which.
        const code = await r.json().then((j) => String((j as { error?: string } | null)?.error ?? ""), () => "");
        throw new Error(`frames post failed: ${r.status}${code ? ` ${code}` : ""}`);
      }
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

    // The request is authentic — now is it FRESH? The relay can re-post a
    // recorded request (same stream id) or hold one back (old `t`); either
    // gets a sealed 409 bound to it and is never dispatched. Checked only
    // after a successful open so a spliced stream id cannot poison the guard.
    const refusal = seen.seenOrRecord(r) ? "replayed_request" : staleReason(head.t);
    if (refusal) {
      const body = new TextEncoder().encode(JSON.stringify({ error: refusal }));
      await postFrames(sealResponse(key, { s: 409, h: { "content-type": "application/json", "x-tunnel-error": refusal }, r }, body), true);
      return;
    }

    // The path must land on the LOCAL surface (#119) — a sealed 400 otherwise,
    // and the daemon token never leaves the loopback.
    const target = resolveLocalPath(opts.targetBase, head.p);
    if (target === null) {
      log(`tunnel request ${requestId}: refused path ${JSON.stringify(String(head.p).slice(0, 120))} — not a local surface path (#119)`);
      const body = new TextEncoder().encode(JSON.stringify({ error: "bad_path" }));
      await postFrames(sealResponse(key, { s: 400, h: { "content-type": "application/json", "x-tunnel-error": "bad_path" }, r }, body), true);
      return;
    }

    // Dispatch to the local surface; network errors become a sealed 502.
    let status = 502; let respHeaders: Record<string, string> = { "x-tunnel-error": "daemon_fetch_failed" };
    let respBody: ReadableStream<Uint8Array> | null = null;
    try {
      const h: Record<string, string> = { ...opts.targetHeaders };
      for (const [k, v] of Object.entries(head.h ?? {})) if (!STRIP.has(k.toLowerCase())) h[k] = v;
      const resp = await fetch(target, {
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
    try {
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
    } finally {
      // A frame post that throws (404 request_gone, 403 wrong_daemon, relay
      // down) ends the exchange — release the LOCAL response too. Without
      // this a local SSE stream was read to nobody for as long as the local
      // surface kept writing (#83). Cancelling a finished reader is a no-op.
      await reader.cancel().catch(() => {});
    }
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
    if (!opts.borrowLease) {
      // Own-lease mode: a failed FIRST acquire (gate flipped with no key,
      // relay down, 5xx) used to reject this promise with nobody attached —
      // an unhandledRejection that took the whole process down. Say what
      // failed and retry with backoff; stop() still ends the wait.
      let delay = 1000;
      while (!stopped) {
        try { await acquire(); break; }
        catch (e) {
          log(`tunnel lease acquire failed: ${e instanceof Error ? e.message : String(e)} — retrying in ${delay} ms`);
          await sleep(delay);
          delay = Math.min(delay * 2, 30_000);
        }
      }
    }
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
          headers: { ...relayKeyHeaders(), "x-joy-lease-token": leaseToken, "content-type": "application/json" },
          body: JSON.stringify({ waitMs: 25_000 }),
        });
        if (r.status === 401) noteGateRefusal(r.status, await r.text().catch(() => ""), "claim");
        if (r.status === 401 || r.status === 412) {
          // Borrowed lease rotated — pick up the new one next pass.
          if (opts.borrowLease) { await sleep(1000); continue; }
          // Own lease lapsed/fenced (or the gate refused it): re-acquire; a
          // failure is logged here rather than swallowed by the outer catch.
          try { await acquire(); } catch (e) { log(`tunnel lease re-acquire failed: ${e instanceof Error ? e.message : String(e)}`); await sleep(1000); }
          continue;
        }
        if (!r.ok) { await sleep(1000); continue; }
        noteGateAccepted("claim");
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
