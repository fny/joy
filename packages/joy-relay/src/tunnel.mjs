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

export function createTunnel({ notify }) {
  const lastPoll = new Map();   // daemonId -> ms epoch of last claim poll
  const inboxes = new Map();    // daemonId -> [{ requestId, payload: Buffer }]
  const pending = new Map();    // requestId -> { daemonId, res, idleTimer, done }

  const attached = (daemonId) =>
    Date.now() - (lastPoll.get(daemonId) ?? 0) < ATTACH_FRESH_MS;

  /** Drop a parked request the daemon has not collected yet. */
  function dequeue(daemonId, requestId) {
    const q = inboxes.get(daemonId);
    if (!q) return;
    const i = q.findIndex((r) => r.requestId === requestId);
    if (i >= 0) q.splice(i, 1);
    if (q.length === 0) inboxes.delete(daemonId);
  }
  const inboxBytes = (q) => q.reduce((n, r) => n + r.payload.length, 0);

  function fail(requestId, status, code) {
    const p = pending.get(requestId);
    if (!p || p.done) return;
    p.done = true;
    clearTimeout(p.idleTimer);
    pending.delete(requestId);
    dequeue(p.daemonId, requestId); // never hand the daemon a request nobody awaits
    if (!p.res.headersSent) {
      p.res.writeHead(status, { 'content-type': 'application/json' });
      p.res.end(JSON.stringify({ error: code }));
    } else {
      // Mid-stream failure: destroy so the client's SealedReader sees
      // truncation (no FINAL) instead of a clean-looking end.
      p.res.destroy();
    }
  }

  function armIdle(p) {
    clearTimeout(p.idleTimer);
    p.idleTimer = setTimeout(() => fail(p.requestId, 504, 'daemon_response_timeout'), RESPONSE_IDLE_MS);
  }

  return {
    attached,

    /** Client → daemon: register the exchange and hand the sealed request to
     *  the daemon's next poll. Owns `res` for the life of the exchange. */
    clientRequest(daemonId, payload, res) {
      if (!attached(daemonId)) {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'daemon_offline' }));
        return;
      }
      const q = inboxes.get(daemonId) ?? [];
      if (q.length >= INBOX_MAX_REQUESTS || inboxBytes(q) + payload.length > INBOX_MAX_BYTES) {
        res.writeHead(503, { 'content-type': 'application/json', 'retry-after': '1' });
        res.end(JSON.stringify({ error: 'daemon_busy' }));
        return;
      }
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
      q.push({ requestId, payload });
      inboxes.set(daemonId, q);
      notify.wakeDaemon(daemonId, 'tunnel');
    },

    /** Daemon long-poll: drain queued requests, else park until one arrives.
     *  Also the attachment heartbeat — polling IS being online. */
    async claim(daemonId, waitMs = CLAIM_WAIT_MS) {
      lastPoll.set(daemonId, Date.now());
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
      lastPoll.set(daemonId, Date.now());
      return { requests: out };
    },

    /** Daemon → client: sealed response bytes, streamed straight through.
     *  `done` ends the exchange; the relay never inspects the frames.
     *  A request that is gone (client left, idle deadline hit) or that
     *  belongs to another daemon is a 4xx, not a 200 carrying `{error}`:
     *  the daemon's executor only stops on a non-ok status, and a 200 kept
     *  it streaming a local SSE response to nobody, forever (#83). */
    daemonFrames(requestId, daemonId, chunk, done) {
      const p = pending.get(requestId);
      if (!p || p.done) throw new ApiError(404, 'request_gone');
      if (p.daemonId !== daemonId) throw new ApiError(403, 'wrong_daemon'); // a lease for another machine cannot answer
      if (!p.res.headersSent) {
        p.res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'x-tunnel-request': requestId,
          'cache-control': 'no-store',
        });
      }
      if (chunk.length > 0) p.res.write(chunk);
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
        inboxRequests, inboxBytes: inboxBytesTotal,
      };
    },
  };
}
