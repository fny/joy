// joy-relay phase 1: native /joy/v1 nucleus + legacy passthrough.
// Everything under /joy/v1 is served locally from the embedded PGlite store
// (durable queue, turns, cancellation, leases, events, state, SSE — see
// docs/joy-relay-design.md); every other request, including WebSocket
// upgrades, is proxied byte-for-byte to happy-server exactly like phase 0.
// The stable instance keeps running proxy.mjs; this entrypoint is the DEV
// relay first (build order §14.7), promoted when proven.
import * as http from 'node:http';
import * as net from 'node:net';
import { openDb } from './src/db.mjs';
import { createCore } from './src/core.mjs';
import { createNotify } from './src/notify.mjs';
import { createAuth } from './src/auth.mjs';
import { createRouter } from './src/routes.mjs';
import { createGate } from './src/gate.mjs';
import { handleDocs } from './src/docs.mjs';

const LISTEN = Number(process.env.JOY_RELAY_PORT ?? 3105);
const TARGET_HOST = process.env.JOY_RELAY_UPSTREAM_HOST ?? '127.0.0.1';
const TARGET_PORT = Number(process.env.JOY_RELAY_UPSTREAM_PORT ?? 3005);
// Data lives OUTSIDE the rsynced checkout so deploys never wipe it.
const DATA_DIR = process.env.JOY_RELAY_DATA_DIR ?? '/home/ubuntu/joy-relay-data/dev';

const db = await openDb(DATA_DIR);
const notify = createNotify();
const core = createCore(db, notify);
const auth = createAuth({ upstreamHost: TARGET_HOST, upstreamPort: TARGET_PORT });
const router = createRouter({ core, auth, notify, db });

// Lease-expiry sweep: orphans running turns whose daemon lease lapsed.
setInterval(() => { core.sweepExpiredLeases().catch((e) => console.error('[joy-relay] sweep failed:', e)); }, 5_000).unref();

const gate = createGate();

const server = http.createServer(async (req, res) => {
  if (!gate.allows(req)) return gate.rejectHttp(res);
  if (handleDocs(req, res, { version: '0.1.0' })) return;
  if (await router.handle(req, res)) return;
  const up = http.request(
    { host: TARGET_HOST, port: TARGET_PORT, path: req.url, method: req.method, headers: req.headers },
    (upRes) => {
      res.writeHead(upRes.statusCode ?? 502, upRes.headers);
      upRes.pipe(res);
    },
  );
  up.on('error', () => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'upstream unavailable', relay: 'joy-relay' }));
  });
  req.pipe(up);
});

// WebSocket (socket.io) passthrough, unchanged from phase 0 — the native
// protocol uses SSE + long-poll only.
server.on('upgrade', (req, socket, head) => {
  if (!gate.allows(req)) return gate.rejectUpgrade(socket);
  const up = net.connect(TARGET_PORT, TARGET_HOST, () => {
    let raw = `${req.method} ${req.url} HTTP/1.1\r\n`;
    for (let i = 0; i < req.rawHeaders.length; i += 2) raw += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
    raw += '\r\n';
    up.write(raw);
    if (head?.length) up.write(head);
    socket.pipe(up).pipe(socket);
  });
  const kill = () => { socket.destroy(); up.destroy(); };
  up.on('error', kill); socket.on('error', kill);
});

server.listen(LISTEN, '127.0.0.1', () => {
  console.log(`[joy-relay] phase-1 native+passthrough :${LISTEN} -> ${TARGET_HOST}:${TARGET_PORT} (data ${DATA_DIR})`);
});
