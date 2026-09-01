// The account-plane completion of /joy/v2: machines, auth, profile, push and
// the daemon's session-card publish. With these, a client needs NOTHING
// outside /joy/v2 — this suite pins that contract.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import { openDb } from '../src/db.mjs';
import { createCore } from '../src/core.mjs';
import { createNotify } from '../src/notify.mjs';
import { createV2Router } from '../src/v2.mjs';
import { createTunnel } from '../src/tunnel.mjs';
import { createAttachments } from '../src/attachments.mjs';

const TOKENS = new Map([['app-token', 'account-1'], ['other-token', 'account-2']]);

let server, base, db, core, notify;
let upstreamServer, upstreamCalls;

beforeAll(async () => {
  // Fake upstream account authority: records every call so the tests can
  // assert the delegation happened with the caller's bearer, verbatim body.
  upstreamCalls = [];
  upstreamServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      upstreamCalls.push({ method: req.method, url: req.url, auth: req.headers.authorization ?? null, body });
      if (req.url === '/v1/machines') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify([
          { id: 'mach-live', metadata: 'enc-m1', dataEncryptionKey: 'dek-1', active: true },
          { id: 'mach-dead', metadata: 'enc-m2', dataEncryptionKey: 'dek-2', active: true },
        ]));
        return;
      }
      if (req.url === '/v1/auth/request') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ state: 'requested' }));
        return;
      }
      if (req.url === '/v1/account/profile') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'account-1', timestamp: 1 }));
        return;
      }
      if (req.url === '/v1/push-tokens') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'nope' }));
    });
  });
  await new Promise((r) => upstreamServer.listen(0, '127.0.0.1', r));

  db = await openDb(':memory:');
  notify = createNotify();
  core = createCore(db, notify);
  const auth = { verifyToken: async (t) => TOKENS.get(t) ?? null };
  const tunnel = createTunnel({ notify });
  const attachments = createAttachments(db);
  const v2 = createV2Router({
    core, auth, notify, db, tunnel, attachments,
    upstream: { host: '127.0.0.1', port: upstreamServer.address().port },
  });
  server = http.createServer(async (req, res) => {
    if (await v2.handle(req, res)) return;
    res.writeHead(599); res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  server.close(); upstreamServer.close();
  await db.close();
});

async function call(method, path, { body, token = 'app-token', headers = {} } = {}) {
  const r = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* */ }
  return { status: r.status, json };
}

function makeDaemon(daemonId) {
  const d = { daemonId, leaseId: null, token: null, epoch: null };
  d.headers = () => ({ 'x-joy-lease-id': d.leaseId, 'x-joy-lease-token': d.token, 'x-joy-lease-epoch': d.epoch });
  d.acquire = async () => {
    const r = await call('POST', '/joy/v2/daemon/leases', { body: { machineId: daemonId } });
    expect(r.status).toBe(200);
    d.leaseId = r.json.leaseId; d.token = r.json.leaseToken; d.epoch = String(r.json.epoch);
  };
  return d;
}

async function spawnBound(d) {
  const created = await call('POST', '/joy/v2/sessions', {
    body: { mode: 'spawn', daemonId: d.daemonId, creationIntentId: `i-${Math.random()}`, spawnSpec: '{"t":"spawn","cwd":"/tmp/x"}' },
  });
  expect(created.status).toBe(200);
  const sid = created.json.sessionId;
  const claim = await call('POST', `/joy/v2/daemon/leases/${d.leaseId}/claims/work`, { body: { noWait: true }, headers: d.headers(), token: null });
  const offer = claim.json.offers.find((o) => o.sessionId === sid);
  expect(offer).toBeTruthy();
  await call('POST', `/joy/v2/daemon/deliveries/${offer.deliveryId}/received`, { headers: d.headers(), token: null, body: {} });
  const bind = await call('POST', `/joy/v2/daemon/sessions/${sid}/bind`, {
    headers: d.headers(), token: null,
    body: { spawnCommandId: offer.commandId, localSessionId: 'loc1', sessionKeyEnvelope: 'v2sk1:test' },
  });
  expect(bind.status).toBe(200);
  return sid;
}

describe('machines', () => {
  it('lists upstream machines with the caller bearer and merges lease liveness', async () => {
    const d = makeDaemon('mach-live');
    await d.acquire();
    const r = await call('GET', '/joy/v2/machines');
    expect(r.status).toBe(200);
    const byId = Object.fromEntries(r.json.machines.map((m) => [m.id, m]));
    expect(byId['mach-live'].leaseAlive).toBe(true);
    expect(byId['mach-dead'].leaseAlive).toBe(false);
    expect(byId['mach-live'].dataEncryptionKey).toBe('dek-1');
    // the delegation used the CALLER's token, not a relay credential
    const up = upstreamCalls.find((c) => c.url === '/v1/machines');
    expect(up.auth).toBe('Bearer app-token');
  });

  it('requires auth', async () => {
    const r = await call('GET', '/joy/v2/machines', { token: 'bogus' });
    expect(r.status).toBe(401);
  });
});

describe('auth + profile + push delegation', () => {
  it('auth/request needs no auth and forwards the body', async () => {
    const r = await call('POST', '/joy/v2/auth/request', { token: null, body: { publicKey: 'pk1', supportsV2: true } });
    expect(r.status).toBe(200);
    expect(r.json.state).toBe('requested');
    const up = upstreamCalls.find((c) => c.url === '/v1/auth/request');
    expect(JSON.parse(up.body).publicKey).toBe('pk1');
  });

  it('profile and push ride the caller bearer', async () => {
    const p = await call('GET', '/joy/v2/account/profile');
    expect(p.status).toBe(200);
    expect(p.json.id).toBe('account-1');
    const push = await call('POST', '/joy/v2/push-tokens', { body: { token: 'expo-tok' } });
    expect(push.status).toBe(200);
    const up = upstreamCalls.filter((c) => c.url === '/v1/push-tokens').pop();
    expect(up.auth).toBe('Bearer app-token');
  });
});

describe('session card publish (daemon PATCH)', () => {
  it('daemon publishes encrypted metadata + state; list reflects it with liveness', async () => {
    const d = makeDaemon('mach-card');
    await d.acquire();
    const sid = await spawnBound(d);
    const patch = await call('PATCH', `/joy/v2/daemon/sessions/${sid}`, {
      headers: d.headers(), token: null,
      body: { encryptedMetadata: 'v2e1:sealed-card', state: 'active' },
    });
    expect(patch.status).toBe(200);
    const list = await call('GET', '/joy/v2/sessions');
    const row = list.json.sessions.find((s) => s.sessionId === sid);
    expect(row.encryptedMetadata).toBe('v2e1:sealed-card');
    expect(row.state).toBe('active');
    expect(row.online).toBe(true); // lease alive
    expect(typeof row.updatedAt).toBe('number');
  });

  it('a foreign daemon cannot write the card', async () => {
    const owner = makeDaemon('mach-own'); await owner.acquire();
    const sid = await spawnBound(owner);
    const thief = makeDaemon('mach-thief'); await thief.acquire();
    const r = await call('PATCH', `/joy/v2/daemon/sessions/${sid}`, {
      headers: thief.headers(), token: null, body: { state: 'archived' },
    });
    expect(r.status).toBe(403);
  });

  it('rejects an invalid lifecycle state', async () => {
    const d = makeDaemon('mach-bad'); await d.acquire();
    const sid = await spawnBound(d);
    const r = await call('PATCH', `/joy/v2/daemon/sessions/${sid}`, {
      headers: d.headers(), token: null, body: { state: 'exploded' },
    });
    expect(r.status).toBe(400);
  });
});
