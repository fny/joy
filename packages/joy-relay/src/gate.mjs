// Relay access gate: a shared key required on EVERY request before anything
// reaches the relay. Without it, anyone who can reach the port can auto-create
// accounts and use the box (/joy/v2/auth is open by design). Per-account
// bearer auth and E2E encryption are unchanged underneath; this is a perimeter
// key.
//
// Key comes from JOY_RELAY_ACCESS_KEY in the service environment. UNSET → the
// gate is open (deploy-then-flip: ship support everywhere, then set the key).
// Clients present it as the `x-joy-relay-key` header, or `?joyRelayKey=` in
// the URL for browser WebSockets (which cannot set custom headers).
import { timingSafeEqual } from 'node:crypto';

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function candidateFrom(req) {
  const header = req.headers['x-joy-relay-key'];
  if (typeof header === 'string' && header) return header;
  const q = (req.url ?? '').match(/[?&]joyRelayKey=([^&]+)/);
  // Same decode hazard as docs.mjs (#59): a bad escape is "no key", not a crash.
  if (q) { try { return decodeURIComponent(q[1]); } catch { return null; } }
  return null;
}

/** The same permissive CORS the v2 router applies to every response. The
 *  gate answers BEFORE the router, so without these a browser client (the
 *  web build) saw an opaque network error instead of the 401 — it could not
 *  tell "wrong key" from "relay down" and never prompted for one (#85). */
export function corsFor(req) {
  return {
    'access-control-allow-origin': req?.headers?.origin ?? '*',
    'access-control-allow-headers': 'authorization, content-type, x-session, x-cipher-hash, x-joy-relay-key, x-joy-client',
    'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    vary: 'origin',
  };
}

export function createGate(key = process.env.JOY_RELAY_ACCESS_KEY || '') {
  if (!key) {
    return { enabled: false, allows: () => true, rejectHttp: () => {}, rejectUpgrade: () => {} };
  }
  return {
    enabled: true,
    allows(req) {
      const candidate = candidateFrom(req);
      return candidate !== null && safeEqual(candidate, key);
    },
    rejectHttp(res, req = null) {
      res.writeHead(401, { 'content-type': 'application/json', ...corsFor(req) });
      res.end(JSON.stringify({ error: 'relay key required', relay: 'joy-relay' }));
    },
    rejectUpgrade(socket) {
      try {
        socket.write('HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{"error":"relay key required"}');
      } catch { /* socket already gone */ }
      socket.destroy();
    },
  };
}
