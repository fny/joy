// The account plane, served natively: login, device pairing, profile,
// machines and push tokens. Everything here is CONTENT-BLIND — public keys,
// sealed pairing responses, sealed machine blobs and opaque Expo tokens. The
// relay never sees an account secret; it only proves a device holds one
// (ed25519 challenge) or was handed one (a pairing response sealed by an
// already-authorized device).
import {
  createHmac, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync,
  randomBytes, randomUUID, timingSafeEqual, verify,
} from 'node:crypto';
import { ApiError } from './core.mjs';

const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
// X25519 DER prefixes (RFC 8410) for the pairing proof of possession (#127).
const X25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');
const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');
/** Domain separator of the pairing proof — a WIRE CONSTANT shared with the
 *  daemon's requester (packages/joy-daemon/src/relay/pairing.ts). */
export const PAIRING_PROOF_LABEL = 'joy-pairing-proof-v1';
/** Pairing flavours whose pickup REQUIRES the proof. `terminal` is the
 *  daemon (updated in step); `account` is the app's restore flow, which
 *  keeps the legacy one-shot pickup until the app that sends the proof has
 *  shipped — a proof it does send is verified and unlocks the same retryable
 *  pickup either way. `JOY_RELAY_PAIRING_PROOF_ACCOUNT=1` flips the account
 *  flavour to required (docs/API.md); default off, so an app from before the
 *  proof can still restore. */
function proofRequiredKinds(pairingProofAccount) {
  return new Set(pairingProofAccount ? ['terminal', 'account'] : ['terminal']);
}
/** The env switch behind `pairingProofAccount` (read at construction). */
export const PAIRING_PROOF_ACCOUNT_ENV = 'JOY_RELAY_PAIRING_PROOF_ACCOUNT';
const KEY_LEN = 32;
const PAIRING_TTL_MS = 24 * 60 * 60 * 1000;
/** An ANSWERED request lives this long: enough for the requester's next poll
 *  (1s in the app, immediate in the daemon), not the 24h an unanswered QR gets. */
const ANSWERED_TTL_MS = 10 * 60 * 1000;
const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
/** Per-device Expo deadline, covering the request AND the body read (#608). */
const PUSH_TIMEOUT_MS = 10_000;
/** Devices contacted at once; one slow device no longer delays the rest. */
const PUSH_CONCURRENCY = 4;

/** Compact, URL-safe, collision-resistant id (no dashes so it stays \w). */
export const newId = (prefix = 'a') => prefix + randomBytes(12).toString('hex');

function decodeKey(b64) {
  if (typeof b64 !== 'string' || !b64) throw new ApiError(400, 'missing_publicKey');
  let buf;
  try { buf = Buffer.from(b64, 'base64'); } catch { throw new ApiError(400, 'bad_publicKey'); }
  if (buf.length !== KEY_LEN) throw new ApiError(401, 'invalid_public_key');
  return buf;
}
const keyHex = (buf) => buf.toString('hex').toUpperCase();
const ms = (d) => (d instanceof Date ? d : new Date(d)).getTime();

// ── pairing proof of possession (#127) ───────────────────────────────────────
// The requester's key is X25519 (it is what the answer is sealed to), so it
// cannot sign. Possession is proven by key agreement instead: the relay keeps
// a per-request X25519 keypair and a nonce; the requester presents
//   proof = HMAC-SHA256(X25519(requesterPriv, relayPub),
//                      label || challenge || requesterPub || relayPub)
// which only the holder of the private half can compute and the relay can
// check with its own private half. Bound to the request by the nonce.

/** A fresh relay-side keypair + nonce for one request (stored on the row). */
function newPairingHandshake() {
  const kp = generateKeyPairSync('x25519');
  return {
    challenge: randomBytes(32).toString('base64'),
    relaySecret: Buffer.from(kp.privateKey.export({ format: 'jwk' }).d, 'base64url').toString('base64'),
  };
}
const relayPrivateKeyOf = (relaySecretB64) =>
  createPrivateKey({ key: Buffer.concat([X25519_PKCS8_PREFIX, Buffer.from(relaySecretB64, 'base64')]), format: 'der', type: 'pkcs8' });
const relayPublicKeyOf = (relaySecretB64) =>
  createPublicKey(relayPrivateKeyOf(relaySecretB64)).export({ format: 'der', type: 'spki' }).subarray(-32);

/** The proof a requester holding `requesterPriv` (raw 32 bytes) must present
 *  for a request whose handshake is (`challenge`, `relayPub`). Exported for
 *  tests — the daemon computes the same thing with tweetnacl.scalarMult. */
export function pairingProofFor({ requesterPriv, requesterPub, relayPub, challenge }) {
  const priv = createPrivateKey({ key: Buffer.concat([X25519_PKCS8_PREFIX, requesterPriv]), format: 'der', type: 'pkcs8' });
  const pub = createPublicKey({ key: Buffer.concat([X25519_SPKI_PREFIX, relayPub]), format: 'der', type: 'spki' });
  const shared = diffieHellman({ privateKey: priv, publicKey: pub });
  return createHmac('sha256', shared)
    .update(Buffer.concat([Buffer.from(PAIRING_PROOF_LABEL), Buffer.from(challenge, 'base64'), requesterPub, relayPub]))
    .digest();
}

/** True when `proofB64` is the proof for `row` from the holder of the
 *  private half of `requesterPub`. A malformed key or proof is simply false. */
function pairingProofValid(row, requesterPub, proofB64) {
  if (typeof proofB64 !== 'string' || !proofB64) return false;
  try {
    const priv = relayPrivateKeyOf(row.relay_secret);
    const relayPub = createPublicKey(priv).export({ format: 'der', type: 'spki' }).subarray(-32);
    const pub = createPublicKey({ key: Buffer.concat([X25519_SPKI_PREFIX, requesterPub]), format: 'der', type: 'spki' });
    const shared = diffieHellman({ privateKey: priv, publicKey: pub });
    const expected = createHmac('sha256', shared)
      .update(Buffer.concat([Buffer.from(PAIRING_PROOF_LABEL), Buffer.from(row.challenge, 'base64'), requesterPub, relayPub]))
      .digest();
    const given = Buffer.from(proofB64, 'base64');
    return given.length === expected.length && timingSafeEqual(given, expected);
  } catch {
    return false;
  }
}

/** Settle `p`, or reject as soon as `signal` aborts — for reads that do not
 *  honour the fetch signal themselves (a trickling response body). */
function underAbort(p, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason ?? new Error('aborted')); return; }
    const onAbort = () => reject(signal.reason ?? new Error('aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => { signal.removeEventListener('abort', onAbort); resolve(v); },
      (e) => { signal.removeEventListener('abort', onAbort); reject(e); });
  });
}

/** `items.map(fn)` with at most `limit` in flight; results keep input order. */
async function mapBounded(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

function machineOut(r, liveness) {
  const live = liveness?.get(r.id);
  return {
    id: r.id,
    metadata: r.metadata,
    metadataVersion: Number(r.metadata_version),
    daemonState: r.daemon_state,
    daemonStateVersion: Number(r.daemon_state_version),
    dataEncryptionKey: r.data_encryption_key,
    seq: Number(r.seq),
    // Presence comes from the lease table — the same authority the work
    // queue trusts — so "online" can never disagree with dispatchability.
    active: !!live?.alive,
    leaseAlive: !!live?.alive,
    activeAt: Math.max(ms(r.last_active_at), live?.seenAt ?? 0),
    createdAt: ms(r.created_at),
    updatedAt: ms(r.updated_at),
  };
}

export function createAccounts(db, tokens, {
  fetchImpl, pushTimeoutMs = PUSH_TIMEOUT_MS, pushConcurrency = PUSH_CONCURRENCY,
  pairingProofAccount = process.env[PAIRING_PROOF_ACCOUNT_ENV] === '1',
} = {}) {
  const doFetch = fetchImpl ?? fetch;
  const PROOF_REQUIRED_KINDS = proofRequiredKinds(pairingProofAccount);

  // ── login / identity ──────────────────────────────────────────────────────
  async function findOrCreateByPublicKey(publicKeyHex) {
    return db.tx(async (t) => {
      const { rows: [existing] } = await t.query(`SELECT * FROM accounts WHERE public_key = $1`, [publicKeyHex]);
      if (existing) {
        await t.query(`UPDATE accounts SET updated_at = now() WHERE id = $1`, [existing.id]);
        return existing;
      }
      const id = newId('a');
      const { rows: [created] } = await t.query(
        `INSERT INTO accounts (id, public_key) VALUES ($1, $2) RETURNING *`, [id, publicKeyHex]);
      return created;
    });
  }

  /** POST /auth — ed25519 challenge login; auto-creates the account. */
  async function login({ publicKey, challenge, signature }) {
    const pk = decodeKey(publicKey);
    if (typeof challenge !== 'string' || typeof signature !== 'string') throw new ApiError(400, 'missing_fields');
    let ok = false;
    try {
      const key = createPublicKey({ key: Buffer.concat([SPKI_PREFIX, pk]), format: 'der', type: 'spki' });
      ok = verify(null, Buffer.from(challenge, 'base64'), key, Buffer.from(signature, 'base64'));
    } catch { ok = false; }
    if (!ok) throw new ApiError(401, 'invalid_signature');
    const account = await findOrCreateByPublicKey(keyHex(pk));
    return { success: true, token: tokens.mint(account.id) };
  }

  async function accountExists(accountId) {
    const { rows } = await db.query(`SELECT 1 FROM accounts WHERE id = $1`, [accountId]);
    return rows.length > 0;
  }

  async function profile(accountId) {
    const { rows: [a] } = await db.query(`SELECT * FROM accounts WHERE id = $1`, [accountId]);
    if (!a) throw new ApiError(404, 'account_not_found');
    return { id: a.id, publicKey: a.public_key, createdAt: ms(a.created_at), updatedAt: ms(a.updated_at) };
  }

  // ── pairing (terminal | account) ──────────────────────────────────────────
  // The requester (a daemon being paired, or a new device restoring an
  // account) posts an ephemeral X25519 public key and polls; an authorized
  // device answers with the account secret SEALED to that key. The relay
  // stores the sealed blob and, once answered, mints the requester a token —
  // to the holder of the ephemeral PRIVATE key, proven by `proof` (#127).
  //
  // Every response that carries no credentials carries the handshake
  // (`challenge`, `relayPublicKey`) the proof is computed over, so a
  // requester that lost the creation reply can still build one.
  async function pairingRequest(kind, { publicKey, supportsV2, proof }) {
    const pk = decodeKey(publicKey);
    const hex = keyHex(pk);
    const proofRequired = PROOF_REQUIRED_KINDS.has(kind);
    const row = await db.tx(async (t) => {
      let { rows: [existing] } = await t.query(
        `SELECT * FROM auth_requests WHERE kind = $1 AND public_key = $2`, [kind, hex]);
      if (existing) {
        // Enforced on READ too — the sweep is hourly, and an answer must not
        // stay collectable for up to an hour past its ten minutes; likewise
        // an unanswered QR past its day is gone, not still pending (#610).
        if (pairingExpired(existing)) {
          await t.query(`DELETE FROM auth_requests WHERE id = $1`, [existing.id]);
          return { expired: true };
        }
        if (!existing.challenge || !existing.relay_secret) {
          // A row from before the proof existed: give it a handshake now.
          const hs = newPairingHandshake();
          ({ rows: [existing] } = await t.query(
            `UPDATE auth_requests SET challenge = $1, relay_secret = $2 WHERE id = $3 RETURNING *`,
            [hs.challenge, hs.relaySecret, existing.id]));
        }
        // A proof that is offered is always checked — a wrong one is an
        // authentication failure, never silently "no proof".
        const proven = proof !== undefined && proof !== null;
        if (proven && !pairingProofValid(existing, pk, proof)) return { badProof: true };
        if (!existing.response || !existing.response_account_id) {
          // Unanswered. A proof that was PRESENTED here has been seen on the
          // wire, so it dies with this reply: the challenge rotates and the
          // next pickup must prove possession over the fresh one (a proof
          // captured before the answer cannot collect the bearer after it).
          // Only a VALID proof rotates — a proof-less poll (an observer of
          // the QR, or the requester before it holds a handshake) and a
          // wrong proof leave the challenge alone, so nobody who lacks the
          // private key can invalidate the holder's next proof.
          if (proven) {
            ({ rows: [existing] } = await t.query(
              `UPDATE auth_requests SET challenge = $1 WHERE id = $2 RETURNING *`,
              [randomBytes(32).toString('base64'), existing.id]));
          }
          return existing;
        }
        if (proven) {
          // Possession proven: the answer is collectable again and again
          // until its window closes — a reply lost in transit is retried,
          // not re-paired. Only the private key's holder can get here, so
          // repeat pickup is not the replay of #70.
          await t.query(
            `UPDATE auth_requests SET consumed_at = COALESCE(consumed_at, now()), proven_at = COALESCE(proven_at, now()) WHERE id = $1`,
            [existing.id]);
          return { ...existing, deliver: true };
        }
        if (proofRequired) return { ...existing, proofRequired: true };
        // Legacy pickup (no proof, flavour that does not require one yet):
        // the answer is handed out ONCE, inside the same transaction that
        // marks it consumed. Anyone who saw the public key (it is in the QR
        // the app shows) could otherwise poll after the real requester and
        // be minted a bearer, repeatedly, for 24 hours (#70).
        if (!existing.consumed_at) {
          await t.query(`UPDATE auth_requests SET consumed_at = now(), updated_at = now() WHERE id = $1`, [existing.id]);
          return { ...existing, deliver: true };
        }
        return existing;
      }
      const hs = newPairingHandshake();
      const { rows: [created] } = await t.query(
        `INSERT INTO auth_requests (id, kind, public_key, supports_v2, challenge, relay_secret) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [newId('r'), kind, hex, supportsV2 === true, hs.challenge, hs.relaySecret]);
      return created;
    });
    if (row.expired) return { state: 'expired' };
    if (row.badProof) throw new ApiError(401, 'invalid_proof');
    if (row.deliver) {
      return { state: 'authorized', token: tokens.mint(row.response_account_id, { session: row.id }), response: row.response };
    }
    const handshake = { challenge: row.challenge, relayPublicKey: relayPublicKeyOf(row.relay_secret).toString('base64') };
    if (row.proofRequired) {
      // Answered, but this poll did not prove it holds the private key — an
      // observer of the QR lands here and gets nothing it did not have.
      return {
        state: 'proof_required',
        error: 'proof_required',
        message: 'This pairing is approved; present `proof` (HMAC over the challenge, keyed by X25519 with the relay key) to collect it.',
        ...handshake,
      };
    }
    if (row.consumed_at) {
      // Legacy pickup, BY DESIGN (#607 / #70): without a proof the
      // credentials are handed out exactly once, and a requester whose
      // authorized reply was lost in transit cannot collect them again —
      // re-opening that window would re-open the replay attack #70 closed
      // (anyone who saw the QR could be minted a bearer). What we owe the
      // requester is LEGIBILITY: a specific code, the moment it happened,
      // and what to do next. A requester that CAN prove possession retries
      // with `proof` instead (the handshake rides along for that).
      return {
        state: 'consumed',
        error: 'pairing_answer_already_collected',
        consumedAt: ms(row.consumed_at),
        message: 'This pairing answer was already collected — by an earlier poll from this device whose reply was lost, ' +
          'or by someone else who saw the code. It cannot be re-issued; start a new pairing.',
        ...handshake,
      };
    }
    return { state: 'requested', ...handshake };
  }

  /** Unanswered past PAIRING_TTL (from creation) or answered past
   *  ANSWERED_TTL (from the answer). Two clocks, one per phase — read,
   *  answer and sweep all apply the SAME rule (#610). */
  function pairingExpired(r, now = Date.now()) {
    return r.response
      ? now - ms(r.updated_at) > ANSWERED_TTL_MS
      : now - ms(r.created_at) > PAIRING_TTL_MS;
  }

  async function pairingStatus(kind, publicKeyB64) {
    let hex;
    try { hex = keyHex(decodeKey(publicKeyB64)); } catch { return { status: 'not_found', supportsV2: false }; }
    const { rows: [r] } = await db.query(`SELECT * FROM auth_requests WHERE kind = $1 AND public_key = $2`, [kind, hex]);
    if (!r || pairingExpired(r)) return { status: 'not_found', supportsV2: false };
    if (r.response) return { status: 'authorized', supportsV2: !!r.supports_v2, consumed: !!r.consumed_at };
    return { status: 'pending', supportsV2: !!r.supports_v2 };
  }

  /** First write wins; a repeat answer for an already-answered request is a
   *  no-op. An EXPIRED request cannot be answered (#610): approving a QR
   *  that had already aged out reported success and then lost the answer to
   *  the next sweep. */
  async function pairingRespond(kind, accountId, { publicKey, response }) {
    const hex = keyHex(decodeKey(publicKey));
    if (typeof response !== 'string' || !response) throw new ApiError(400, 'missing_response');
    const found = await db.tx(async (t) => {
      const { rows: [r] } = await t.query(`SELECT * FROM auth_requests WHERE kind = $1 AND public_key = $2`, [kind, hex]);
      if (!r) return 'missing';
      if (pairingExpired(r)) {
        await t.query(`DELETE FROM auth_requests WHERE id = $1`, [r.id]);
        return 'expired';
      }
      if (!r.response) {
        await t.query(
          `UPDATE auth_requests SET response = $1, response_account_id = $2, updated_at = now() WHERE id = $3`,
          [response, accountId, r.id]);
      }
      return 'ok';
    });
    if (found === 'missing') throw new ApiError(404, 'request_not_found');
    if (found === 'expired') throw new ApiError(410, 'request_expired');
    return { success: true };
  }

  /** Unanswered requests age out from CREATION; answered ones from their
   *  ANSWER. One combined created_at cutoff deleted a just-approved request
   *  whose QR had sat pending for a day — the approval vanished before the
   *  requester's next poll (#610). */
  async function sweepPairings() {
    await db.query(
      `DELETE FROM auth_requests
       WHERE (response IS NULL AND created_at < $1) OR (response IS NOT NULL AND updated_at < $2)`,
      [new Date(Date.now() - PAIRING_TTL_MS).toISOString(), new Date(Date.now() - ANSWERED_TTL_MS).toISOString()]);
  }

  // ── machines ──────────────────────────────────────────────────────────────
  async function liveness(accountId) {
    // alive = an unexpired, unreleased lease; seenAt = the newest renewal we
    // ever saw for that daemon (so an offline machine still reads honestly).
    const { rows } = await db.query(
      `SELECT daemon_id,
              bool_or(released_at IS NULL AND expires_at > now()) AS alive,
              max(renewed_at) AS seen_at
       FROM daemon_leases WHERE account_id = $1 GROUP BY daemon_id`, [accountId]);
    return new Map(rows.map((r) => [r.daemon_id, { alive: !!r.alive, seenAt: r.seen_at ? ms(r.seen_at) : 0 }]));
  }

  async function listMachines(accountId) {
    const [{ rows }, live] = await Promise.all([
      db.query(`SELECT * FROM machines WHERE account_id = $1 ORDER BY last_active_at DESC`, [accountId]),
      liveness(accountId),
    ]);
    return { machines: rows.map((r) => machineOut(r, live)) };
  }

  async function getMachine(accountId, id) {
    const [{ rows: [r] }, live] = await Promise.all([
      db.query(`SELECT * FROM machines WHERE id = $1 AND account_id = $2`, [id, accountId]),
      liveness(accountId),
    ]);
    if (!r) throw new ApiError(404, 'machine_not_found');
    return { machine: machineOut(r, live) };
  }

  /** Upsert: the daemon's full sealed blob replaces the stored one (version
   *  bump); a new daemonState lands only when the caller sends one.
   *  `expectedMetadataVersion` (optional) makes the replace conditional: a
   *  row at any other metadata version — or no row at all — answers 409
   *  metadata_version_mismatch and nothing changes. The daemon's key repair
   *  sends the version its own CAS write produced, so an app rename that
   *  lands in between is never replaced (Astra on b2aa492d, #61); callers
   *  omitting the field keep the unconditional replace. */
  async function upsertMachine(accountId, { id, metadata, daemonState, dataEncryptionKey, expectedMetadataVersion }) {
    // "." and ".." pass the character class but vanish under URL path
    // normalisation, so such a machine could be created and listed yet never
    // fetched, patched, deleted or tunnelled to (#609). Dots INSIDE a name
    // stay legal (host.local).
    if (typeof id !== 'string' || !/^[\w.-]{1,128}$/.test(id) || id === '.' || id === '..') throw new ApiError(400, 'bad_machine_id');
    if (typeof metadata !== 'string') throw new ApiError(400, 'missing_metadata');
    const expectVersion = expectedMetadataVersion === undefined || expectedMetadataVersion === null ? null : Number(expectedMetadataVersion);
    if (expectVersion !== null && !Number.isInteger(expectVersion)) throw new ApiError(400, 'bad_expected_metadata_version');
    const row = await db.tx(async (t) => {
      const { rows: [existing] } = await t.query(`SELECT * FROM machines WHERE id = $1`, [id]);
      if (existing && existing.account_id !== accountId) throw new ApiError(403, 'machine_owned_elsewhere');
      if (expectVersion !== null && (!existing || Number(existing.metadata_version) !== expectVersion)) {
        throw new ApiError(409, 'metadata_version_mismatch');
      }
      if (!existing) {
        const { rows: [created] } = await t.query(
          `INSERT INTO machines (id, account_id, metadata, metadata_version, daemon_state, daemon_state_version, data_encryption_key)
           VALUES ($1, $2, $3, 1, $4, $5, $6) RETURNING *`,
          [id, accountId, metadata, daemonState ?? null, daemonState ? 1 : 0, dataEncryptionKey ?? null]);
        return created;
      }
      const { rows: [updated] } = await t.query(
        `UPDATE machines SET
           metadata = $2,
           metadata_version = CASE WHEN metadata = $2 THEN metadata_version ELSE metadata_version + 1 END,
           daemon_state = COALESCE($3, daemon_state),
           daemon_state_version = CASE WHEN $3::text IS NULL THEN daemon_state_version ELSE daemon_state_version + 1 END,
           data_encryption_key = COALESCE($4, data_encryption_key),
           seq = seq + 1, last_active_at = now(), updated_at = now()
         WHERE id = $1 RETURNING *`,
        [id, metadata, daemonState ?? null, dataEncryptionKey ?? null]);
      return updated;
    });
    const live = await liveness(accountId);
    return { machine: machineOut(row, live) };
  }

  /** Version-checked partial update (CAS) for metadata and/or daemonState.
   *  Answers 'version-mismatch' with the current versions instead of failing,
   *  so a heartbeat can re-sync and land on its next beat. */
  async function patchMachine(accountId, id, body) {
    const wantMeta = typeof body.metadata === 'string';
    const wantState = typeof body.daemonState === 'string';
    if (!wantMeta && !wantState) throw new ApiError(400, 'nothing_to_update');
    const out = await db.tx(async (t) => {
      const { rows: [r] } = await t.query(`SELECT * FROM machines WHERE id = $1 AND account_id = $2`, [id, accountId]);
      if (!r) throw new ApiError(404, 'machine_not_found');
      const cur = { metadataVersion: Number(r.metadata_version), daemonStateVersion: Number(r.daemon_state_version) };
      if (wantMeta && body.expectedMetadataVersion !== undefined && Number(body.expectedMetadataVersion) !== cur.metadataVersion) {
        return { result: 'version-mismatch', ...cur, metadata: r.metadata, daemonState: r.daemon_state };
      }
      if (wantState && body.expectedDaemonStateVersion !== undefined && Number(body.expectedDaemonStateVersion) !== cur.daemonStateVersion) {
        return { result: 'version-mismatch', ...cur, metadata: r.metadata, daemonState: r.daemon_state };
      }
      const { rows: [u] } = await t.query(
        `UPDATE machines SET
           metadata = COALESCE($3, metadata),
           metadata_version = CASE WHEN $3::text IS NULL THEN metadata_version ELSE metadata_version + 1 END,
           daemon_state = COALESCE($4, daemon_state),
           daemon_state_version = CASE WHEN $4::text IS NULL THEN daemon_state_version ELSE daemon_state_version + 1 END,
           seq = seq + 1, updated_at = now(),
           last_active_at = CASE WHEN $4::text IS NULL THEN last_active_at ELSE now() END
         WHERE id = $1 AND account_id = $2 RETURNING *`,
        [id, accountId, wantMeta ? body.metadata : null, wantState ? body.daemonState : null]);
      return { result: 'success', metadataVersion: Number(u.metadata_version), daemonStateVersion: Number(u.daemon_state_version) };
    });
    return out;
  }

  async function deleteMachine(accountId, id) {
    const { rows } = await db.query(`DELETE FROM machines WHERE id = $1 AND account_id = $2 RETURNING id`, [id, accountId]);
    if (rows.length === 0) throw new ApiError(404, 'machine_not_found');
    return { ok: true };
  }

  // ── push tokens + delivery ────────────────────────────────────────────────
  async function registerPushToken(accountId, token) {
    if (typeof token !== 'string' || !token) throw new ApiError(400, 'missing_token');
    await db.tx(async (t) => {
      const { rows: [r] } = await t.query(`SELECT id FROM push_tokens WHERE account_id = $1 AND token = $2`, [accountId, token]);
      if (r) { await t.query(`UPDATE push_tokens SET updated_at = now() WHERE id = $1`, [r.id]); return; }
      await t.query(`INSERT INTO push_tokens (id, account_id, token) VALUES ($1, $2, $3)`, [newId('p'), accountId, token]);
    });
    return { success: true };
  }
  async function listPushTokens(accountId) {
    const { rows } = await db.query(`SELECT * FROM push_tokens WHERE account_id = $1 ORDER BY created_at`, [accountId]);
    return { tokens: rows.map((r) => ({ id: r.id, token: r.token, createdAt: ms(r.created_at), updatedAt: ms(r.updated_at) })) };
  }
  async function deletePushToken(accountId, token) {
    await db.query(`DELETE FROM push_tokens WHERE account_id = $1 AND token = $2`, [accountId, token]);
    return { success: true };
  }
  async function dropPushToken(token) {
    await db.query(`DELETE FROM push_tokens WHERE token = $1`, [token]);
  }

  /** Deliver a notification to every device of the account via Expo. One
   *  request per token: Expo rejects batches that mix projects, and a single
   *  stale token from another Expo app would otherwise 400 the whole batch.
   *  DeviceNotRegistered tokens are dropped so they stop costing a request.
   *  Each device gets its own deadline that covers the request AND the body
   *  read, and devices are contacted a few at a time: a 200 whose JSON never
   *  completed used to hold a serial loop forever, so every later device on
   *  the account got nothing (#608). The body is settled on EVERY response
   *  path — 2xx, non-2xx, and abort — before the deadline timer is cleared:
   *  a non-2xx used to return with its body unread, so a stalled 500 kept
   *  its connection pinned long after the device was written off. */
  async function sendPush(accountId, { title, body, data }) {
    if (typeof title !== 'string' || !title) throw new ApiError(400, 'missing_title');
    const { tokens: list } = await listPushTokens(accountId);
    const message = (token) => JSON.stringify([{
      to: token, title, body: typeof body === 'string' && body ? body : undefined, sound: 'default',
      data: { source: 'joy', timestamp: Date.now(), ...(data && typeof data === 'object' ? data : {}) },
    }]);
    const deliverOne = async (token) => {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(new Error('expo_timeout')), pushTimeoutMs);
      let r = null;
      try {
        r = await doFetch(EXPO_PUSH_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: message(token),
          signal: ac.signal,
        });
        // Read the body under the deadline whatever the status: Expo puts
        // request-level errors ({errors:[{code,message}]}) in non-2xx bodies,
        // and an unread body is an open connection.
        const j = await underAbort(r.json().catch(() => null), ac.signal);
        const ticket = j?.data?.[0];
        if (r.ok && ticket?.status === 'ok') return { ok: true };
        const requestError = j?.errors?.[0];
        const detail = ticket?.details?.error ?? ticket?.message
          ?? (requestError ? `HTTP ${r.status} ${requestError.code ?? requestError.message ?? ''}`.trim() : `HTTP ${r.status}`);
        if (ticket?.details?.error === 'DeviceNotRegistered') await dropPushToken(token);
        return { ok: false, error: detail };
      } catch (e) {
        return { ok: false, error: ac.signal.aborted ? 'timeout' : String(e?.message ?? e) };
      } finally {
        // Whatever path got us here, no byte of this response is read after
        // this point: abort tears down anything still open (a body the JSON
        // parser gave up on, a read the deadline cut short) so the connection
        // is released with the device, not whenever the peer feels like it.
        if (!ac.signal.aborted && r?.body && !r.bodyUsed) { try { r.body.cancel().catch(() => {}); } catch { /* not a stream */ } }
        clearTimeout(timer);
      }
    };
    const results = await mapBounded(list.map((t) => t.token), pushConcurrency, deliverOne);
    let sent = 0;
    const errors = [];
    results.forEach((res, i) => {
      if (res.ok) sent++;
      else errors.push({ token: list[i].token.slice(0, 24), error: res.error });
    });
    return { sent, targeted: list.length, errors };
  }

  return {
    login, accountExists, profile,
    pairingRequest, pairingStatus, pairingRespond, sweepPairings,
    listMachines, getMachine, upsertMachine, patchMachine, deleteMachine,
    registerPushToken, listPushTokens, deletePushToken, sendPush,
  };
}
