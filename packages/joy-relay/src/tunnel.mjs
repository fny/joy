// Daemon tunnel: forwards E2E-sealed HTTP exchanges between clients and a
// daemon's local HTTP surface, through this relay, WITHOUT the relay being
// able to read them. The relay sees: daemonId, requestId, byte counts,
// timing. Method, path, headers and bodies are inside sealed-stream envelopes
// (joy-daemon src/tunnel/sealedStream.ts) under a key both ends derive from
// the account secret — this process never holds it.
//
// Deliberately IN-MEMORY, unlike the work/control lanes: a tunnel request is
// a LIVE exchange with a machine. If the daemon is not attached, the honest
// answer is 503 daemon_offline NOW — persisting the request for later would
// re-create the half-delivered ambiguity the durable turn queue exists to
// solve properly. Durability belongs to turns; liveness belongs here.
import { randomUUID } from 'node:crypto';
import { ApiError } from './core.mjs';

// A daemon counts as attached while its tunnel long-poll was seen recently.
// Poll timeout (25s) + margin: one missed poll is a hiccup, two is offline.
const ATTACH_FRESH_MS = 35_000;
const CLAIM_WAIT_MS = 25_000;
// Idle gap allowed mid-response before the relay gives up on the daemon.
// Doubles as the inbox TTL: a parked request the daemon never collected is
// failed (and dequeued) by this timer, so nothing outlives it in memory.
const RESPONSE_IDLE_MS = 60_000;
// Sealed request cap — matches the daemon's own body limits; the tunnel is
// not the bulk-upload path (attachments are).
export const REQUEST_MAX = 32 * 1024 * 1024;
// Per-daemon inbox bounds (#84). Requests parked for a daemon that has not
// polled yet live in relay memory: with no cap, one account could pin
// N × 32 MiB for the whole 35s attach window; with no expiry, a daemon that
// died inside the window kept them forever. Past the cap the client hears
// 503 daemon_busy now, the same honesty as daemon_offline.
export const INBOX_MAX_REQUESTS = 16;
export const INBOX_MAX_BYTES = 64 * 1024 * 1024;
// Relay-wide budget on top of the per-daemon caps: an account may run 50
// daemons, so per-daemon bounds alone still allowed 3.2 GiB of parked bodies
// from one account. Past this every client hears 503 relay_busy.
export const GLOBAL_INBOX_MAX_REQUESTS = 256;
export const GLOBAL_INBOX_MAX_BYTES = 256 * 1024 * 1024;
// Response path bound — the tunnel twin of the SSE cap (#81): bytes Node may
// hold for one client before a daemon frame post waits for the socket to
// drain, and how long it waits before the client is dropped as too slow.
export const RESPONSE_MAX_BUFFERED_BYTES = 8 * 1024 * 1024;
export const RESPONSE_DRAIN_WAIT_MS = 10_000;

export function createTunnel({
  notify,
  now = Date.now,
  attachFreshMs = ATTACH_FRESH_MS,
  inboxMaxRequests = INBOX_MAX_REQUESTS,
  inboxMaxBytes = INBOX_MAX_BYTES,
  globalMaxRequests = GLOBAL_INBOX_MAX_REQUESTS,
  globalMaxBytes = GLOBAL_INBOX_MAX_BYTES,
  responseMaxBuffered = RESPONSE_MAX_BUFFERED_BYTES,
  responseDrainWaitMs = RESPONSE_DRAIN_WAIT_MS,
  responseIdleMs = RESPONSE_IDLE_MS,
} = {}) {
  const lastPoll = new Map();   // daemonId -> ms epoch of last claim poll (pruned by age)
  const inboxes = new Map();    // daemonId -> [{ requestId, payload: Buffer }]
  const pending = new Map();    // requestId -> { daemonId, res, idleTimer, done }
  // Admitted requests whose body is still being uploaded. They count against
  // the same budgets as parked payloads, so admission can refuse BEFORE a
  // byte is buffered and K unfinished uploads cannot pin K × 32 MiB.
  const reserved = new Map();   // daemonId -> { count, bytes }
  const reservedTotal = { count: 0, bytes: 0 };
  let lastPrune = 0;

  const attached = (daemonId) =>
    now() - (lastPoll.get(daemonId) ?? 0) < attachFreshMs;

  /** Drop a parked request the daemon has not collected yet. */
  function dequeue(daemonId, requestId) {
    const q = inboxes.get(daemonId);
    if (!q) return;
    const i = q.findIndex((r) => r.requestId === requestId);
    if (i >= 0) q.splice(i, 1);
    if (q.length === 0) inboxes.delete(daemonId);
  }
  const inboxBytes = (q) => q.reduce((n, r) => n + r.payload.length, 0);

  /** Parked + in-flight load for one daemon, and relay-wide. */
  function daemonLoad(daemonId) {
    const q = inboxes.get(daemonId) ?? [];
    const r = reserved.get(daemonId) ?? { count: 0, bytes: 0 };
    return { count: q.length + r.count, bytes: inboxBytes(q) + r.bytes };
  }
  function globalLoad() {
    let count = reservedTotal.count; let bytes = reservedTotal.bytes;
    for (const q of inboxes.values()) { count += q.length; bytes += inboxBytes(q); }
    return { count, bytes };
  }

  /** Why a request for `daemonId` carrying `bytes` may not proceed, or null.
   *  Offline first (the most useful answer), then the relay budget, then the
   *  daemon's own inbox. */
  function admission(daemonId, bytes) {
    if (!attached(daemonId)) return new ApiError(503, 'daemon_offline');
    const busy = (code) => new ApiError(503, code, undefined, { 'retry-after': '1' });
    const g = globalLoad();
    if (g.count >= globalMaxRequests || g.bytes + bytes > globalMaxBytes) return busy('relay_busy');
    const d = daemonLoad(daemonId);
    if (d.count >= inboxMaxRequests || d.bytes + bytes > inboxMaxBytes) return busy('daemon_busy');
    return null;
  }

  function refuse(res, err) {
    res.writeHead(err.status, { 'content-type': 'application/json', ...(err.headers ?? {}) });
    res.end(JSON.stringify({ error: err.code }));
  }

  const clientGone = (p) => p.res.destroyed || p.res.writableEnded || p.res.socket?.destroyed === true;

  function fail(requestId, status, code) {
    const p = pending.get(requestId);
    if (!p || p.done) return;
    p.done = true;
    clearTimeout(p.idleTimer);
    pending.delete(requestId);
    dequeue(p.daemonId, requestId); // never hand the daemon a request nobody awaits
    if (!p.res.headersSent) {
      refuse(p.res, { status, code });
    } else {
      // Mid-stream failure: destroy so the client's SealedReader sees
      // truncation (no FINAL) instead of a clean-looking end.
      p.res.destroy();
    }
  }

  function armIdle(p) {
    clearTimeout(p.idleTimer);
    p.idleTimer = setTimeout(() => fail(p.requestId, 504, 'daemon_response_timeout'), responseIdleMs);
  }

  /** Resolve true once the client's socket has drained (or is already empty),
   *  false when the deadline passes or the client leaves first. */
  function waitForDrain(res, ms) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (ok) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        res.off('drain', onDrain);
        res.off('close', onClose);
        resolve(ok);
      };
      const onDrain = () => finish(true);
      const onClose = () => finish(false);
      const timer = setTimeout(() => finish(false), ms);
      res.on('drain', onDrain);
      res.on('close', onClose);
      if ((res.writableLength ?? 0) === 0) finish(true);
    });
  }

  /** The pending exchange `daemonId` may answer, or the honest 4xx: 404 for
   *  a request that is gone (client left, idle deadline hit, never existed),
   *  403 for another machine's request, 410 when the client's socket is
   *  already dead but the close event has not been processed yet. Callable
   *  BEFORE the frame body is read. */
  function assertAnswerable(requestId, daemonId) {
    const p = pending.get(requestId);
    if (!p || p.done) throw new ApiError(404, 'request_gone');
    if (p.daemonId !== daemonId) throw new ApiError(403, 'wrong_daemon'); // a lease for another machine cannot answer
    if (clientGone(p)) {
      fail(requestId, 410, 'client_gone');
      throw new ApiError(410, 'client_gone');
    }
    return p;
  }

  return {
    attached,

    /** Admission BEFORE the body is read: ownership is the route's job; this
     *  settles liveness, the declared size and both inbox budgets, and
     *  reserves the declared bytes until `release()` (or `clientRequest`,
     *  which releases and re-checks with the real length). Throws the
     *  ApiError the client should hear. */
    admit(daemonId, declaredBytes = 0) {
      const bytes = Number.isFinite(declaredBytes) && declaredBytes > 0 ? declaredBytes : 0;
      if (bytes > REQUEST_MAX) throw new ApiError(413, 'body_too_large');
      const refused = admission(daemonId, bytes);
      if (refused) throw refused;
      const r = reserved.get(daemonId) ?? { count: 0, bytes: 0 };
      r.count++; r.bytes += bytes;
      reserved.set(daemonId, r);
      reservedTotal.count++; reservedTotal.bytes += bytes;
      let released = false;
      return {
        release() {
          if (released) return;
          released = true;
          r.count--; r.bytes -= bytes;
          if (r.count === 0 && reserved.get(daemonId) === r) reserved.delete(daemonId);
          reservedTotal.count--; reservedTotal.bytes -= bytes;
        },
      };
    },

    /** Client → daemon: register the exchange and hand the sealed request to
     *  the daemon's next poll. Owns `res` for the life of the exchange. */
    clientRequest(daemonId, payload, res, reservation = null) {
      reservation?.release();
      // A response that already closed (the client left while its body was
      // in flight, before this ran) awaits nothing: park nothing, wake no
      // one — the daemon must never execute a request nobody awaits.
      if (res.destroyed || res.writableEnded || res.socket?.destroyed === true) return;
      // Re-checked with the REAL length (a chunked upload declared none).
      const refused = admission(daemonId, payload.length);
      if (refused) { refuse(res, refused); return; }
      const requestId = randomUUID();
      const p = { requestId, daemonId, res, idleTimer: null, done: false };
      pending.set(requestId, p);
      armIdle(p);
      res.on('close', () => {
        // Client went away: drop the exchange AND its parked payload, so the
        // daemon never executes a request nobody awaits (#84); frame posts
        // for it land on 404 (#83).
        if (!p.done) { p.done = true; clearTimeout(p.idleTimer); pending.delete(requestId); dequeue(daemonId, requestId); }
      });
      const q = inboxes.get(daemonId) ?? [];
      q.push({ requestId, payload });
      inboxes.set(daemonId, q);
      notify.wakeDaemon(daemonId, 'tunnel');
    },

    /** Daemon long-poll: drain queued requests, else park until one arrives.
     *  Also the attachment heartbeat — polling IS being online. */
    async claim(daemonId, waitMs = CLAIM_WAIT_MS) {
      const t = now();
      lastPoll.set(daemonId, t);
      // Daemons that stopped polling (detached) leave the map by age; one
      // sweep per attach window keeps this O(1) amortised per claim.
      if (t - lastPrune >= attachFreshMs) {
        lastPrune = t;
        for (const [id, seen] of lastPoll) if (t - seen >= attachFreshMs) lastPoll.delete(id);
      }
      const drain = () => {
        const q = inboxes.get(daemonId) ?? [];
        inboxes.delete(daemonId);
        // Only exchanges still awaited leave the relay (belt and braces for
        // the close/fail dequeues above).
        return q
          .filter((r) => { const p = pending.get(r.requestId); return p && !p.done; })
          .map((r) => ({ requestId: r.requestId, payload: r.payload.toString('base64') }));
      };
      let out = drain();
      if (out.length === 0) {
        // Waiter registered BEFORE the re-drain: a request enqueued in the
        // gap wakes us instead of being missed (same lost-wake discipline as
        // the work/control claims).
        const waited = notify.waitForDaemon(daemonId, 'tunnel', Math.min(waitMs, 30_000));
        out = drain();
        if (out.length === 0) { await waited; out = drain(); }
      }
      lastPoll.set(daemonId, now());
      return { requests: out };
    },

    assertAnswerable,

    /** Daemon → client: sealed response bytes, streamed straight through.
     *  `done` ends the exchange; the relay never inspects the frames.
     *  A request that is gone (client left, idle deadline hit) or that
     *  belongs to another daemon is a 4xx, not a 200 carrying `{error}`:
     *  the daemon's executor only stops on a non-ok status, and a 200 kept
     *  it streaming a local SSE response to nobody, forever (#83).
     *  Backpressure: past RESPONSE_MAX_BUFFERED_BYTES the post is answered
     *  only once the client's socket drains, so a slow-but-alive client
     *  paces the daemon instead of growing relay memory; a client that does
     *  not drain within the deadline is dropped and the daemon hears 429
     *  client_slow. */
    async daemonFrames(requestId, daemonId, chunk, done) {
      const p = assertAnswerable(requestId, daemonId);
      if (!p.res.headersSent) {
        p.res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'x-tunnel-request': requestId,
          'cache-control': 'no-store',
        });
      }
      if (chunk.length > 0) {
        const buffered = p.res.writableLength ?? 0;
        if (buffered > 0 && buffered + chunk.length > responseMaxBuffered) {
          const drained = await waitForDrain(p.res, responseDrainWaitMs);
          if (p.done) throw new ApiError(410, 'client_gone');         // left (or idled out) while we waited
          if (!drained) {
            fail(requestId, 429, 'client_slow');                      // destroys the client's stream (truncation, never a clean end)
            throw new ApiError(429, 'client_slow');
          }
        }
        p.res.write(chunk);
      }
      if (done) {
        p.done = true;
        clearTimeout(p.idleTimer);
        pending.delete(requestId);
        p.res.end();
      } else {
        armIdle(p);
      }
      return { ok: true };
    },

    /** Test/ops visibility only — counts, never contents. */
    stats() {
      let inboxRequests = 0; let inboxBytesTotal = 0;
      for (const q of inboxes.values()) { inboxRequests += q.length; inboxBytesTotal += inboxBytes(q); }
      return {
        pending: pending.size,
        attachedDaemons: [...lastPoll.keys()].filter(attached).length,
        trackedDaemons: lastPoll.size,
        inboxRequests, inboxBytes: inboxBytesTotal,
        reservedRequests: reservedTotal.count, reservedBytes: reservedTotal.bytes,
      };
    },
  };
}
