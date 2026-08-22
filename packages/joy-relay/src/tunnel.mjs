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

// A daemon counts as attached while its tunnel long-poll was seen recently.
// Poll timeout (25s) + margin: one missed poll is a hiccup, two is offline.
const ATTACH_FRESH_MS = 35_000;
const CLAIM_WAIT_MS = 25_000;
// Idle gap allowed mid-response before the relay gives up on the daemon.
const RESPONSE_IDLE_MS = 60_000;
// Sealed request cap — matches the daemon's own body limits; the tunnel is
// not the bulk-upload path (attachments are).
export const REQUEST_MAX = 32 * 1024 * 1024;

export function createTunnel({ notify }) {
  const lastPoll = new Map();   // daemonId -> ms epoch of last claim poll
  const inboxes = new Map();    // daemonId -> [{ requestId, payload: Buffer }]
  const pending = new Map();    // requestId -> { daemonId, res, idleTimer, done }

  const attached = (daemonId) =>
    Date.now() - (lastPoll.get(daemonId) ?? 0) < ATTACH_FRESH_MS;

  function fail(requestId, status, code) {
    const p = pending.get(requestId);
    if (!p || p.done) return;
    p.done = true;
    clearTimeout(p.idleTimer);
    pending.delete(requestId);
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
      const requestId = randomUUID();
      const p = { requestId, daemonId, res, idleTimer: null, done: false };
      pending.set(requestId, p);
      armIdle(p);
      res.on('close', () => { // client went away — drop state, daemon posts land on 404
        if (!p.done) { p.done = true; clearTimeout(p.idleTimer); pending.delete(requestId); }
      });
      const q = inboxes.get(daemonId) ?? [];
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
        inboxes.set(daemonId, []);
        return q.map((r) => ({ requestId: r.requestId, payload: r.payload.toString('base64') }));
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
     *  `done` ends the exchange; the relay never inspects the frames. */
    daemonFrames(requestId, daemonId, chunk, done) {
      const p = pending.get(requestId);
      if (!p || p.done) return { error: 'request_gone' };
      if (p.daemonId !== daemonId) return { error: 'wrong_daemon' }; // a lease for another machine cannot answer
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
      return { pending: pending.size, attachedDaemons: [...lastPoll.keys()].filter(attached).length };
    },
  };
}
