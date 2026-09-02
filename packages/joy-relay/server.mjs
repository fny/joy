// joy-relay: the one server in the system. Everything is served from the
// embedded PGlite store — accounts, pairing, machines, push tokens (the
// account plane), plus the durable queue, turns, cancellation, leases, events,
// state, attachments, SSE and the E2E tunnel (see docs/joy-relay-design.md).
// No upstream, no passthrough: an unknown path is a 404.
import * as http from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { openDb } from './src/db.mjs';
import { createCore } from './src/core.mjs';
import { createNotify } from './src/notify.mjs';
import { createAuth } from './src/auth.mjs';
import { createTokenAuthority } from './src/tokens.mjs';
import { createAccounts } from './src/accounts.mjs';
import { createGate } from './src/gate.mjs';
import { createTunnel } from './src/tunnel.mjs';
import { createV2Router } from './src/v2.mjs';
import { createAttachments } from './src/attachments.mjs';
import { handleDocs } from './src/docs.mjs';

const LISTEN = Number(process.env.JOY_RELAY_PORT ?? 3105);
// Data lives OUTSIDE the rsynced checkout so deploys never wipe it.
const DATA_DIR = process.env.JOY_RELAY_DATA_DIR ?? '/home/ubuntu/joy-relay-data/dev';

/** Token signing secret: JOY_RELAY_TOKEN_SECRET, else one generated once and
 *  kept beside the data (losing it invalidates every device's token). */
function tokenSecret() {
  if (process.env.JOY_RELAY_TOKEN_SECRET) return process.env.JOY_RELAY_TOKEN_SECRET;
  mkdirSync(DATA_DIR, { recursive: true });
  const file = join(DATA_DIR, 'token.secret');
  if (!existsSync(file)) writeFileSync(file, randomBytes(48).toString('base64'), { mode: 0o600 });
  return readFileSync(file, 'utf8').trim();
}
// Accepted token issuers; the first mints. Extra labels let a deployment keep
// honouring tokens minted under an earlier issuer name.
const ISSUERS = (process.env.JOY_RELAY_TOKEN_ISSUERS ?? 'joy').split(',').map((s) => s.trim()).filter(Boolean);

const db = await openDb(DATA_DIR);
const notify = createNotify();
const core = createCore(db, notify);
const tokens = await createTokenAuthority({ secret: tokenSecret(), issuers: ISSUERS });
const accounts = createAccounts(db, tokens);
const auth = createAuth({ tokens, accounts });
const tunnel = createTunnel({ notify });
const attachments = createAttachments(db);
const v2 = createV2Router({ core, auth, notify, db, tunnel, attachments, accounts });

// Lease-expiry sweep: orphans running turns whose daemon lease lapsed.
setInterval(() => { core.sweepExpiredLeases().catch((e) => console.error('[joy-relay] sweep failed:', e)); }, 5_000).unref();
// Attachment orphan sweep: uploaded-never-referenced ciphertext ages out.
setInterval(() => { attachments.sweepOrphans().catch((e) => console.error('[joy-relay] attachment sweep failed:', e)); }, 60 * 60 * 1000).unref();
// Pairing requests that were never (or long ago) answered age out.
setInterval(() => { accounts.sweepPairings().catch((e) => console.error('[joy-relay] pairing sweep failed:', e)); }, 60 * 60 * 1000).unref();

const gate = createGate();

const server = http.createServer(async (req, res) => {
  // CORS preflight carries no bearer, no gate key, no body, and reveals only
  // static CORS policy — answer OPTIONS /joy/v2 BEFORE the perimeter gate
  // (browsers cannot attach the gate key to a preflight). The actual request
  // that follows still carries the key and is still gated below.
  if (req.method === 'OPTIONS' && req.url?.startsWith('/joy/v2')) {
    if (await v2.handle(req, res)) return;
  }
  if (!gate.allows(req)) return gate.rejectHttp(res);
  if (handleDocs(req, res, { version: '0.2.0', routeTable: { routes: v2.routeTable(), served: true } })) return;
  if (await v2.handle(req, res)) return;
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'not_found', relay: 'joy-relay' }));
});

// No WebSocket surface: the protocol is HTTP + SSE + long-poll only.
server.on('upgrade', (req, socket) => {
  socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
  socket.destroy();
});

server.listen(LISTEN, '127.0.0.1', () => {
  console.log(`[joy-relay] listening :${LISTEN} (data ${DATA_DIR}, token issuers ${ISSUERS.join(',')})`);
});
