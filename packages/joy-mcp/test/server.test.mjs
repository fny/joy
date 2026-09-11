// End to end over a REAL relay (the relay package's in-memory harness): a
// fake daemon announces a session with a real key envelope and a sealed
// card, the MCP server pairs to the account's content key, and an MCP
// client — the SDK's own — lists, reads, sends, and waits for the turn the
// fake daemon completes. The tunnel is answered by the fake daemon too, so
// check / approvals / abort go through the sealed path end to end.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import * as http from 'node:http';
import { openDb } from '../../joy-relay/src/db.mjs';
import { createCore } from '../../joy-relay/src/core.mjs';
import { createNotify } from '../../joy-relay/src/notify.mjs';
import { createV2Router } from '../../joy-relay/src/v2.mjs';
import { createTunnel } from '../../joy-relay/src/tunnel.mjs';
import { createAttachments } from '../../joy-relay/src/attachments.mjs';
import { createTokenAuthority } from '../../joy-relay/src/tokens.mjs';
import { createAccounts } from '../../joy-relay/src/accounts.mjs';
import { createAutomations } from '../../joy-relay/src/automations.mjs';
import { createAuth } from '../../joy-relay/src/auth.mjs';
import { loginWithSecret } from '../src/relay.mjs';

/** A full relay — accounts, pairing, machines, sessions, tunnel — in memory. */
async function startRelay() {
  const db = await openDb(':memory:');
  const notify = createNotify();
  const core = createCore(db, notify);
  const tokens = await createTokenAuthority({ secret: 'test-secret-test-secret', issuers: ['joy'] });
  const accounts = createAccounts(db, tokens, { fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ data: [] }) }) });
  const auth = createAuth({ tokens, accounts });
  const tunnel = createTunnel({ notify });
  const attachments = createAttachments(db);
  const automations = createAutomations(db, core, notify);
  core.setAutomationHook(automations.onEvent);
  const v2 = createV2Router({ core, auth, notify, db, tunnel, attachments, accounts, automations });
  const server = http.createServer(async (req, res) => { if (await v2.handle(req, res)) return; res.writeHead(404); res.end(); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  let token = null;
  async function call(method, path, { body, headers = {}, raw } = {}) {
    const r = await fetch(base + path, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(raw !== undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      body: raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* non-json */ }
    return { status: r.status, json, text, headers: r.headers };
  }
  function makeDaemon(daemonId) {
    const d = { daemonId, leaseId: null, token: null, epoch: null };
    d.headers = () => ({ 'x-joy-lease-id': d.leaseId, 'x-joy-lease-token': d.token, 'x-joy-lease-epoch': d.epoch });
    d.acquire = async () => { const { status, json } = await call('POST', '/joy/v2/daemon/leases', { body: { machineId: daemonId } }); expect(status).toBe(200); d.leaseId = json.leaseId; d.token = json.leaseToken; d.epoch = json.epoch; return json; };
    d.claim = async (lane, body = { noWait: true }) => { const { status, json } = await call('POST', `/joy/v2/daemon/leases/${d.leaseId}/claims/${lane}`, { body, headers: { 'x-joy-lease-token': d.token } }); expect(status).toBe(200); return json.offers ?? json.requests; };
    d.received = (deliveryId) => call('POST', `/joy/v2/daemon/deliveries/${deliveryId}/received`, { headers: d.headers() });
    d.submitted = (turnId) => call('POST', `/joy/v2/daemon/turns/${turnId}/submitted`, { headers: d.headers() });
    d.start = (turnId, body = {}) => call('POST', `/joy/v2/daemon/turns/${turnId}/start`, { body, headers: d.headers() });
    d.fact = (turnId, body) => call('POST', `/joy/v2/daemon/turns/${turnId}/facts`, { body, headers: d.headers() });
    d.frames = (requestId, chunk, done) => call('POST', `/joy/v2/daemon/tunnel/${requestId}/frames${done ? '?done=1' : ''}`, { raw: chunk, headers: { 'x-joy-lease-id': d.leaseId, 'x-joy-lease-token': d.token, 'content-type': 'application/octet-stream' } });
    return d;
  }
  return { base, call, makeDaemon, setToken: (t) => { token = t; }, async close() { server.close(); await db.close(); } };
}
import {
  contentKeyPair, sealSessionKeyEnvelope, sealCard, sealMachineKey, sealMachineMetadata, sealV2Json, openPayload,
  deriveTunnelKey, openTunnelRequest, sealTunnelResponse, utf8, fromUtf8,
} from '../src/crypto.mjs';
import { RelayClient } from '../src/relay.mjs';
import { SessionIndex } from '../src/model.mjs';
import { DaemonTunnel } from '../src/daemon.mjs';
import { Hub } from '../src/server.mjs';
import { FileStore, JoyOAuthProvider } from '../src/oauth.mjs';
import { createApp } from '../src/app.mjs';

const secret = new Uint8Array(randomBytes(32));
const content = contentKeyPair(secret);
const machineKey = new Uint8Array(randomBytes(32));
const MACHINE = 'mach-mcp-1';

let relay, home, httpServer, port, client, daemon, sessionId, sessionKey, provider, bearer, index;
const daemonState = { check: { state: 'idle', queue: 0, permissionMode: 'yolo' }, approvals: [], aborted: 0, tunnelRequests: [] };

/** The fake daemon: claims work and tunnel requests, answers both. */
async function pumpDaemon() {
  const offers = await daemon.claim('work', { noWait: true });
  for (const o of offers ?? []) {
    if (o.kind !== 'prompt') continue;
    await daemon.received(o.deliveryId);
    await daemon.submitted(o.turnId);
    await daemon.start(o.turnId, {});
    const prompt = openPayload(o.ciphertext, sessionKey);
    // Reply, then end the turn — sealed records the app would render.
    const rec = (ev) => sealV2Json({ v: 1, t: 'record', record: { role: 'session', content: { type: 'session', data: { time: Date.now(), turn: o.turnId, ev } } } }, sessionKey);
    await daemon.fact(o.turnId, { type: 'output', kind: 'output', ciphertext: rec({ t: 'text', text: `re: ${(prompt?.text ?? '').replace(/^<joy-message[^>]*>\s*|\s*<\/joy-message>$/g, '')}` }) });
    await daemon.fact(o.turnId, { type: 'terminal', terminalState: 'completed', ciphertext: rec({ t: 'turn-end', status: 'completed' }) });
  }
}
/** The tunnel lane is a long poll: the relay only admits a request while a
 *  daemon claim is waiting, so this loop keeps one open. */
async function tunnelLoop() {
  while (!stopped) {
    let reqs = [];
    try { reqs = await daemon.claim('tunnel', { waitMs: 500 }); } catch { break; }
    for (const r of reqs ?? []) await answerTunnel(r).catch((e) => console.error('tunnel answer failed', e));
  }
}
async function answerTunnel(r) {
  {
    const tk = deriveTunnelKey(machineKey, MACHINE);
    const wire = new Uint8Array(Buffer.from(r.payload ?? '', 'base64'));
    const req = openTunnelRequest(tk, wire);
    daemonState.tunnelRequests.push(req.head);
    let body = { ok: true };
    if (req.head.p.endsWith('/check')) body = daemonState.check;
    else if (req.head.p.endsWith('/approvals') && req.head.m === 'GET') body = { ok: true, approvals: daemonState.approvals };
    else if (req.head.p.endsWith('/approvals') && req.head.m === 'POST') { const { requestId } = JSON.parse(fromUtf8(req.body)); const i = daemonState.approvals.findIndex((a) => a.requestId === requestId); body = { ok: i >= 0 }; if (i >= 0) daemonState.approvals.splice(i, 1); }
    else if (req.head.p.endsWith('/abort')) { daemonState.aborted += 1; body = { ok: true }; }
    const reply = sealTunnelResponse(tk, { s: 200, h: { 'content-type': 'application/json' }, r: req.binding }, utf8(JSON.stringify(body)));
    await daemon.frames(r.requestId, Buffer.from(reply), true);
  }
}
let pump;
let stopped = false;

beforeAll(async () => {
  relay = await startRelay();
  home = mkdtempSync(join(tmpdir(), 'joy-mcp-test-'));
  // The real login: a signature over a challenge with the account's ed25519 key.
  const login = await loginWithSecret(relay.base, secret);
  relay.setToken(login.token);
  // A machine the account can open: its data key sealed to the content key,
  // its metadata under that key.
  const machineRow = await relay.call('POST', '/joy/v2/machines', { body: { id: MACHINE, metadata: sealMachineMetadata({ host: 'testbox', platform: 'linux', capabilities: { spawnSpecSealed: true } }, machineKey), dataEncryptionKey: sealMachineKey(machineKey, content.publicKey) } });
  expect([200, 201]).toContain(machineRow.status);
  daemon = relay.makeDaemon(MACHINE);
  await daemon.acquire();
  // A session bound with a real envelope and a sealed card.
  sessionKey = new Uint8Array(randomBytes(32));
  const local = randomUUID().slice(0, 8);
  const created = await relay.call('POST', '/joy/v2/sessions', { body: {
    mode: 'announce_existing', creationIntentId: randomUUID(), daemonId: MACHINE, localSessionId: local,
    sessionKeyEnvelope: sealSessionKeyEnvelope(sessionKey, content.publicKey),
    encryptedMetadata: sealCard({ summary: { text: 'Test session' }, path: '/home/u/proj', machineId: MACHINE, flavor: 'claude', joy__sessionId: local }, sessionKey),
  } });
  expect(created.status).toBe(200);
  sessionId = created.json.sessionId;
  // The server, pointed at the harness with its fake bearer.
  const relayClient = new RelayClient({ relayUrl: relay.base, token: login.token, renew: async () => (await loginWithSecret(relay.base, secret)).token });
  index = new SessionIndex({ relay: relayClient, contentSecret: content.secretKey, pollMs: 500 });
  const tunnel = new DaemonTunnel({ relay: relayClient, index });
  const hub = new Hub({ index, tunnel, relay: relayClient });
  provider = new JoyOAuthProvider({ store: new FileStore(home), account: null });
  bearer = provider.mintBearer('test');
  await index.refresh();
  index.start();
  const app = createApp({ hub, provider, publicUrl: 'http://127.0.0.1:0' });
  httpServer = createServer(app);
  await new Promise((r) => httpServer.listen(0, '127.0.0.1', r));
  port = httpServer.address().port;
  pump = setInterval(() => { pumpDaemon().catch(() => {}); }, 150);
  void tunnelLoop();
  client = new Client({ name: 'test', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { authorization: `Bearer ${bearer}` } } }));
}, 30_000);

afterAll(async () => {
  clearInterval(pump);
  stopped = true;
  await client?.close().catch(() => {});
  index?.stop();
  await new Promise((r) => httpServer?.close(() => r()));
  await relay?.close();
  rmSync(home, { recursive: true, force: true });
});

const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args ?? {} });
  return { ...r, data: r.structuredContent ?? JSON.parse(r.content[0].text) };
};

describe('joy-mcp over a real relay', () => {
  it('refuses without a bearer, and advertises the OAuth resource metadata', async () => {
    const r = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(r.status).toBe(401);
    expect(r.headers.get('www-authenticate')).toMatch(/resource_metadata/);
    const meta = await (await fetch(`http://127.0.0.1:${port}/.well-known/oauth-protected-resource/mcp`)).json();
    expect(meta.authorization_servers?.length).toBe(1);
    const as = await (await fetch(`http://127.0.0.1:${port}/.well-known/oauth-authorization-server`)).json();
    expect(as.registration_endpoint).toMatch(/\/register$/);
  });

  it('lists the session with its machine, folder, title and state, opened with the content key', async () => {
    const { data } = await call('list_sessions');
    expect(data.count).toBe(1);
    const s = data.sessions[0];
    expect(s).toMatchObject({ machine: { id: MACHINE, name: 'testbox', online: true }, harness: 'claude', cwd: '/home/u/proj', title: 'Test session', state: 'waiting', check_state: 'idle' });
    expect(s.id).toHaveLength(8);
  });

  it('check goes through the sealed tunnel to the daemon', async () => {
    const { data: s } = await call('list_sessions');
    const { data } = await call('check', { session: s.sessions[0].id });
    expect(data.state).toBe('idle');
    expect(data.via).toBeUndefined(); // the daemon answered, not the relay fallback
    expect(daemonState.tunnelRequests.some((h) => h.p.endsWith('/check'))).toBe(true);
  });

  it('ask sends through the durable queue and returns the reply of its own turn; session shows both rows', async () => {
    const { data: s } = await call('list_sessions');
    const id = s.sessions[0].id;
    const { data } = await call('ask', { session: id, text: 'ping', timeout_s: 15 });
    expect(data.outcome).toBe('answered');
    expect(data.text).toBe('re: ping');
    const { data: full } = await call('session', { session: id });
    const roles = full.messages.map((m) => [m.role, m.text]);
    expect(roles).toEqual(expect.arrayContaining([['assistant', 're: ping']]));
    const user = full.messages.find((m) => m.role === 'user');
    expect(user.text).toMatch(/^<joy-message from="mcp:[^"]+">\nping\n<\/joy-message>$/); // no reply-to by default: mcp:* is not routable
    expect(full.check.state).toBe('idle');
  }, 20_000);

  it('wait_for_turns returns the turn a later send finishes, with a cursor updates_since continues from', async () => {
    const { data: s } = await call('list_sessions');
    const id = s.sessions[0].id;
    const waiting = call('wait_for_turns', { sessions: [id], timeout_s: 15 });
    await new Promise((r) => setTimeout(r, 300));
    const { data: sent } = await call('send', { session: id, text: 'later', reply_to: 'joy:0123abcd' });
    expect(sent.turn).toBeTruthy();
    const { data } = await waiting;
    expect(data.outcome).toBe('answered');
    expect(data.events[0]).toMatchObject({ kind: 'turn_ended', session: id, text: 're: later' });
    const { data: full } = await call('session', { session: id });
    expect(full.messages.find((m) => m.role === 'user' && m.text.includes('later')).text).toContain('reply-to="joy:0123abcd"');
    const { data: upd } = await call('updates_since', { cursor: 0 });
    expect(upd.events.filter((e) => e.kind === 'turn_ended').length).toBeGreaterThanOrEqual(2);
    expect(upd.cursor).toBeGreaterThanOrEqual(data.cursor);
  }, 20_000);

  it('approvals and abort go to the daemon; a held approval reads as needs_input', async () => {
    const { data: s } = await call('list_sessions');
    const id = s.sessions[0].id;
    daemonState.approvals.push({ requestId: 'apr-1', kind: 'command', title: 'rm -rf build', since: Date.now() });
    daemonState.check = { state: 'needs_input', approvals: daemonState.approvals, queue: 0, permissionMode: 'yolo' };
    const { data: ck } = await call('check', { session: id });
    expect(ck.state).toBe('needs_input');
    const { data: list } = await call('approvals', { session: id });
    expect(list.approvals).toEqual([expect.objectContaining({ request_id: 'apr-1', title: 'rm -rf build' })]);
    const { data: ok } = await call('approve', { session: id });
    expect(ok).toMatchObject({ ok: true, request_id: 'apr-1' });
    expect(daemonState.approvals).toEqual([]);
    daemonState.check = { state: 'idle', queue: 0, permissionMode: 'yolo' };
    const { data: ab } = await call('abort', { session: id });
    expect(ab.ok).toBe(true);
    expect(daemonState.aborted).toBe(1);
  }, 20_000);

  it('a resource subscription is notified when a turn ends', async () => {
    const { data: s } = await call('list_sessions');
    const id = s.sessions[0].id;
    const updated = [];
    client.setNotificationHandler((await import('@modelcontextprotocol/sdk/types.js')).ResourceUpdatedNotificationSchema, (n) => { updated.push(n.params.uri); });
    await client.subscribeResource({ uri: `joy://sessions/${id}` });
    await call('ask', { session: id, text: 'notify me', timeout_s: 15 });
    await new Promise((r) => setTimeout(r, 300));
    expect(updated).toContain(`joy://sessions/${id}`);
    const res = await client.readResource({ uri: `joy://sessions/${id}` });
    expect(res.contents[0].text).toContain('re: notify me');
  }, 20_000);

  it('unknown sessions and the ended path answer with the table\'s errors', async () => {
    const { data } = await call('check', { session: 'deadbeef' });
    expect(data.error).toBe('session_not_found');
  });
});
