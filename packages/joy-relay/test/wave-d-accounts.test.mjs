// Wave D (review campaign 2026-09) — account-plane fixes: pairing expiry
// (#610), the legible one-shot answer (#607), machine ids (#609) and push
// delivery isolation (#608). Same in-process relay as v2-account-plane.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import { generateKeyPairSync, sign, randomBytes } from 'node:crypto';
import { openDb } from '../src/db.mjs';
import { createCore } from '../src/core.mjs';
import { createNotify } from '../src/notify.mjs';
import { createV2Router } from '../src/v2.mjs';
import { createTunnel } from '../src/tunnel.mjs';
import { createAttachments } from '../src/attachments.mjs';
import { createTokenAuthority } from '../src/tokens.mjs';
import { createAccounts } from '../src/accounts.mjs';
import { createAuth } from '../src/auth.mjs';

let server, base, db, accounts;
let expoCalls;
let APP;

function identity() {
  const kp = generateKeyPairSync('ed25519');
  const raw = kp.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  return { publicKey: raw.toString('base64'), signChallenge: (c) => sign(null, c, kp.privateKey).toString('base64') };
}
async function loginNew() {
  const id = identity();
  const challenge = randomBytes(32);
  const r = await call('POST', '/joy/v2/auth', {
    token: null, body: { publicKey: id.publicKey, challenge: challenge.toString('base64'), signature: id.signChallenge(challenge) },
  });
  expect(r.status).toBe(200);
  return { ...id, token: r.json.token };
}

const never = new Promise(() => {});

beforeAll(async () => {
  expoCalls = [];
  db = await openDb(':memory:');
  const notify = createNotify();
  const core = createCore(db, notify);
  const tokens = await createTokenAuthority({ secret: 'test-secret-test-secret', issuers: ['joy'] });
  // Fake Expo. A token containing "stall-body" answers 200 and then never
  // finishes its JSON (and ignores the abort signal, like a trickling body);
  // "stall-fetch" never answers at all but honours the signal.
  const fakeFetch = async (url, init) => {
    const body = JSON.parse(init.body);
    expoCalls.push(body[0]);
    const to = body[0].to;
    if (to.includes('stall-fetch')) {
      return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
    }
    if (to.includes('stall-body')) return { ok: true, status: 200, json: () => never };
    return { ok: true, status: 200, json: async () => ({ data: [{ status: 'ok', id: 'ticket' }] }) };
  };
  accounts = createAccounts(db, tokens, { fetchImpl: fakeFetch, pushTimeoutMs: 200 });
  const auth = createAuth({ tokens, accounts });
  const v2 = createV2Router({ core, auth, notify, db, tunnel: createTunnel({ notify }), attachments: createAttachments(db), accounts });
  server = http.createServer(async (req, res) => {
    if (await v2.handle(req, res)) return;
    res.writeHead(599); res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  APP = await loginNew();
});

afterAll(async () => {
  server.close();
  await db.close();
});

async function call(method, path, { body, token, headers = {} } = {}) {
  const bearer = token === undefined ? APP?.token : token;
  const r = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* */ }
  return { status: r.status, json };
}

const ephemeral = () => randomBytes(32).toString('base64');
const hexOf = (pkB64) => Buffer.from(pkB64, 'base64').toString('hex').toUpperCase();
const backdate = (pk, column, interval) =>
  db.query(`UPDATE auth_requests SET ${column} = now() - interval '${interval}' WHERE public_key = $1`, [hexOf(pk)]);

describe('pairing expiry (#610)', () => {
  it('the sweep keeps a freshly answered request whose QR is older than a day', async () => {
    const pk = ephemeral();
    await call('POST', '/joy/v2/auth/request', { token: null, body: { publicKey: pk } });
    expect((await call('POST', '/joy/v2/auth/response', { body: { publicKey: pk, response: 'sealed' } })).json).toEqual({ success: true });
    // Answered a moment ago (updated_at fresh), created a day and more ago.
    await backdate(pk, 'created_at', '25 hours');
    await accounts.sweepPairings();
    const poll = await call('POST', '/joy/v2/auth/request', { token: null, body: { publicKey: pk } });
    expect(poll.json.state).toBe('authorized');
    expect(poll.json.response).toBe('sealed');
  });

  it('the sweep still removes unanswered requests past a day and answered ones past their answer window', async () => {
    const stale = ephemeral(); const old = ephemeral();
    await call('POST', '/joy/v2/auth/request', { token: null, body: { publicKey: stale } });
    await backdate(stale, 'created_at', '25 hours');
    await call('POST', '/joy/v2/auth/request', { token: null, body: { publicKey: old } });
    await call('POST', '/joy/v2/auth/response', { body: { publicKey: old, response: 'sealed' } });
    await backdate(old, 'updated_at', '11 minutes');
    await accounts.sweepPairings();
    const { rows } = await db.query(`SELECT public_key FROM auth_requests WHERE public_key = ANY($1)`, [[hexOf(stale), hexOf(old)]]);
    expect(rows).toEqual([]);
  });

  it('an expired QR cannot be approved: status reads not_found and the approval is 410, not a success that vanishes', async () => {
    const pk = ephemeral();
    await call('POST', '/joy/v2/auth/request', { token: null, body: { publicKey: pk } });
    await backdate(pk, 'created_at', '25 hours');
    const st = await call('GET', `/joy/v2/auth/request/status?publicKey=${encodeURIComponent(pk)}`, { token: null });
    expect(st.json.status).toBe('not_found');
    const ans = await call('POST', '/joy/v2/auth/response', { body: { publicKey: pk, response: 'sealed' } });
    expect(ans.status).toBe(410);
    expect(ans.json.error).toBe('request_expired');
    // The refused approval dropped the dead row: the requester's next poll
    // simply opens a fresh request.
    expect((await call('POST', '/joy/v2/auth/request', { token: null, body: { publicKey: pk } })).json.state).toBe('requested');
    // A requester polling an expired, unapproved QR hears so, then starts over.
    const pk2 = ephemeral();
    await call('POST', '/joy/v2/auth/request', { token: null, body: { publicKey: pk2 } });
    await backdate(pk2, 'created_at', '25 hours');
    expect((await call('POST', '/joy/v2/auth/request', { token: null, body: { publicKey: pk2 } })).json.state).toBe('expired');
    expect((await call('POST', '/joy/v2/auth/request', { token: null, body: { publicKey: pk2 } })).json.state).toBe('requested');
  });
});

describe('one-shot pairing answer stays one-shot, legibly (#607, by design per #70)', () => {
  it('a second poll after collection names the condition and what to do, without re-issuing credentials', async () => {
    const pk = ephemeral();
    await call('POST', '/joy/v2/auth/request', { token: null, body: { publicKey: pk } });
    await call('POST', '/joy/v2/auth/response', { body: { publicKey: pk, response: 'sealed' } });
    const first = await call('POST', '/joy/v2/auth/request', { token: null, body: { publicKey: pk } });
    expect(first.json.state).toBe('authorized');
    expect(first.json.token).toBeTruthy();
    const again = await call('POST', '/joy/v2/auth/request', { token: null, body: { publicKey: pk } });
    expect(again.status).toBe(200); // existing clients switch on `state`
    expect(again.json).toMatchObject({ state: 'consumed', error: 'pairing_answer_already_collected' });
    expect(typeof again.json.consumedAt).toBe('number');
    expect(again.json.message).toMatch(/start a new pairing/);
    expect(again.json.token).toBeUndefined();
    expect(again.json.response).toBeUndefined();
    const st = await call('GET', `/joy/v2/auth/request/status?publicKey=${encodeURIComponent(pk)}`, { token: null });
    expect(st.json).toMatchObject({ status: 'authorized', consumed: true });
  });
});

describe('machine ids (#609)', () => {
  it('"." and ".." are refused at creation; dotted names stay legal', async () => {
    for (const id of ['.', '..']) {
      const r = await call('POST', '/joy/v2/machines', { body: { id, metadata: 'm' } });
      expect(r.status).toBe(400);
      expect(r.json.error).toBe('bad_machine_id');
    }
    const ok = await call('POST', '/joy/v2/machines', { body: { id: 'host.local', metadata: 'm' } });
    expect(ok.status).toBe(200);
    expect((await call('GET', '/joy/v2/machines/host.local')).status).toBe(200);
    expect((await call('GET', '/joy/v2/machines')).json.machines.map((m) => m.id)).toEqual(['host.local']);
  });
});

describe('push delivery isolation (#608)', () => {
  it('a device whose Expo response stalls times out on its own; every other device is still contacted', async () => {
    for (const t of ['ExponentPushToken[stall-body]', 'ExponentPushToken[stall-fetch]', 'ExponentPushToken[fast-1]', 'ExponentPushToken[fast-2]']) {
      expect((await call('POST', '/joy/v2/push-tokens', { body: { token: t } })).status).toBe(200);
    }
    const started = Date.now();
    const r = await call('POST', '/joy/v2/push', { body: { title: 'Done', body: 'finished' } });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ sent: 2, targeted: 4 });
    expect(r.json.errors.map((e) => e.error)).toEqual(['timeout', 'timeout']);
    expect(r.json.errors.map((e) => e.token).sort()).toEqual(['ExponentPushToken[stall-body]'.slice(0, 24), 'ExponentPushToken[stall-fetch]'.slice(0, 24)]);
    expect(expoCalls.map((c) => c.to).sort()).toEqual([
      'ExponentPushToken[fast-1]', 'ExponentPushToken[fast-2]', 'ExponentPushToken[stall-body]', 'ExponentPushToken[stall-fetch]',
    ]);
  });
});
