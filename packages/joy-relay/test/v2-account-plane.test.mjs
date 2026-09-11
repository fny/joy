// The account plane of /joy/v2, served natively: login, pairing, profile,
// machines, push and the daemon's session-card publish. With these, a client
// needs NOTHING outside /joy/v2 — this suite pins that contract.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import { createHmac, createPublicKey, diffieHellman, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { openDb } from '../src/db.mjs';
import { createCore } from '../src/core.mjs';
import { createNotify } from '../src/notify.mjs';
import { createV2Router } from '../src/v2.mjs';
import { createTunnel } from '../src/tunnel.mjs';
import { createAttachments } from '../src/attachments.mjs';
import { createTokenAuthority } from '../src/tokens.mjs';
import { createAccounts, PAIRING_PROOF_LABEL } from '../src/accounts.mjs';
import { createAutomations } from '../src/automations.mjs';
import { createAuth } from '../src/auth.mjs';

let server, base, db, core, notify, tokens, accounts, automations;
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
  automations = createAutomations(db, core, notify);
  core.setAutomationHook(automations.onEvent);
  const v2 = createV2Router({ core, auth, notify, db, tunnel, attachments, accounts, automations });
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
  /** A terminal requester with a REAL X25519 key: since #127 the pickup must
   *  prove possession of the private half (see wave-f-pairing.test.mjs). */
  const X25519_SPKI = Buffer.from('302a300506032b656e032100', 'hex');
  function requester() {
    const kp = generateKeyPairSync('x25519');
    const pub = kp.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
    return {
      publicKey: pub.toString('base64'),
      proof: ({ challenge, relayPublicKey }) => {
        const relayPub = Buffer.from(relayPublicKey, 'base64');
        const shared = diffieHellman({
          privateKey: kp.privateKey,
          publicKey: createPublicKey({ key: Buffer.concat([X25519_SPKI, relayPub]), format: 'der', type: 'spki' }),
        });
        return createHmac('sha256', shared).update(Buffer.concat([Buffer.from(PAIRING_PROOF_LABEL), Buffer.from(challenge, 'base64'), pub, relayPub])).digest('base64');
      },
    };
  }

  it('terminal: request → pending → response → authorized with token + sealed blob', async () => {
    const term = requester();
    const pk = term.publicKey;
    const nf = await call('GET', `/joy/v2/auth/request/status?publicKey=${encodeURIComponent(pk)}`, { token: null });
    expect(nf.json).toEqual({ status: 'not_found', supportsV2: false });
    const req = await call('POST', '/joy/v2/auth/request', { token: null, body: { publicKey: pk, supportsV2: true } });
    expect(req.json).toMatchObject({ state: 'requested' });
    expect(req.json.challenge).toBeTruthy();
    const pending = await call('GET', `/joy/v2/auth/request/status?publicKey=${encodeURIComponent(pk)}`, { token: null });
    expect(pending.json).toEqual({ status: 'pending', supportsV2: true });
    // answering needs auth
    expect((await call('POST', '/joy/v2/auth/response', { token: null, body: { publicKey: pk, response: 'sealed' } })).status).toBe(401);
    const ans = await call('POST', '/joy/v2/auth/response', { body: { publicKey: pk, response: 'sealed-1' } });
    expect(ans.json).toEqual({ success: true });
    // first write wins
    await call('POST', '/joy/v2/auth/response', { token: OTHER.token, body: { publicKey: pk, response: 'sealed-2' } });
    const poll = await call('POST', '/joy/v2/auth/request', { token: null, body: { publicKey: pk, proof: term.proof(req.json) } });
    expect(poll.json.state).toBe('authorized');
    expect(poll.json.response).toBe('sealed-1');
    // the minted token belongs to the ANSWERING account
    const me = await call('GET', '/joy/v2/account/profile', { token: poll.json.token });
    expect(me.json.id).toBe((await call('GET', '/joy/v2/account/profile')).json.id);
    const done = await call('GET', `/joy/v2/auth/request/status?publicKey=${encodeURIComponent(pk)}`, { token: null });
    expect(done.json.status).toBe('authorized');
    // Anyone who saw the public key in the QR — a poll without the proof —
    // gets neither the token nor the sealed blob (#70, #127).
    const again = await call('POST', '/joy/v2/auth/request', { token: null, body: { publicKey: pk } });
    expect(again.json).toMatchObject({ state: 'proof_required', error: 'proof_required' }); // legible
    expect(again.json.token).toBeUndefined();
    expect(again.json.response).toBeUndefined();
  });

  it('account flavour is independent of terminal flavour; unknown keys 404 on response', async () => {
    const pk = ephemeral();
    expect((await call('POST', '/joy/v2/auth/response', { body: { publicKey: pk, response: 'x' } })).status).toBe(404);
    const req = await call('POST', '/joy/v2/auth/account/request', { token: null, body: { publicKey: pk } });
    expect(req.json).toMatchObject({ state: 'requested' });
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

describe('account settings', () => {
  it('is empty at version 0 before anything is written', async () => {
    const fresh = await loginNew();
    const r = await call('GET', '/joy/v2/account/settings', { token: fresh.token });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ settings: null, version: 0 });
  });

  it('stores a blob and hands it back, version by version', async () => {
    const me = await loginNew();
    const put = await call('POST', '/joy/v2/account/settings', {
      token: me.token, body: { settings: 'sealed-one', expectedVersion: 0 },
    });
    expect(put.status).toBe(200);
    expect(put.json).toEqual({ settings: 'sealed-one', version: 1 });

    const again = await call('POST', '/joy/v2/account/settings', {
      token: me.token, body: { settings: 'sealed-two', expectedVersion: 1 },
    });
    expect(again.json).toEqual({ settings: 'sealed-two', version: 2 });

    const get = await call('GET', '/joy/v2/account/settings', { token: me.token });
    expect(get.json).toEqual({ settings: 'sealed-two', version: 2 });
  });

  it('a stale write loses, and is told what it lost to in the same answer', async () => {
    const me = await loginNew();
    await call('POST', '/joy/v2/account/settings', { token: me.token, body: { settings: 'from-phone', expectedVersion: 0 } });
    // A second device that still believes the account is at version 0.
    const stale = await call('POST', '/joy/v2/account/settings', {
      token: me.token, body: { settings: 'from-laptop', expectedVersion: 0 },
    });
    expect(stale.status).toBe(409);
    expect(stale.json.error).toBe('settings_version_mismatch');
    // Carries the winner, so the loser can merge without another round trip.
    expect(stale.json).toMatchObject({ version: 1, settings: 'from-phone' });

    const get = await call('GET', '/joy/v2/account/settings', { token: me.token });
    expect(get.json.settings).toBe('from-phone');
  });

  it('writes unconditionally when no version is named', async () => {
    const me = await loginNew();
    await call('POST', '/joy/v2/account/settings', { token: me.token, body: { settings: 'a', expectedVersion: 0 } });
    const r = await call('POST', '/joy/v2/account/settings', { token: me.token, body: { settings: 'b' } });
    expect(r.json).toEqual({ settings: 'b', version: 2 });
  });

  it('is per account — one account never sees another\'s blob', async () => {
    const a = await loginNew();
    const b = await loginNew();
    await call('POST', '/joy/v2/account/settings', { token: a.token, body: { settings: 'a-only', expectedVersion: 0 } });
    const seen = await call('GET', '/joy/v2/account/settings', { token: b.token });
    expect(seen.json).toEqual({ settings: null, version: 0 });
  });

  it('needs a token', async () => {
    const r = await call('GET', '/joy/v2/account/settings', { token: null });
    expect(r.status).toBe(401);
  });

  it('refuses an empty or oversized blob rather than storing it', async () => {
    const me = await loginNew();
    expect((await call('POST', '/joy/v2/account/settings', { token: me.token, body: {} })).status).toBe(400);
    expect((await call('POST', '/joy/v2/account/settings', { token: me.token, body: { settings: '' } })).status).toBe(400);
    const huge = 'x'.repeat(256 * 1024 + 1);
    expect((await call('POST', '/joy/v2/account/settings', { token: me.token, body: { settings: huge } })).status).toBe(413);
  });

  it('rejects a non-integer expectedVersion instead of coercing it', async () => {
    const me = await loginNew();
    const r = await call('POST', '/joy/v2/account/settings', {
      token: me.token, body: { settings: 'x', expectedVersion: 'soon' },
    });
    expect(r.status).toBe(400);
  });
});

/**
 * Automations: a folder + a prompt + a trigger, and the runs it produces.
 *
 * The relay never reads `spec` — it is sealed under the target machine's key —
 * so these tests treat it as an opaque string, which is exactly how the relay
 * treats it.
 */
describe('automations', () => {
  const draft = (over = {}) => ({
    name: 'nightly tidy',
    machineId: 'mach-auto',
    directory: '/srv/work',
    spec: 'sealed-spawn-spec',
    triggers: [{ kind: 'manual' }],
    ...over,
  });
  const create = async (over = {}, token) => {
    const r = await call('POST', '/joy/v2/automations', { body: draft(over), ...(token ? { token } : {}) });
    expect(r.status).toBe(201);
    return r.json.automation;
  };

  it('creates, reads back, and lists with the latest run attached', async () => {
    const a = await create({ name: 'lint after work' });
    expect(a).toMatchObject({ name: 'lint after work', directory: '/srv/work', enabled: true, specVersion: 1 });
    expect(a.triggers).toEqual([{ kind: 'manual', filter: '' }]);

    const one = await call('GET', `/joy/v2/automations/${a.id}`);
    expect(one.json.automation.id).toBe(a.id);

    const listed = await call('GET', '/joy/v2/automations');
    const mine = listed.json.automations.find((x) => x.id === a.id);
    expect(mine.latestRun).toBeNull(); // nothing has fired yet
  });

  it('refuses a draft that is missing what it cannot invent', async () => {
    for (const over of [{ name: '' }, { machineId: '' }, { directory: '' }, { spec: '' }, { triggers: [] }]) {
      const r = await call('POST', '/joy/v2/automations', { body: draft(over) });
      expect(r.status).toBe(400);
    }
    const huge = await call('POST', '/joy/v2/automations', { body: draft({ spec: 'x'.repeat(256 * 1024 + 1) }) });
    expect(huge.status).toBe(413);
  });

  it('refuses a trigger kind it does not know, rather than storing a dead one', async () => {
    const r = await call('POST', '/joy/v2/automations', { body: draft({ triggers: [{ kind: 'full_moon' }] }) });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe('bad_trigger_kind');
  });

  it('is per account — another account cannot see it, read it, or delete it', async () => {
    const a = await create();
    for (const [method, path] of [['GET', ''], ['DELETE', '']]) {
      const r = await call(method, `/joy/v2/automations/${a.id}${path}`, { token: OTHER.token });
      expect(r.status).toBe(404);
    }
    // Still there.
    expect((await call('GET', `/joy/v2/automations/${a.id}`)).status).toBe(200);
  });

  it('bumps specVersion only when the spec actually changes', async () => {
    const a = await create();
    const renamed = await call('PATCH', `/joy/v2/automations/${a.id}`, { body: { name: 'renamed' } });
    expect(renamed.json.automation.specVersion).toBe(1);
    expect(renamed.json.automation.name).toBe('renamed');

    const respec = await call('PATCH', `/joy/v2/automations/${a.id}`, { body: { spec: 'sealed-v2' } });
    expect(respec.json.automation.specVersion).toBe(2);
  });

  it('a conditional spec write loses to a concurrent one, and says what it lost to', async () => {
    const a = await create();
    await call('PATCH', `/joy/v2/automations/${a.id}`, { body: { spec: 'from-phone', expectedSpecVersion: 1 } });
    const stale = await call('PATCH', `/joy/v2/automations/${a.id}`, { body: { spec: 'from-laptop', expectedSpecVersion: 1 } });
    expect(stale.status).toBe(409);
    expect(stale.json).toMatchObject({ error: 'spec_version_mismatch', specVersion: 2 });
  });

  it('deleting takes the automation and its history, and leaves the sessions alone', async () => {
    const d = makeDaemon('mach-auto'); await d.acquire();
    const a = await create();
    const run = await call('POST', `/joy/v2/automations/${a.id}/runs`, { body: {} });
    expect(run.status).toBe(201);
    const sessionId = run.json.run.sessionId;
    expect(sessionId).toBeTruthy();

    expect((await call('DELETE', `/joy/v2/automations/${a.id}`)).status).toBe(200);
    expect((await call('GET', `/joy/v2/automations/${a.id}`)).status).toBe(404);
    // The work it produced is an ordinary session and survives.
    expect((await call('GET', `/joy/v2/sessions/${sessionId}`)).status).toBe(200);
  });

  describe('runs', () => {
    it('a manual run spawns a session and goes running', async () => {
      const d = makeDaemon('mach-auto'); await d.acquire();
      const a = await create();
      const r = await call('POST', `/joy/v2/automations/${a.id}/runs`, { body: {} });
      expect(r.status).toBe(201);
      expect(r.json.run).toMatchObject({ state: 'running', triggerKind: 'manual' });
      expect(r.json.run.sessionId).toBeTruthy();

      // And the automation now reports when it last ran.
      const one = await call('GET', `/joy/v2/automations/${a.id}`);
      expect(one.json.automation.lastRunAt).toBeTruthy();
    });

    it('an overlapping firing is RECORDED as skipped, not silently dropped', async () => {
      const d = makeDaemon('mach-auto'); await d.acquire();
      const a = await create();
      await call('POST', `/joy/v2/automations/${a.id}/runs`, { body: {} });
      const second = await call('POST', `/joy/v2/automations/${a.id}/runs`, { body: {} });
      expect(second.json.skipped).toBe(true);
      expect(second.json.run).toMatchObject({ state: 'cancelled', errorCode: 'skipped_overlap' });

      // Both are in the history: a firing that did nothing still happened.
      const runs = await call('GET', `/joy/v2/automations/${a.id}/runs`);
      expect(runs.json.runs).toHaveLength(2);
    });

    it('a disabled automation refuses to run at all', async () => {
      const a = await create();
      await call('PATCH', `/joy/v2/automations/${a.id}`, { body: { enabled: false } });
      const r = await call('POST', `/joy/v2/automations/${a.id}/runs`, { body: {} });
      expect(r.status).toBe(409);
      expect(r.json.error).toBe('automation_disabled');
    });

    it('a spawn that cannot happen leaves the run FAILED, never queued forever', async () => {
      // No daemon owns this machine, so createSession refuses.
      const a = await create({ machineId: 'mach-that-does-not-exist' });
      const r = await call('POST', `/joy/v2/automations/${a.id}/runs`, { body: {} });
      expect(r.status).toBe(201);
      expect(r.json.run.state).toBe('failed');
      expect(r.json.run.errorCode).toBeTruthy();
      expect(r.json.run.finishedAt).toBeTruthy();
    });

    it('the daemon reports the outcome, and a terminal state is final', async () => {
      const d = makeDaemon('mach-auto'); await d.acquire();
      const a = await create();
      const { json: { run } } = await call('POST', `/joy/v2/automations/${a.id}/runs`, { body: {} });

      const failed = await call('POST', `/joy/v2/automation-runs/${run.id}/report`, {
        body: { state: 'failed', errorCode: 'blocked:login', errorMessage: 'claude login expired' },
      });
      expect(failed.json.run).toMatchObject({ state: 'failed', errorCode: 'blocked:login' });

      // A late or retried report cannot rewrite it.
      const late = await call('POST', `/joy/v2/automation-runs/${run.id}/report`, { body: { state: 'succeeded' } });
      expect(late.json.alreadyFinal).toBe(true);
      expect(late.json.run.state).toBe('failed');
    });

    it('refuses a run state it does not know', async () => {
      const d = makeDaemon('mach-auto'); await d.acquire();
      const a = await create();
      const { json: { run } } = await call('POST', `/joy/v2/automations/${a.id}/runs`, { body: {} });
      const r = await call('POST', `/joy/v2/automation-runs/${run.id}/report`, { body: { state: 'exploded' } });
      expect(r.status).toBe(400);
    });
  });

  describe('failures stay until dismissed', () => {
    // Each of these runs as its OWN account, so the failures list contains
    // only what the test put there. A machine is owned by one account, so the
    // machine id has to be fresh too — reusing one is 403, not a lease.
    let machineSeq = 0;
    const onFreshAccount = async (body) => {
      const fresh = await loginNew();
      const prevApp = APP; APP = fresh;
      try { return await body(`mach-auto-${++machineSeq}`); } finally { APP = prevApp; }
    };
    const failOne = async (name, machineId) => {
      const d = makeDaemon(machineId); await d.acquire();
      const a = await create({ name, machineId });
      const { json: { run } } = await call('POST', `/joy/v2/automations/${a.id}/runs`, { body: {} });
      await call('POST', `/joy/v2/automation-runs/${run.id}/report`, { body: { state: 'failed', errorCode: 'blocked:login' } });
      return { a, run };
    };

    it('lists unacknowledged failures with the automation that caused them', async () => {
      await onFreshAccount(async (machineId) => {
        await failOne('nightly', machineId);
        const r = await call('GET', '/joy/v2/automations/failures');
        expect(r.json.failures).toHaveLength(1);
        expect(r.json.failures[0]).toMatchObject({ errorCode: 'blocked:login', automationName: 'nightly' });
      });
    });

    it('dismissing removes it from the list without touching the history', async () => {
      await onFreshAccount(async (machineId) => {
        const { a, run } = await failOne('nightly', machineId);
        await call('POST', `/joy/v2/automation-runs/${run.id}/ack`, { body: {} });
        expect((await call('GET', '/joy/v2/automations/failures')).json.failures).toHaveLength(0);
        // Still in the run history, still failed.
        const runs = await call('GET', `/joy/v2/automations/${a.id}/runs`);
        expect(runs.json.runs[0]).toMatchObject({ state: 'failed', errorCode: 'blocked:login' });
        expect(runs.json.runs[0].acknowledgedAt).toBeTruthy();
      });
    });

    it('a succeeded run never appears as a failure', async () => {
      await onFreshAccount(async (machineId) => {
        const d = makeDaemon(machineId); await d.acquire();
        const a = await create({ machineId });
        const { json: { run } } = await call('POST', `/joy/v2/automations/${a.id}/runs`, { body: {} });
        await call('POST', `/joy/v2/automation-runs/${run.id}/report`, { body: { state: 'succeeded' } });
        expect((await call('GET', '/joy/v2/automations/failures')).json.failures).toHaveLength(0);
      });
    });
  });

  it('needs a token', async () => {
    expect((await call('GET', '/joy/v2/automations', { token: null })).status).toBe(401);
  });

  /**
   * Triggers are the whole scheduler: no clock, no cron, just a subscription
   * to events the relay already writes. `onEvent` is called by core after its
   * transaction commits.
   */
  describe('triggers', () => {
    let seq = 0;
    /** Each test gets its OWN account and machine, or automations created by
     *  an earlier test fire too and the counts are meaningless. */
    const inIsolation = async (body) => {
      const fresh = await loginNew();
      const prevApp = APP; APP = fresh;
      try {
        const accountId = (await call('GET', '/joy/v2/account/profile')).json.id;
        return await body({ accountId, machine: () => `mach-trig-${++seq}` });
      } finally { APP = prevApp; }
    };

    it('refuses the two kinds that were removed, rather than storing a dead trigger', async () => {
      // `turn_done` and `machine_online` were built, offered and wanted by
      // nobody (migration 012). Accepting one now would store a trigger that
      // can never fire, which is the failure mode the whole validate-on-write
      // rule exists to prevent.
      for (const kind of ['turn_done', 'machine_online']) {
        const r = await call('POST', '/joy/v2/automations', { body: { ...draft(), triggers: [{ kind }] } });
        expect(r.status, kind).toBe(400);
        expect(r.json.error).toBe('bad_trigger_kind');
      }
    });

    it('a schedule expression is checked when it is WRITTEN, not when it fires', async () => {
      const bad = await call('POST', '/joy/v2/automations', {
        body: { ...draft(), triggers: [{ kind: 'schedule', filter: 'every night' }] },
      });
      expect(bad.status).toBe(400);
      expect(bad.json.error).toBe('bad_cron');

      const badZone = await call('POST', '/joy/v2/automations', {
        body: { ...draft(), triggers: [{ kind: 'schedule', filter: '0 2 * * *', timezone: 'Mars/Olympus' }] },
      });
      expect(badZone.status).toBe(400);
      expect(badZone.json.error).toBe('bad_timezone');
    });

    it('a schedule knows when it next fires the moment it is created', async () => {
      const a = await create({ triggers: [{ kind: 'schedule', filter: '*/5 * * * *', timezone: 'UTC' }] });
      const trig = a.triggers.find((t) => t.kind === 'schedule');
      expect(trig.filter).toBe('*/5 * * * *');
      expect(trig.timezone).toBe('UTC');
      expect(trig.nextRunAt).toBeGreaterThan(Date.now() - 1000);
      expect(trig.nextRunAt).toBeLessThan(Date.now() + 6 * 60_000);
    });

    it('the tick fires what is due and advances the clock past it', async () => {
      await inIsolation(async ({ machine }) => {
        const machineId = machine();
        const d = makeDaemon(machineId); await d.acquire();
        const a = await create({ machineId, triggers: [{ kind: 'schedule', filter: '*/5 * * * *', timezone: 'UTC' }] });

        await automations.tick();
        expect((await call('GET', `/joy/v2/automations/${a.id}/runs`)).json.runs).toHaveLength(0);

        // An hour later it is due — and it fires ONCE, not twelve times.
        const later = Date.now() + 60 * 60_000;
        await automations.tick(later);

        const runs = (await call('GET', `/joy/v2/automations/${a.id}/runs`)).json.runs;
        expect(runs.filter((r) => r.state === 'running' || r.state === 'succeeded')).toHaveLength(1);
        // And the ones that passed are RECORDED, not forgotten.
        const missed = runs.find((r) => r.errorCode === 'missed_schedule');
        expect(missed).toBeTruthy();
        expect(missed.errorMessage).toMatch(/occurrences? passed while nothing was listening/);

        // The clock moved: ticking again at the same instant runs nothing more.
        await automations.tick(later);
        expect((await call('GET', `/joy/v2/automations/${a.id}/runs`)).json.runs).toHaveLength(runs.length);
      });
    });

    it('a disabled schedule advances its clock but runs nothing', async () => {
      await inIsolation(async ({ machine }) => {
        const machineId = machine();
        const d = makeDaemon(machineId); await d.acquire();
        const a = await create({ machineId, triggers: [{ kind: 'schedule', filter: '*/5 * * * *', timezone: 'UTC' }] });
        await call('PATCH', `/joy/v2/automations/${a.id}`, { body: { enabled: false } });

        const later = Date.now() + 60 * 60_000;
        await automations.tick(later);
        expect((await call('GET', `/joy/v2/automations/${a.id}/runs`)).json.runs).toHaveLength(0);
        // Re-enabling must not then replay the hour it was off for.
        await call('PATCH', `/joy/v2/automations/${a.id}`, { body: { enabled: true } });
        await automations.tick(later);
        expect((await call('GET', `/joy/v2/automations/${a.id}/runs`)).json.runs).toHaveLength(0);
      });
    });

    it('a chained automation fires when the one it follows ends', async () => {
      await inIsolation(async ({ accountId, machine }) => {
        const machineId = machine();
        const d = makeDaemon(machineId); await d.acquire();
        const first = await create({ machineId, name: 'first' });
        const second = await create({ machineId, name: 'second', triggers: [{ kind: 'automation_done', filter: first.id }] });
        expect((await automations.onEvent('automation_done', { accountId, filters: [first.id] })).fired).toBe(1);
        expect((await call('GET', `/joy/v2/automations/${second.id}/runs`)).json.runs).toHaveLength(1);
      });
    });

    it('manual is never fired by an event — it is the one you ask for', async () => {
      await inIsolation(async ({ accountId, machine }) => {
        const machineId = machine();
        const d = makeDaemon(machineId); await d.acquire();
        await create({ machineId, triggers: [{ kind: 'manual' }] });
        expect((await automations.onEvent('manual', { accountId, machineId })).fired).toBe(0);
      });
    });

    it('an unknown kind, or no account, fires nothing rather than throwing', async () => {
      expect((await automations.onEvent('full_moon', { accountId: 'x' })).fired).toBe(0);
      expect((await automations.onEvent('automation_done', {})).fired).toBe(0);
    });
  });
});
