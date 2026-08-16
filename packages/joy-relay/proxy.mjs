// joy-relay phase 0: transparent passthrough to happy-server.
// The PRIMARY relay URL (joy.voltai.party:4997 via caddy) terminates HERE, so
// clients pair against the new relay's address from day one; the strangler
// then takes over endpoints without anyone re-pointing. Zero dependencies —
// plain node http + raw socket piping for WebSocket upgrades.
import * as http from 'node:http';
import * as net from 'node:net';
import { createGate } from './src/gate.mjs';

const LISTEN = Number(process.env.JOY_RELAY_PORT ?? 3105);
const TARGET_HOST = process.env.JOY_RELAY_UPSTREAM_HOST ?? '127.0.0.1';
const TARGET_PORT = Number(process.env.JOY_RELAY_UPSTREAM_PORT ?? 3005);
const gate = createGate();

const server = http.createServer((req, res) => {
  if (!gate.allows(req)) return gate.rejectHttp(res);
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

// WebSocket (socket.io) passthrough: replay the upgrade request bytes at the
// upstream and splice the sockets.
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
  console.log(`[joy-relay] phase-0 passthrough :${LISTEN} -> ${TARGET_HOST}:${TARGET_PORT}`);
});
