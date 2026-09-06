// Wave F (review campaign 2026-09) — pairing proves possession of the
// ephemeral private key before a bearer is minted (#127). The requester's key
// is X25519 (the answer is sealed to it), so the proof is a key agreement:
// HMAC-SHA256(X25519(requesterPriv, relayPub), label || challenge ||
// requesterPub || relayPub). Reproduced against an in-process relay with the
// real account plane: first-poll theft, lost replies, concurrent pickup, a
// forged proof, the legacy (account) flavour and pre-migration rows.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import { createHmac, diffieHellman, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { openDb } from '../src/db.mjs';
import { createCore } from '../src/core.mjs';
import { createNotify } from '../src/notify.mjs';
import { createV2Router } from '../src/v2.mjs';
import { createTunnel } from '../src/tunnel.mjs';
import { createAttachments } from '../src/attachments.mjs';
import { createTokenAuthority } from '../src/tokens.mjs';
import { createAccounts, PAIRING_PROOF_LABEL, pairingProofFor } from '../src/accounts.mjs';
import { createAuth } from '../src/auth.mjs';

let server, base, db, APP;

const X25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');
const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');

/** The requester's side, written the way the daemon writes it (raw X25519
 *  scalar multiplication + HMAC over the label, nonce and both keys) — NOT
 *  via the relay's exported helper, so the two implementations check each
 *  other. tweetnacl.scalarMult and Node's x25519 agree on the raw output. */
function requester() {
  const kp = generateKeyPairSync('x25519');
  const pub = kp.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const priv = Buffer.from(kp.privateKey.export({ format: 'jwk' }).d, 'base64url');
  return {
    pub, priv, publicKey: pub.toString('base64'),
    proof({ challenge, relayPublicKey }) {
      const relayPub = Buffer.from(relayPublicKey, 'base64');
      const shared = diffieHellman({
        privateKey: createPrivateKey({ key: Buffer.concat([X25519_PKCS8_PREFIX, priv]), format: 'der', type: 'pkcs8' }),
        publicKey: createPublicKey({ key: Buffer.concat([X25519_SPKI_PREFIX, relayPub]), format: 'der', type: 'spki' }),
      });
      return createHmac('sha256', shared)
        .update(Buffer.concat([Buffer.from(PAIRING_PROOF_LABEL), Buffer.from(challenge, 'base64'), pub, relayPub]))
        .digest('base64');
    },
  };
}

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

beforeAll(async () => {
  db = await openDb(':memory:');
  const notify = createNotify();
  const core = createCore(db, notify);
  const tokens = await createTokenAuthority({ secret: 'test-secret-test-secret', issuers: ['joy'] });
  const accounts = createAccounts(db, tokens);
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

const request = (path, body) => call('POST', path, { token: null, body });
const profileId = async (token) => (await call('GET', '/joy/v2/account/profile', { token })).json.id;

describe('#127 terminal pairing: the bearer goes only to the holder of the private key', () => {
  it('creation hands out the handshake; the first authorized poll WITHOUT a proof gets no token (first-poll theft)', async () => {
    const me = requester();
    const created = await request('/joy/v2/auth/request', { publicKey: me.publicKey, supportsV2: true });
    expect(created.status).toBe(200);
    expect(created.json.state).toBe('requested');
    expect(Buffer.from(created.json.challenge, 'base64').length).toBe(32);
    expect(Buffer.from(created.json.relayPublicKey, 'base64').length).toBe(32);
    // The handshake is stable across polls, so a requester that lost the
    // creation reply can still build its proof.
    const again = await request('/joy/v2/auth/request', { publicKey: me.publicKey });
    expect(again.json).toMatchObject({ state: 'requested', challenge: created.json.challenge, relayPublicKey: created.json.relayPublicKey });

    expect((await call('POST', '/joy/v2/auth/response', { body: { publicKey: me.publicKey, response: 'sealed-127' } })).json).toEqual({ success: true });

    // An observer of the QR knows the public key and can poll first …
    const thief = await request('/joy/v2/auth/request', { publicKey: me.publicKey });
    expect(thief.status).toBe(200);
    expect(thief.json).toMatchObject({ state: 'proof_required', error: 'proof_required' });
    expect(thief.json.token).toBeUndefined();
    expect(thief.json.response).toBeUndefined();
    // … and it gains nothing from that: the requester's proven pickup still works.
    const mine = await request('/joy/v2/auth/request', { publicKey: me.publicKey, proof: me.proof(created.json) });
    expect(mine.status).toBe(200);
    expect(mine.json.state).toBe('authorized');
    expect(mine.json.response).toBe('sealed-127');
    expect(await profileId(mine.json.token)).toBe(await profileId(APP.token));
    // The relay's own helper and the requester-side computation agree.
    expect(pairingProofFor({ requesterPriv: me.priv, requesterPub: me.pub, relayPub: Buffer.from(created.json.relayPublicKey, 'base64'), challenge: created.json.challenge }).toString('base64'))
      .toBe(me.proof(created.json));
    const st = await call('GET', `/joy/v2/auth/request/status?publicKey=${encodeURIComponent(me.publicKey)}`, { token: null });
    expect(st.json).toMatchObject({ status: 'authorized', consumed: true });
  });

  it('a lost reply is retried: a proven pickup collects the answer again, and concurrent proven pickups all succeed', async () => {
    const me = requester();
    const created = await request('/joy/v2/auth/request', { publicKey: me.publicKey });
    await call('POST', '/joy/v2/auth/response', { body: { publicKey: me.publicKey, response: 'sealed-retry' } });
    const proof = me.proof(created.json);
    const first = await request('/joy/v2/auth/request', { publicKey: me.publicKey, proof });
    expect(first.json.state).toBe('authorized');
    // The reply was lost in transit: the same proof collects it again.
    const second = await request('/joy/v2/auth/request', { publicKey: me.publicKey, proof });
    expect(second.json).toMatchObject({ state: 'authorized', response: 'sealed-retry' });
    expect(second.json.token).toBeTruthy();
    expect(await profileId(second.json.token)).toBe(await profileId(APP.token));
    // Racing pickups (a retry that overtakes its predecessor) all succeed.
    const race = await Promise.all([0, 1, 2].map(() => request('/joy/v2/auth/request', { publicKey: me.publicKey, proof })));
    for (const r of race) expect(r.json).toMatchObject({ state: 'authorized', response: 'sealed-retry' });
    // A poll without the proof still gets nothing, even after a proven pickup.
    expect((await request('/joy/v2/auth/request', { publicKey: me.publicKey })).json.state).toBe('proof_required');
  });

  it('a forged, foreign or malformed proof is 401 invalid_proof and delivers nothing', async () => {
    const me = requester();
    const other = requester();
    const created = await request('/joy/v2/auth/request', { publicKey: me.publicKey });
    await call('POST', '/joy/v2/auth/response', { body: { publicKey: me.publicKey, response: 'sealed-forge' } });
    // Another key's proof over the same handshake.
    const foreign = { ...other, pub: other.pub };
    const wrongKey = await request('/joy/v2/auth/request', { publicKey: me.publicKey, proof: foreign.proof(created.json) });
    expect(wrongKey.status).toBe(401);
    expect(wrongKey.json.error).toBe('invalid_proof');
    // The right key over a different challenge (a proof replayed from another request).
    const replayed = await request('/joy/v2/auth/request', { publicKey: me.publicKey, proof: me.proof({ ...created.json, challenge: randomBytes(32).toString('base64') }) });
    expect(replayed.status).toBe(401);
    // Garbage.
    for (const proof of ['', 'not-base64!!', randomBytes(32).toString('base64'), 42]) {
      const r = await request('/joy/v2/auth/request', { publicKey: me.publicKey, proof });
      expect(r.status).toBe(401);
      expect(r.json.token).toBeUndefined();
    }
    // A wrong proof does not consume anything: the real one still collects.
    const st = await call('GET', `/joy/v2/auth/request/status?publicKey=${encodeURIComponent(me.publicKey)}`, { token: null });
    expect(st.json).toMatchObject({ status: 'authorized', consumed: false });
    expect((await request('/joy/v2/auth/request', { publicKey: me.publicKey, proof: me.proof(created.json) })).json.state).toBe('authorized');
  });

  it('a proof offered BEFORE the answer is checked too, and an unanswered request stays requested', async () => {
    const me = requester();
    const created = await request('/joy/v2/auth/request', { publicKey: me.publicKey });
    expect((await request('/joy/v2/auth/request', { publicKey: me.publicKey, proof: me.proof(created.json) })).json.state).toBe('requested');
    expect((await request('/joy/v2/auth/request', { publicKey: me.publicKey, proof: 'bogus' })).status).toBe(401);
  });

  it('a request created before the proof existed is given a handshake on its next poll', async () => {
    const me = requester();
    const hex = me.pub.toString('hex').toUpperCase();
    await db.query(`INSERT INTO auth_requests (id, kind, public_key, supports_v2) VALUES ($1, 'terminal', $2, TRUE)`, ['r-pre-127', hex]);
    const polled = await request('/joy/v2/auth/request', { publicKey: me.publicKey });
    expect(polled.json.state).toBe('requested');
    expect(polled.json.challenge).toBeTruthy();
    await call('POST', '/joy/v2/auth/response', { body: { publicKey: me.publicKey, response: 'sealed-pre' } });
    expect((await request('/joy/v2/auth/request', { publicKey: me.publicKey })).json.state).toBe('proof_required');
    expect((await request('/joy/v2/auth/request', { publicKey: me.publicKey, proof: me.proof(polled.json) })).json).toMatchObject({ state: 'authorized', response: 'sealed-pre' });
  });
});

describe('#127 account flavour: legacy one-shot pickup until the app sends proofs; a proof it sends counts', () => {
  it('without a proof the answer is handed out once (#70 semantics kept); with a proof it is retryable', async () => {
    const me = requester();
    const created = await request('/joy/v2/auth/account/request', { publicKey: me.publicKey });
    expect(created.json).toMatchObject({ state: 'requested' });
    expect(created.json.challenge).toBeTruthy(); // the handshake is offered so the app can adopt it
    await call('POST', '/joy/v2/auth/account/response', { body: { publicKey: me.publicKey, response: 'sealed-acct' } });
    const first = await request('/joy/v2/auth/account/request', { publicKey: me.publicKey });
    expect(first.json).toMatchObject({ state: 'authorized', response: 'sealed-acct' });
    const again = await request('/joy/v2/auth/account/request', { publicKey: me.publicKey });
    expect(again.json).toMatchObject({ state: 'consumed', error: 'pairing_answer_already_collected' });
    expect(again.json.token).toBeUndefined();
    // The holder of the private key is not locked out by a consumed legacy pickup.
    const proven = await request('/joy/v2/auth/account/request', { publicKey: me.publicKey, proof: me.proof(created.json) });
    expect(proven.json).toMatchObject({ state: 'authorized', response: 'sealed-acct' });
    // And a wrong proof is refused on this flavour too.
    expect((await request('/joy/v2/auth/account/request', { publicKey: me.publicKey, proof: requester().proof(created.json) })).status).toBe(401);
  });
});
