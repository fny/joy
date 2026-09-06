// Shared in-process relay for the wave-d suites: real HTTP, real PGlite
// (in-memory), a fake app (static bearer tokens) and a fake daemon speaking
// only /joy/v2. Each suite starts its own instance so they stay independent.
import { expect } from 'vitest';
import * as http from 'node:http';
import { randomUUID } from 'node:crypto';
import { openDb } from '../src/db.mjs';
import { createCore } from '../src/core.mjs';
import { createNotify } from '../src/notify.mjs';
import { createV2Router } from '../src/v2.mjs';
import { createTunnel } from '../src/tunnel.mjs';
import { createAttachments } from '../src/attachments.mjs';

const TOKENS = new Map([['app-token', 'account-1'], ['other-token', 'account-2']]);

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function startRelay({ tunnel: tunnelOpts = {} } = {}) {
  const db = await openDb(':memory:');
  const notify = createNotify();
  const core = createCore(db, notify);
  const auth = { verifyToken: async (t) => TOKENS.get(t) ?? null };
  const tunnel = createTunnel({ notify, ...tunnelOpts });
  const attachments = createAttachments(db);
  const v2 = createV2Router({ core, auth, notify, db, tunnel, attachments });
  const server = http.createServer(async (req, res) => {
    if (await v2.handle(req, res)) return;
    res.writeHead(599); res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  async function call(method, path, { body, token = 'app-token', headers = {}, raw } = {}) {
    const r = await fetch(base + path, {
      method,
      headers: raw !== undefined
        ? { authorization: `Bearer ${token}`, ...headers }
        : { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...headers },
      body: raw !== undefined ? raw : (body === undefined ? undefined : JSON.stringify(body)),
    });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-json */ }
    return { status: r.status, json, text, headers: r.headers };
  }

  /** Fake daemon speaking ONLY v2 daemon paths. */
  function makeDaemon(daemonId, token = 'app-token') {
    const d = { daemonId, leaseId: null, token: null, epoch: null };
    d.headers = () => ({ 'x-joy-lease-id': d.leaseId, 'x-joy-lease-token': d.token, 'x-joy-lease-epoch': d.epoch });
    d.acquire = async () => {
      const { status, json } = await call('POST', '/joy/v2/daemon/leases', { body: { machineId: daemonId }, token });
      expect(status).toBe(200);
      d.leaseId = json.leaseId; d.token = json.leaseToken; d.epoch = json.epoch;
      return json;
    };
    d.claim = async (lane, body = { noWait: true }) => {
      const { status, json } = await call('POST', `/joy/v2/daemon/leases/${d.leaseId}/claims/${lane}`, {
        body, headers: { 'x-joy-lease-token': d.token },
      });
      expect(status).toBe(200);
      return json.offers ?? json.requests;
    };
    d.received = (deliveryId) => call('POST', `/joy/v2/daemon/deliveries/${deliveryId}/received`, { headers: d.headers() });
    d.submitted = (turnId) => call('POST', `/joy/v2/daemon/turns/${turnId}/submitted`, { headers: d.headers() });
    d.start = (turnId, body = {}) => call('POST', `/joy/v2/daemon/turns/${turnId}/start`, { body, headers: d.headers() });
    d.fact = (turnId, body) => call('POST', `/joy/v2/daemon/turns/${turnId}/facts`, { body, headers: d.headers() });
    d.bind = (sessionId, body) => call('POST', `/joy/v2/daemon/sessions/${sessionId}/bind`, { body, headers: d.headers() });
    d.card = (sessionId, body) => call('PATCH', `/joy/v2/daemon/sessions/${sessionId}`, { body, headers: d.headers() });
    d.spawnFailed = (sessionId, body) => call('POST', `/joy/v2/daemon/sessions/${sessionId}/spawn-failed`, { body, headers: d.headers() });
    d.frames = (requestId, chunk, done) => call('POST', `/joy/v2/daemon/tunnel/${requestId}/frames${done ? '?done=1' : ''}`, {
      raw: chunk, headers: { 'x-joy-lease-id': d.leaseId, 'x-joy-lease-token': d.token, 'content-type': 'application/octet-stream' },
    });
    return d;
  }

  async function makeSession(daemon) {
    const { status, json } = await call('POST', '/joy/v2/sessions', {
      body: {
        mode: 'announce_existing', creationIntentId: randomUUID(), daemonId: daemon.daemonId,
        localSessionId: randomUUID().slice(0, 8), sessionKeyEnvelope: 'wrapped-key',
      },
    });
    expect(status).toBe(200);
    return json.sessionId;
  }

  const post = (sessionId, body) => call('POST', `/joy/v2/sessions/${sessionId}/messages`, { body });
  const getMsg = (sessionId, id) => call('GET', `/joy/v2/sessions/${sessionId}/messages/${id}`);
  const offerFor = (offers, sessionId, kind = 'prompt') => offers.find((o) => o.sessionId === sessionId && o.kind === kind);

  return {
    base, db, core, notify, tunnel, attachments,
    call, makeDaemon, makeSession, post, getMsg, offerFor,
    async close() { server.close(); await db.close(); },
  };
}
