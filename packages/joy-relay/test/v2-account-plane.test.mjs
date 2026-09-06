// The account plane of /joy/v2, served natively: login, pairing, profile,
// machines, push and the daemon's session-card publish. With these, a client
// needs NOTHING outside /joy/v2 — this suite pins that contract.
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

let server, base, db, core, notify, tokens, accounts;
let expoCalls;

/** ed25519 identity → the base64 fields /auth expects. */
function identity() {
  const kp = generateKeyPairSync('ed25519');
  const raw = kp.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  return {
    publicKey: raw.toString('base64'),
    signChallenge: (challenge) => sign(null, challenge, kp.privateKey).toString('base64'),
  };
}
async function loginNew() {
  const id = identity();
  const challenge = randomBytes(32);
  const r = await call('POST', '/joy/v2/auth', {
    token: null, body: { publicKey: id.publicKey, challenge: challenge.toString('base64'), signature: id.signChallenge(challenge) },
  });
  expect(r.status).toBe(200);
  expect(r.json.success).toBe(true);
  return { ...id, token: r.json.token };
}

let APP; // the default caller
let OTHER;

beforeAll(async () => {
  expoCalls = [];
  db = await openDb(':memory:');
  notify = createNotify();
  core = createCore(db, notify);
  tokens = await createTokenAuthority({ secret: 'test-secret-test-secret', issuers: ['joy', 'legacy'] });
  // Fake Expo: records each push request and answers a ticket per message.
  const fakeFetch = async (url, init) => {
    const body = JSON.parse(init.body);
    expoCalls.push(body[0]);
    const to = body[0].to;
    const ticket = to.includes('dead')
      ? { status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } }
      : { status: 'ok', id: 'ticket' };
    return { ok: true, status: 200, json: async () => ({ data: [ticket] }) };
  };
  accounts = createAccounts(db, tokens, { fetchImpl: fakeFetch });
  const auth = createAuth({ tokens, accounts });
  const tunnel = createTunnel({ notify });
  const attachments = createAttachments(db);
  const v2 = createV2Router({ core, auth, notify, db, tunnel, attachments, accounts });
  server = http.createServer(async (req, res) => {
    if (await v2.handle(req, res)) return;
    res.writeHead(599); res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  APP = await loginNew();
  OTHER = await loginNew();
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

function makeDaemon(daemonId, token) {
  const d = { daemonId, leaseId: null, token: null, epoch: null };
  d.headers = () => ({ 'x-joy-lease-id': d.leaseId, 'x-joy-lease-token': d.token, 'x-joy-lease-epoch': d.epoch });
  d.acquire = async () => {
    const r = await call('POST', '/joy/v2/daemon/leases', { body: { machineId: daemonId }, token });
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

describe('login + tokens', () => {
  it('a bad signature is refused; a good one creates the account and mints a token', async () => {
    const id = identity();
    const challenge = randomBytes(32);
    const bad = await call('POST', '/joy/v2/auth', {
      token: null, body: { publicKey: id.publicKey, challenge: challenge.toString('base64'), signature: Buffer.alloc(64).toString('base64') },
    });
    expect(bad.status).toBe(401);
    const good = await loginNew();
    const p = await call('GET', '/joy/v2/account/profile', { token: good.token });
    expect(p.status).toBe(200);
    expect(p.json.publicKey).toBe(Buffer.from(good.publicKey, 'base64').toString('hex').toUpperCase());
  });

  it('logging in twice with the same key yields the same account', async () => {
    const id = identity();
    const once = async () => {
      const challenge = randomBytes(32);
      const r = await call('POST', '/joy/v2/auth', {
        token: null, body: { publicKey: id.publicKey, challenge: challenge.toString('base64'), signature: id.signChallenge(challenge) },
      });
      return (await call('GET', '/joy/v2/account/profile', { token: r.json.token })).json.id;
    };
    expect(await once()).toBe(await once());
  });

  it('tokens from every configured issuer verify; unknown issuers and forgeries do not', async () => {
    const { id } = (await call('GET', '/joy/v2/account/profile')).json;
    const legacy = await createTokenAuthority({ secret: 'test-secret-test-secret', issuers: ['legacy'] });
    expect((await call('GET', '/joy/v2/account/profile', { token: legacy.mint(id) })).status).toBe(200);
    const stranger = await createTokenAuthority({ secret: 'test-secret-test-secret', issuers: ['stranger'] });
    expect((await call('GET', '/joy/v2/account/profile', { token: stranger.mint(id) })).status).toBe(401);
    const wrongSecret = await createTokenAuthority({ secret: 'another-secret-entirely', issuers: ['joy'] });
    expect((await call('GET', '/joy/v2/account/profile', { token: wrongSecret.mint(id) })).status).toBe(401);
    // a valid signature over an account that does not exist is still 401
    expect((await call('GET', '/joy/v2/account/profile', { token: tokens.mint('ghost') })).status).toBe(401);
    expect((await call('GET', '/joy/v2/machines', { token: 'bogus' })).status).toBe(401);
  });
});

describe('pairing', () => {
  const ephemeral = () => randomBytes(32).toString('base64');

  it('terminal: request → pending → response → authorized with token + sealed blob', async () => {
    const pk = ephemeral();
    const nf = await call('GET', `/joy/v2/auth/request/status?publicKey=${encodeURIComponent(pk)}`, { token: null });
    expect(nf.json).toEqual({ status: 'not_found', supportsV2: false });
    const req = await call('POST', '/joy/v2/auth/request', { token: null, body: { publicKey: pk, supportsV2: true } });
    expect(req.json).toEqual({ state: 'requested' });
    const pending = await call('GET', `/joy/v2/auth/request/status?publicKey=${encodeURIComponent(pk)}`, { token: null });
    expect(pending.json).toEqual({ status: 'pending', supportsV2: true });
    // answering needs auth
    expect((await call('POST', '/joy/v2/auth/response', { token: null, body: { publicKey: pk, response: 'sealed' } })).status).toBe(401);
    const ans = await call('POST', '/joy/v2/auth/response', { body: { publicKey: pk, response: 'sealed-1' } });
    expect(ans.json).toEqual({ success: true });
    // first write wins
    await call('POST', '/joy/v2/auth/response', { token: OTHER.token, body: { publicKey: pk, response: 'sealed-2' } });
    const poll = await call('POST', '/joy/v2/auth/request', { token: null, body: { publicKey: pk } });
    expect(poll.json.state).toBe('authorized');
    expect(poll.json.response).toBe('sealed-1');
    // the minted token belongs to the ANSWERING account
    const me = await call('GET', '/joy/v2/account/profile', { token: poll.json.token });
    expect(me.json.id).toBe((await call('GET', '/joy/v2/account/profile')).json.id);
    const done = await call('GET', `/joy/v2/auth/request/status?publicKey=${encodeURIComponent(pk)}`, { token: null });
    expect(done.json.status).toBe('authorized');
    // The answer is collected ONCE (#70): a second poll — anyone who saw the
    // public key in the QR — gets neither the token nor the sealed blob.
    const again = await call('POST', '/joy/v2/auth/request', { token: null, body: { publicKey: pk } });
    expect(again.json).toMatchObject({ state: 'consumed', error: 'pairing_answer_already_collected' }); // legible, #607
    expect(again.json.token).toBeUndefined();
  });

  it('account flavour is independent of terminal flavour; unknown keys 404 on response', async () => {
    const pk = ephemeral();
    expect((await call('POST', '/joy/v2/auth/response', { body: { publicKey: pk, response: 'x' } })).status).toBe(404);
    const req = await call('POST', '/joy/v2/auth/account/request', { token: null, body: { publicKey: pk } });
    expect(req.json).toEqual({ state: 'requested' });
    // a terminal-flavoured answer does not satisfy the account request
    expect((await call('POST', '/joy/v2/auth/response', { body: { publicKey: pk, response: 'x' } })).status).toBe(404);
    const ans = await call('POST', '/joy/v2/auth/account/response', { body: { publicKey: pk, response: 'sealed-acct' } });
    expect(ans.status).toBe(200);
    const poll = await call('POST', '/joy/v2/auth/account/request', { token: null, body: { publicKey: pk } });
    expect(poll.json.state).toBe('authorized');
    expect(poll.json.response).toBe('sealed-acct');
  });

  it('rejects malformed keys', async () => {
    const r = await call('POST', '/joy/v2/auth/request', { token: null, body: { publicKey: Buffer.alloc(5).toString('base64') } });
    expect(r.status).toBe(401);
  });
});

describe('machines', () => {
  it('upsert creates, replaces the blob with a version bump, and lists with lease liveness', async () => {
    const c = await call('POST', '/joy/v2/machines', { body: { id: 'mach-live', metadata: 'enc-m1', dataEncryptionKey: 'dek-1' } });
    expect(c.status).toBe(200);
    expect(c.json.machine).toMatchObject({ id: 'mach-live', metadata: 'enc-m1', metadataVersion: 1, daemonStateVersion: 0, dataEncryptionKey: 'dek-1', active: false });
    const same = await call('POST', '/joy/v2/machines', { body: { id: 'mach-live', metadata: 'enc-m1' } });
    expect(same.json.machine.metadataVersion).toBe(1);
    expect(same.json.machine.dataEncryptionKey).toBe('dek-1'); // carried forward
    const changed = await call('POST', '/joy/v2/machines', { body: { id: 'mach-live', metadata: 'enc-m1b' } });
    expect(changed.json.machine.metadataVersion).toBe(2);
    await call('POST', '/joy/v2/machines', { body: { id: 'mach-dead', metadata: 'enc-m2' } });

    const d = makeDaemon('mach-live');
    await d.acquire();
    const r = await call('GET', '/joy/v2/machines');
    expect(r.status).toBe(200);
    const byId = Object.fromEntries(r.json.machines.map((m) => [m.id, m]));
    expect(byId['mach-live'].leaseAlive).toBe(true);
    expect(byId['mach-live'].active).toBe(true);
    expect(byId['mach-dead'].leaseAlive).toBe(false);
    expect(byId['mach-dead'].active).toBe(false);
    expect(byId['mach-live'].activeAt).toBeGreaterThan(Date.now() - 10_000);
    const one = await call('GET', '/joy/v2/machines/mach-live');
    expect(one.json.machine.metadata).toBe('enc-m1b');
  });

  it('daemonState PATCH is a CAS; a stale version answers version-mismatch with the current one', async () => {
    await call('POST', '/joy/v2/machines', { body: { id: 'mach-cas', metadata: 'm' } });
    const ok = await call('PATCH', '/joy/v2/machines/mach-cas', { body: { daemonState: 's1', expectedDaemonStateVersion: 0 } });
    expect(ok.json).toMatchObject({ result: 'success', daemonStateVersion: 1 });
    const stale = await call('PATCH', '/joy/v2/machines/mach-cas', { body: { daemonState: 's2', expectedDaemonStateVersion: 0 } });
    expect(stale.json).toMatchObject({ result: 'version-mismatch', daemonStateVersion: 1 });
    const meta = await call('PATCH', '/joy/v2/machines/mach-cas', { body: { metadata: 'renamed', expectedMetadataVersion: 1 } });
    expect(meta.json).toMatchObject({ result: 'success', metadataVersion: 2 });
    const got = await call('GET', '/joy/v2/machines/mach-cas');
    expect(got.json.machine).toMatchObject({ metadata: 'renamed', daemonState: 's1' });
    expect((await call('PATCH', '/joy/v2/machines/mach-cas', { body: {} })).status).toBe(400);
  });

  it('upsert with expectedMetadataVersion is conditional: a rename that landed in between is refused with 409, never replaced (#61)', async () => {
    // The daemon's key repair: CAS PATCH of the blob, then the full POST of
    // that SAME blob carrying the key, conditioned on the version the PATCH
    // produced. The app renames between the two.
    const c = await call('POST', '/joy/v2/machines', { body: { id: 'mach-cond', metadata: 'blob-v1' } });
    expect(c.json.machine).toMatchObject({ metadataVersion: 1, dataEncryptionKey: null });
    const cas = await call('PATCH', '/joy/v2/machines/mach-cond', { body: { metadata: 'blob-daemon', expectedMetadataVersion: 1 } });
    expect(cas.json).toMatchObject({ result: 'success', metadataVersion: 2 });
    // The app's rename lands first.
    const rename = await call('PATCH', '/joy/v2/machines/mach-cond', { body: { metadata: 'blob-renamed', expectedMetadataVersion: 2 } });
    expect(rename.json).toMatchObject({ result: 'success', metadataVersion: 3 });
    const stale = await call('POST', '/joy/v2/machines', { body: { id: 'mach-cond', metadata: 'blob-daemon', dataEncryptionKey: 'dek-repair', expectedMetadataVersion: 2 } });
    expect(stale.status).toBe(409);
    expect(stale.json).toEqual({ error: 'metadata_version_mismatch' });
    const after = await call('GET', '/joy/v2/machines/mach-cond');
    expect(after.json.machine).toMatchObject({ metadata: 'blob-renamed', metadataVersion: 3, dataEncryptionKey: null }); // nothing replaced, no key landed
    // The daemon re-reads (version 3), CAS-writes the rename forward, then repairs at the version that write produced.
    const again = await call('PATCH', '/joy/v2/machines/mach-cond', { body: { metadata: 'blob-daemon-2', expectedMetadataVersion: 3 } });
    expect(again.json).toMatchObject({ result: 'success', metadataVersion: 4 });
    const ok = await call('POST', '/joy/v2/machines', { body: { id: 'mach-cond', metadata: 'blob-daemon-2', dataEncryptionKey: 'dek-repair', expectedMetadataVersion: 4 } });
    expect(ok.status).toBe(200);
    expect(ok.json.machine).toMatchObject({ metadata: 'blob-daemon-2', metadataVersion: 4, dataEncryptionKey: 'dek-repair' }); // unchanged blob keeps the version
    // A missing row is a mismatch too (a repair must not resurrect a deleted machine)…
    const missing = await call('POST', '/joy/v2/machines', { body: { id: 'mach-cond-none', metadata: 'x', expectedMetadataVersion: 1 } });
    expect(missing.status).toBe(409);
    expect((await call('GET', '/joy/v2/machines/mach-cond-none')).status).toBe(404);
    // …a malformed precondition is a 400, and an old daemon omitting the field keeps the unconditional replace.
    expect((await call('POST', '/joy/v2/machines', { body: { id: 'mach-cond', metadata: 'x', expectedMetadataVersion: 'soon' } })).status).toBe(400);
    const blind = await call('POST', '/joy/v2/machines', { body: { id: 'mach-cond', metadata: 'blob-old-daemon' } });
    expect(blind.json.machine).toMatchObject({ metadata: 'blob-old-daemon', metadataVersion: 5 });
  });

  it('is scoped to the owning account', async () => {
    await call('POST', '/joy/v2/machines', { body: { id: 'mach-mine', metadata: 'm' } });
    expect((await call('GET', '/joy/v2/machines/mach-mine', { token: OTHER.token })).status).toBe(404);
    expect((await call('POST', '/joy/v2/machines', { token: OTHER.token, body: { id: 'mach-mine', metadata: 'steal' } })).status).toBe(403);
    expect((await call('DELETE', '/joy/v2/machines/mach-mine', { token: OTHER.token })).status).toBe(404);
    expect((await call('DELETE', '/joy/v2/machines/mach-mine')).status).toBe(200);
    expect((await call('GET', '/joy/v2/machines/mach-mine')).status).toBe(404);
  });
});

describe('push', () => {
  it('registers tokens idempotently, lists, deletes', async () => {
    expect((await call('POST', '/joy/v2/push-tokens', { body: { token: 'ExponentPushToken[a]' } })).status).toBe(200);
    expect((await call('POST', '/joy/v2/push-tokens', { body: { token: 'ExponentPushToken[a]' } })).status).toBe(200);
    expect((await call('POST', '/joy/v2/push-tokens', { body: { token: 'ExponentPushToken[dead]' } })).status).toBe(200);
    const list = await call('GET', '/joy/v2/push-tokens');
    expect(list.json.tokens.map((t) => t.token).sort()).toEqual(['ExponentPushToken[a]', 'ExponentPushToken[dead]']);
    expect((await call('GET', '/joy/v2/push-tokens', { token: OTHER.token })).json.tokens).toEqual([]);
    expect((await call('POST', '/joy/v2/push-tokens', { body: {} })).status).toBe(400);
  });

  it('delivers one Expo request per token and drops DeviceNotRegistered tokens', async () => {
    const r = await call('POST', '/joy/v2/push', { body: { title: 'Done', body: 'finished', data: { sessionId: 's1' } } });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ sent: 1, targeted: 2 });
    expect(r.json.errors).toHaveLength(1);
    expect(expoCalls.map((c) => c.to).sort()).toEqual(['ExponentPushToken[a]', 'ExponentPushToken[dead]']);
    expect(expoCalls[0]).toMatchObject({ title: 'Done', body: 'finished', sound: 'default' });
    expect(expoCalls[0].data.sessionId).toBe('s1');
    const list = await call('GET', '/joy/v2/push-tokens');
    expect(list.json.tokens.map((t) => t.token)).toEqual(['ExponentPushToken[a]']);
    expect((await call('DELETE', '/joy/v2/push-tokens/ExponentPushToken%5Ba%5D')).status).toBe(200);
    expect((await call('GET', '/joy/v2/push-tokens')).json.tokens).toEqual([]);
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
    const thief = makeDaemon('mach-thief', OTHER.token); await thief.acquire();
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
