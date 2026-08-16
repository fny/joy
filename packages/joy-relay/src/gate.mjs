// Relay access gate: a shared key required on EVERY request (HTTP + WebSocket
// upgrade) before anything reaches happy-server. This keys the relay itself —
// without it, anyone who can reach the port can auto-create accounts and use
// the box (happy-server's /v1/auth is open by design). Per-account bearer auth
// and E2E encryption are unchanged underneath; this is a perimeter key.
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
  if (q) return decodeURIComponent(q[1]);
  return null;
}

export function createGate() {
  const key = process.env.JOY_RELAY_ACCESS_KEY || '';
  if (!key) {
    return { enabled: false, allows: () => true, rejectHttp: () => {}, rejectUpgrade: () => {} };
  }
  return {
    enabled: true,
    allows(req) {
      const candidate = candidateFrom(req);
      return candidate !== null && safeEqual(candidate, key);
    },
    rejectHttp(res) {
      res.writeHead(401, { 'content-type': 'application/json' });
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
