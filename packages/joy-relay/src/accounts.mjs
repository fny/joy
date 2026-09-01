// The account plane, served natively: login, device pairing, profile,
// machines and push tokens. Everything here is CONTENT-BLIND — public keys,
// sealed pairing responses, sealed machine blobs and opaque Expo tokens. The
// relay never sees an account secret; it only proves a device holds one
// (ed25519 challenge) or was handed one (a pairing response sealed by an
// already-authorized device).
import { createPublicKey, randomBytes, randomUUID, verify } from 'node:crypto';
import { ApiError } from './core.mjs';

const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const KEY_LEN = 32;
const PAIRING_TTL_MS = 24 * 60 * 60 * 1000;
const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

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

export function createAccounts(db, tokens, { fetchImpl } = {}) {
  const doFetch = fetchImpl ?? fetch;

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
  // stores the sealed blob and, once answered, mints the requester a token.
  async function pairingRequest(kind, { publicKey, supportsV2 }) {
    const hex = keyHex(decodeKey(publicKey));
    const row = await db.tx(async (t) => {
      const { rows: [existing] } = await t.query(
        `SELECT * FROM auth_requests WHERE kind = $1 AND public_key = $2`, [kind, hex]);
      if (existing) return existing;
      const { rows: [created] } = await t.query(
        `INSERT INTO auth_requests (id, kind, public_key, supports_v2) VALUES ($1, $2, $3, $4) RETURNING *`,
        [newId('r'), kind, hex, supportsV2 === true]);
      return created;
    });
    if (row.response && row.response_account_id) {
      return { state: 'authorized', token: tokens.mint(row.response_account_id, { session: row.id }), response: row.response };
    }
    return { state: 'requested' };
  }

  async function pairingStatus(kind, publicKeyB64) {
    let hex;
    try { hex = keyHex(decodeKey(publicKeyB64)); } catch { return { status: 'not_found', supportsV2: false }; }
    const { rows: [r] } = await db.query(`SELECT * FROM auth_requests WHERE kind = $1 AND public_key = $2`, [kind, hex]);
    if (!r) return { status: 'not_found', supportsV2: false };
    if (r.response) return { status: 'authorized', supportsV2: !!r.supports_v2 };
    return { status: 'pending', supportsV2: !!r.supports_v2 };
  }

  /** First write wins; a repeat answer for an already-answered request is a no-op. */
  async function pairingRespond(kind, accountId, { publicKey, response }) {
    const hex = keyHex(decodeKey(publicKey));
    if (typeof response !== 'string' || !response) throw new ApiError(400, 'missing_response');
    const found = await db.tx(async (t) => {
      const { rows: [r] } = await t.query(`SELECT * FROM auth_requests WHERE kind = $1 AND public_key = $2`, [kind, hex]);
      if (!r) return false;
      if (!r.response) {
        await t.query(
          `UPDATE auth_requests SET response = $1, response_account_id = $2, updated_at = now() WHERE id = $3`,
          [response, accountId, r.id]);
      }
      return true;
    });
    if (!found) throw new ApiError(404, 'request_not_found');
    return { success: true };
  }

  async function sweepPairings() {
    await db.query(`DELETE FROM auth_requests WHERE created_at < $1`, [new Date(Date.now() - PAIRING_TTL_MS).toISOString()]);
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
   *  bump); a new daemonState lands only when the caller sends one. */
  async function upsertMachine(accountId, { id, metadata, daemonState, dataEncryptionKey }) {
    if (typeof id !== 'string' || !/^[\w.-]{1,128}$/.test(id)) throw new ApiError(400, 'bad_machine_id');
    if (typeof metadata !== 'string') throw new ApiError(400, 'missing_metadata');
    const row = await db.tx(async (t) => {
      const { rows: [existing] } = await t.query(`SELECT * FROM machines WHERE id = $1`, [id]);
      if (existing && existing.account_id !== accountId) throw new ApiError(403, 'machine_owned_elsewhere');
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
   *  DeviceNotRegistered tokens are dropped so they stop costing a request. */
  async function sendPush(accountId, { title, body, data }) {
    if (typeof title !== 'string' || !title) throw new ApiError(400, 'missing_title');
    const { tokens: list } = await listPushTokens(accountId);
    let sent = 0;
    const errors = [];
    for (const { token } of list) {
      try {
        const r = await doFetch(EXPO_PUSH_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify([{
            to: token, title, body: typeof body === 'string' && body ? body : undefined, sound: 'default',
            data: { source: 'joy', timestamp: Date.now(), ...(data && typeof data === 'object' ? data : {}) },
          }]),
        });
        const j = r.ok ? await r.json().catch(() => null) : null;
        const ticket = j?.data?.[0];
        if (r.ok && ticket?.status === 'ok') { sent++; continue; }
        const detail = ticket?.details?.error ?? ticket?.message ?? `HTTP ${r.status}`;
        errors.push({ token: token.slice(0, 24), error: detail });
        if (ticket?.details?.error === 'DeviceNotRegistered') await dropPushToken(token);
      } catch (e) {
        errors.push({ token: token.slice(0, 24), error: String(e?.message ?? e) });
      }
    }
    return { sent, targeted: list.length, errors };
  }

  return {
    login, accountExists, profile,
    pairingRequest, pairingStatus, pairingRespond, sweepPairings,
    listMachines, getMachine, upsertMachine, patchMachine, deleteMachine,
    registerPushToken, listPushTokens, deletePushToken, sendPush,
  };
}
