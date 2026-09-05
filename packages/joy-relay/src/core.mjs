// The session coordinator: every native mutation is one serialized
// transaction that (1) fences the caller, (2) validates against current
// state, (3) allocates the next session seq, (4) mutates relational state,
// and (5) appends the canonical session_events row; wake-ups fire AFTER
// commit. The relay never sees plaintext: `ciphertext` is opaque; visible
// fields exist only for routing, fencing, and reconciliation.
//
// Post-review hardening (see the codex review in PR #1): strict queue-head
// claim discipline with re-offered deliveries, delivery-fenced submit/start,
// a DB-enforced single execution slot, reconcile restricted to orphans,
// dispatching-aware orphan sweep, creation idempotency hashes, centralized
// runtime-fact idempotency, daemon↔account binding, and admission quotas.
import { createHash, randomUUID } from 'node:crypto';

export const MAX_CIPHERTEXT = 256 * 1024;   // bytes of base64 payload accepted inline
export const MAX_QUEUED_TURNS = 100;
export const MAX_SESSIONS_PER_ACCOUNT = 200;
export const MAX_DAEMONS_PER_ACCOUNT = 50;
export const MAX_EVENTS_PER_SESSION = 50_000;

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message ?? code);
    this.status = status;
    this.code = code;
  }
}

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
export const hashToken = sha256;

/** Canonical request hash: binds the visible header + ciphertext so an
 *  idempotency-key reuse with different content 409s instead of colliding. */
export function requestHash(fields) {
  return sha256(JSON.stringify(fields));
}

async function one(t, sql, params) {
  const { rows } = await t.query(sql, params);
  return rows[0] ?? null;
}

/** Allocate the next seq for a session and bump revision. Caller is in tx. */
export async function nextSeq(t, sessionId) {
  const row = await one(
    t,
    `UPDATE native_sessions SET next_seq = next_seq + 1, revision = revision + 1, updated_at = now()
     WHERE id = $1 RETURNING next_seq - 1 AS seq, revision`,
    [sessionId],
  );
  return { seq: String(row.seq), revision: String(row.revision) };
}

export async function appendEvent(t, sessionId, seq, fields) {
  const eventId = fields.eventId ?? randomUUID();
  await t.query(
    `INSERT INTO session_events (session_id, seq, event_id, kind, command_id, turn_id,
       origin_actor_id, origin_client_intent_id, origin_request_hash, runtime_event_id, ciphertext)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [sessionId, seq, eventId, fields.kind, fields.commandId ?? null, fields.turnId ?? null,
     fields.originActorId ?? null, fields.originClientIntentId ?? null, fields.originRequestHash ?? null,
     fields.runtimeEventId ?? null, fields.ciphertext ?? null],
  );
  return eventId;
}

function acceptedIntentFrom(cmd) {
  return {
    clientIntentId: cmd.client_intent_id,
    requestHash: cmd.request_hash,
    commandId: cmd.id,
    eventId: cmd.event_id,
    seq: String(cmd.seq),
    turnId: cmd.turn_id ?? null,
    disposition: cmd.disposition,
  };
}

/** Idempotency guard shared by all intent endpoints. Returns the previously
 *  accepted intent (200-replay) or null; throws on hash mismatch. */
async function findExistingIntent(t, sessionId, actorId, clientIntentId, hash) {
  const prior = await one(
    t,
    `SELECT * FROM commands WHERE session_id = $1 AND producer_actor_id = $2 AND client_intent_id = $3`,
    [sessionId, actorId, clientIntentId],
  );
  if (!prior) return null;
  if (prior.request_hash !== hash) throw new ApiError(409, 'idempotency_mismatch');
  return acceptedIntentFrom(prior);
}

export function createCore(db, notify) {
  async function loadSession(t, sessionId, accountId) {
    const s = await one(t, `SELECT * FROM native_sessions WHERE id = $1`, [sessionId]);
    if (!s || (accountId && s.account_id !== accountId)) throw new ApiError(404, 'session_not_found');
    return s;
  }

  /** Fenced daemon context: lease must be current (released_at null),
   *  unexpired BY DATABASE TIME, and match the presented epoch. Every
   *  daemon-side write calls this INSIDE its transaction. */
  async function fencedLease(t, leaseId, tokenHash, epoch) {
    const lease = await one(
      t,
      `SELECT *, (expires_at < now()) AS is_expired FROM daemon_leases
       WHERE id = $1 AND released_at IS NULL AND token_hash = $2`,
      [leaseId, tokenHash],
    );
    if (!lease) throw new ApiError(401, 'lease_unknown');
    if (epoch !== undefined && String(lease.epoch) !== String(epoch)) throw new ApiError(412, 'lease_epoch_stale');
    if (lease.is_expired) throw new ApiError(412, 'lease_expired');
    return lease;
  }

  /** Daemon↔account binding: the daemon's lease history decides ownership.
   *  A daemon that has never leased cannot be targeted at all — first lease
   *  acquisition under an account claims the id. */
  async function requireOwnedDaemon(t, daemonId, accountId) {
    const latest = await one(
      t, `SELECT account_id FROM daemon_leases WHERE daemon_id = $1 ORDER BY acquired_at DESC LIMIT 1`, [daemonId]);
    if (!latest) throw new ApiError(409, 'daemon_unknown');
    if (latest.account_id !== accountId) throw new ApiError(403, 'daemon_owned_by_other_account');
  }

  /** Tunnel route ownership gate — same lease-history rule as
   *  requireOwnedDaemon, callable outside a core transaction. */
  async function assertDaemonOwned(daemonId, accountId) {
    await db.tx(async (t) => requireOwnedDaemon(t, daemonId, accountId));
  }

  // ── Sessions ──────────────────────────────────────────────────────────────

  /** Both creation modes (§9): app spawn (provisioning + spawn command) and
   *  daemon announce_existing (starting, no spawn command). Idempotent by
   *  (account, actor, creationIntentId) with a FULL request hash — a changed
   *  retry is a 409, never a silent replay. */
  async function createSession(accountId, actorId, body) {
    const mode = body.mode ?? 'spawn';
    const hash = requestHash({
      mode, creationIntentId: body.creationIntentId, daemonId: body.daemonId,
      spawnSpec: body.spawnSpec ?? null, localSessionId: body.localSessionId ?? null,
      sessionKeyEnvelope: body.sessionKeyEnvelope ?? null, encryptedMetadata: body.encryptedMetadata ?? null,
    });
    let wake = null;
    const result = await db.tx(async (t) => {
      const prior = await one(
        t,
        `SELECT * FROM native_sessions WHERE account_id = $1 AND creator_actor_id = $2 AND creation_intent_id = $3`,
        [accountId, actorId, body.creationIntentId],
      );
      if (prior) {
        if (prior.creation_request_hash && prior.creation_request_hash !== hash) throw new ApiError(409, 'idempotency_mismatch');
        return { sessionId: prior.id, state: prior.state, replay: true };
      }
      await requireOwnedDaemon(t, body.daemonId, accountId);
      const { rows: [{ n: sessionCount }] } = await t.query(
        `SELECT count(*)::int AS n FROM native_sessions WHERE account_id = $1 AND state NOT IN ('archived')`, [accountId]);
      if (sessionCount >= MAX_SESSIONS_PER_ACCOUNT) throw new ApiError(429, 'too_many_sessions');

      const sessionId = randomUUID();
      const state = mode === 'announce_existing' ? 'starting' : 'provisioning';
      await t.query(
        `INSERT INTO native_sessions (id, account_id, owner_daemon_id, local_session_id, creation_intent_id,
           creator_actor_id, state, session_key_envelope, encrypted_metadata, creation_request_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [sessionId, accountId, body.daemonId, mode === 'announce_existing' ? body.localSessionId : null,
         body.creationIntentId, actorId, state, body.sessionKeyEnvelope ?? null, body.encryptedMetadata ?? null, hash],
      );
      const { seq } = await nextSeq(t, sessionId);
      let spawnCommandId = null;
      if (mode === 'spawn') {
        spawnCommandId = randomUUID();
        const eventId = await appendEvent(t, sessionId, seq, {
          kind: 'session.provisioned', commandId: spawnCommandId,
          originActorId: actorId, originClientIntentId: body.creationIntentId, originRequestHash: hash,
        });
        await t.query(
          `INSERT INTO commands (id, session_id, seq, event_id, producer_actor_id, client_intent_id, request_hash,
             kind, ciphertext, disposition, state)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'spawn_session',$8,'queued','queued')`,
          [spawnCommandId, sessionId, seq, eventId, actorId, body.creationIntentId, hash, body.spawnSpec ?? null],
        );
        wake = { daemonId: body.daemonId, lane: 'work' };
      } else {
        await appendEvent(t, sessionId, seq, {
          kind: 'session.started',
          originActorId: actorId, originClientIntentId: body.creationIntentId, originRequestHash: hash,
        });
      }
      return { sessionId, state, spawnCommandId, replay: false };
    });
    if (wake) notify.wakeDaemon(wake.daemonId, wake.lane);
    notify.pokeAccount(accountId, result.sessionId, ['state']);
    return result;
  }

  /** Daemon binds a spawned session to its local runtime — fenced INSIDE the
   *  transaction, spawn command verified (kind, session, state). */
  async function bindSession(sessionId, leaseRef, body) {
    const accountId = await db.tx(async (t) => {
      const lease = await fencedLease(t, leaseRef.id, leaseRef.token_hash, leaseRef.epoch);
      const s = await loadSession(t, sessionId, null);
      if (s.owner_daemon_id !== lease.daemon_id) throw new ApiError(403, 'not_owner_daemon');
      if (s.state !== 'provisioning' && s.state !== 'failed') {
        if (s.local_session_id === body.localSessionId) {
          // Idempotent re-bind (a lost reply): take the envelope the daemon
          // is sealing under NOW, so row and daemon can never disagree (#116).
          if (typeof body.sessionKeyEnvelope === 'string' && body.sessionKeyEnvelope && body.sessionKeyEnvelope !== s.session_key_envelope) {
            await t.query(`UPDATE native_sessions SET session_key_envelope = $2, updated_at = now() WHERE id = $1`, [sessionId, body.sessionKeyEnvelope]);
          }
          return s.account_id;
        }
        throw new ApiError(409, 'already_bound');
      }
      if (!body.spawnCommandId) throw new ApiError(400, 'missing_spawnCommandId');
      const spawn = await one(
        t,
        `SELECT * FROM commands WHERE id = $1 AND session_id = $2 AND kind = 'spawn_session'`,
        [body.spawnCommandId, sessionId]);
      if (!spawn) throw new ApiError(404, 'spawn_command_not_found');
      if (spawn.state === 'cancelled') throw new ApiError(409, 'spawn_cancelled');
      await t.query(`UPDATE commands SET state = 'applied', disposition = 'applied' WHERE id = $1`, [spawn.id]);
      await t.query(
        `UPDATE native_sessions SET local_session_id = $2, session_key_envelope = $3,
           encrypted_metadata = COALESCE($4, encrypted_metadata), state = 'starting', updated_at = now()
         WHERE id = $1`,
        [sessionId, body.localSessionId, body.sessionKeyEnvelope, body.encryptedMetadata ?? null],
      );
      const { seq } = await nextSeq(t, sessionId);
      await appendEvent(t, sessionId, seq, { kind: 'session.started', commandId: spawn.id });
      return s.account_id;
    });
    notify.pokeAccount(accountId, sessionId, ['state', 'events']);
  }

  /** Daemon publishes the session CARD: encrypted metadata (sealed with the
   *  session content key) and/or lifecycle state. Fenced to the owning daemon.
   *  This is what lets clients render the session list from v2 alone. */
  async function updateSessionCard(sessionId, leaseRef, body) {
    const allowed = new Set(['starting', 'active', 'detached', 'archived']);
    if (body.state !== undefined && !allowed.has(body.state)) throw new ApiError(400, 'bad_state');
    if (body.encryptedMetadata !== undefined && typeof body.encryptedMetadata !== 'string') {
      throw new ApiError(400, 'bad_metadata');
    }
    // The owning daemon may re-envelope the session key (the account's
    // content key rotated, e.g. a key-label change): clients read the key
    // from THIS column, so a re-stamp that only touched the card would leave
    // every existing session unreadable.
    if (body.sessionKeyEnvelope !== undefined && typeof body.sessionKeyEnvelope !== 'string') {
      throw new ApiError(400, 'bad_envelope');
    }
    const accountId = await db.tx(async (t) => {
      const lease = await fencedLease(t, leaseRef.id, leaseRef.token_hash, leaseRef.epoch);
      const s = await loadSession(t, sessionId, null);
      if (s.owner_daemon_id !== lease.daemon_id) throw new ApiError(403, 'not_owner_daemon');
      await t.query(
        `UPDATE native_sessions SET
           encrypted_metadata = COALESCE($2, encrypted_metadata),
           state = COALESCE($3, state),
           session_key_envelope = COALESCE($4, session_key_envelope),
           revision = revision + 1, updated_at = now()
         WHERE id = $1`,
        [sessionId, body.encryptedMetadata ?? null, body.state ?? null, body.sessionKeyEnvelope ?? null]);
      return s.account_id;
    });
    notify.pokeAccount(accountId, sessionId, ['state']);
  }

  /** Daemon reports a spawn could not run (e.g. cwd missing, createDir off).
   *  Marks the session failed with a machine-readable reason so the client can
   *  offer to create the directory and retry. Fenced to the owning daemon. */
  async function spawnFailed(sessionId, leaseRef, reason) {
    let poke = null;
    await db.tx(async (t) => {
      const lease = await fencedLease(t, leaseRef.id, leaseRef.token_hash, leaseRef.epoch);
      const s = await loadSession(t, sessionId, null);
      if (s.owner_daemon_id !== lease.daemon_id || s.account_id !== lease.account_id) throw new ApiError(403, 'not_owner_daemon');
      if (s.state !== 'provisioning' && s.state !== 'starting') return; // already progressed
      await t.query(`UPDATE native_sessions SET state = 'failed', spawn_failure = $2, updated_at = now() WHERE id = $1`,
        [sessionId, String(reason).slice(0, 300)]);
      poke = [s.account_id, s.id];
    });
    if (poke) notify.pokeAccount(poke[0], poke[1], ['state']);
    return { ok: true };
  }

  /** Client retries a FAILED spawn, opting into directory creation. Resets the
   *  session to provisioning, sets spawn_create_dir so the next work offer
   *  carries it, re-queues the spawn command, and wakes the daemon. */
  async function retrySpawn(accountId, actorId, sessionId, createDir) {
    let wake = null;
    const out = await db.tx(async (t) => {
      const s = await loadSession(t, sessionId, accountId);
      if (s.state !== 'failed' && s.state !== 'provisioning') throw new ApiError(409, 'not_retryable');
      if (s.local_session_id) throw new ApiError(409, 'already_bound');
      const spawn = await one(t, `SELECT * FROM commands WHERE session_id = $1 AND kind = 'spawn_session'`, [sessionId]);
      if (!spawn) throw new ApiError(404, 'spawn_command_not_found');
      await t.query(
        `UPDATE native_sessions SET state = 'provisioning', spawn_failure = NULL, spawn_create_dir = $2, updated_at = now() WHERE id = $1`,
        [sessionId, createDir === true]);
      await t.query(`UPDATE commands SET state = 'queued', disposition = 'queued' WHERE id = $1`, [spawn.id]);
      // clear any prior delivery so offerCommand re-offers cleanly
      await t.query(`UPDATE deliveries SET disposition = 'superseded' WHERE command_id = $1 AND disposition IS NULL`, [spawn.id]);
      wake = s.owner_daemon_id;
      return { sessionId, state: 'provisioning', createDir: createDir === true };
    });
    if (wake) notify.wakeDaemon(wake, 'work');
    notify.pokeAccount(accountId, sessionId, ['state']);
    return out;
  }

  // ── Prompt acceptance ─────────────────────────────────────────────────────

  /** hooks.beforeAccept(t) / hooks.afterAccept(t, accepted) run INSIDE the
   *  acceptance transaction, after the replay check — the attachment
   *  reference + claim ride the same commit as the command, so a crash can
   *  never leave an accepted prompt pointing at a sweepable attachment, and
   *  a replayed retry never re-references anything. */
  async function acceptPrompt(accountId, actorId, sessionId, body, hooks = {}) {
    if ((body.ciphertext?.length ?? 0) > MAX_CIPHERTEXT) throw new ApiError(413, 'ciphertext_too_large');
    // The hash covers the INTENT, not the ciphertext: sealed content is
    // re-nonced on every seal, so a retried send of the same message never
    // reproduces the bytes — hashing them would turn every honest retry
    // into idempotency_mismatch. The clientIntentId is the identity.
    const hash = requestHash({ kind: 'prompt', clientIntentId: body.clientIntentId });
    let daemonId = null;
    const accepted = await db.tx(async (t) => {
      const s = await loadSession(t, sessionId, accountId);
      const replay = await findExistingIntent(t, sessionId, actorId, body.clientIntentId, hash);
      if (replay) return replay;
      if (hooks.beforeAccept) await hooks.beforeAccept(t);
      // No prompts before the session key exists (spawned sessions bind
      // first) or after the session is dead.
      if (s.state === 'provisioning' || s.state === 'failed' || s.state === 'archived') {
        throw new ApiError(409, 'session_not_ready');
      }
      const { rows: [{ count }] } = await t.query(
        `SELECT count(*)::int AS count FROM turns WHERE session_id = $1 AND state IN ('queued','dispatching')`, [sessionId]);
      if (count >= MAX_QUEUED_TURNS) throw new ApiError(429, 'queue_full');

      const { seq } = await nextSeq(t, sessionId);
      const commandId = randomUUID();
      const turnId = randomUUID();
      const eventId = await appendEvent(t, sessionId, seq, {
        kind: 'turn.queued', commandId, turnId,
        originActorId: actorId, originClientIntentId: body.clientIntentId, originRequestHash: hash,
        ciphertext: body.ciphertext,
      });
      await t.query(
        `INSERT INTO commands (id, session_id, seq, event_id, producer_actor_id, client_intent_id, request_hash,
           kind, ciphertext, turn_id, disposition, state)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'prompt',$8,$9,'queued','queued')`,
        [commandId, sessionId, seq, eventId, actorId, body.clientIntentId, hash, body.ciphertext, turnId],
      );
      await t.query(
        `INSERT INTO turns (id, session_id, prompt_command_id, request_seq, state) VALUES ($1,$2,$3,$4,'queued')`,
        [turnId, sessionId, commandId, seq],
      );
      daemonId = s.owner_daemon_id;
      const out = {
        clientIntentId: body.clientIntentId, requestHash: hash, commandId, eventId,
        seq, turnId, disposition: 'queued',
      };
      if (hooks.afterAccept) await hooks.afterAccept(t, out);
      return out;
    });
    if (daemonId) notify.wakeDaemon(daemonId, 'work');
    notify.pokeAccount(accountId, sessionId, ['events', 'state']);
    return accepted;
  }

  // ── Cancellation (§4) ─────────────────────────────────────────────────────

  async function acceptCancellation(accountId, actorId, sessionId, targetTurnId, body) {
    const scope = body.scope ?? 'turn_and_pending_before_barrier';
    const hash = requestHash({ kind: 'cancel', clientIntentId: body.clientIntentId, targetTurnId, scope });
    let wakeControl = null;
    const accepted = await db.tx(async (t) => {
      const s = await loadSession(t, sessionId, accountId);
      const replay = await findExistingIntent(t, sessionId, actorId, body.clientIntentId, hash);
      if (replay) return replay;
      const target = await one(t, `SELECT * FROM turns WHERE id = $1 AND session_id = $2`, [targetTurnId, sessionId]);
      if (!target) throw new ApiError(404, 'turn_not_found');

      const { seq } = await nextSeq(t, sessionId);
      const commandId = randomUUID();
      const eventId = await appendEvent(t, sessionId, seq, {
        kind: 'turn.cancel_requested', commandId, turnId: targetTurnId,
        originActorId: actorId, originClientIntentId: body.clientIntentId, originRequestHash: hash,
      });

      let disposition;
      let commandState = 'queued';
      if (target.state === 'terminal') {
        disposition = 'already_terminal';
        commandState = 'applied';
      } else if (target.state === 'queued') {
        // Cancel-before-start is airtight: mark the turn terminal(cancelled)
        // NOW; a late turn.start CAS will refuse it; delivery is suppressed.
        await terminalizeTurn(t, s, target, 'cancelled', { mode: 'before_start' });
        await t.query(`UPDATE commands SET state = 'cancelled', disposition = 'cancelled_before_start' WHERE id = $1`,
          [target.prompt_command_id]);
        disposition = 'cancelled_before_start';
        commandState = 'applied';
      } else {
        // dispatching / running / cancelling / orphaned — durable cancel
        // command on the control lane; evidence resolves it.
        await t.query(
          `UPDATE turns SET state = CASE WHEN state = 'orphaned' THEN 'orphaned' ELSE 'cancelling' END,
             cancel_requested = TRUE, cancel_seq = $2 WHERE id = $1`,
          [targetTurnId, seq]);
        disposition = 'cancellation_requested';
        wakeControl = s.owner_daemon_id;
      }

      // Barrier: drain every queued turn with request_seq < C.
      if (scope === 'turn_and_pending_before_barrier') {
        const { rows: queued } = await t.query(
          `SELECT * FROM turns WHERE session_id = $1 AND state = 'queued' AND request_seq < $2 AND id <> $3`,
          [sessionId, seq, targetTurnId]);
        for (const q of queued) {
          await terminalizeTurn(t, s, q, 'cancelled', { mode: 'barrier' });
          await t.query(`UPDATE commands SET state = 'cancelled', disposition = 'cancelled_by_barrier' WHERE id = $1`,
            [q.prompt_command_id]);
        }
      }

      await t.query(
        `INSERT INTO commands (id, session_id, seq, event_id, producer_actor_id, client_intent_id, request_hash,
           kind, target_turn_id, scope, barrier_seq, disposition, state)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'cancel',$8,$9,$10,$11,$12)`,
        [commandId, sessionId, seq, eventId, actorId, body.clientIntentId, hash, targetTurnId, scope, seq, disposition, commandState],
      );
      return { clientIntentId: body.clientIntentId, requestHash: hash, commandId, eventId, seq, turnId: targetTurnId, disposition };
    });
    if (wakeControl) notify.wakeDaemon(wakeControl, 'control');
    notify.pokeAccount(accountId, sessionId, ['events', 'state']);
    return accepted;
  }

  /** Shared terminalization: turn → terminal, pending cancel commands on the
   *  turn resolved, active slot cleared, event appended. Used by cancel-
   *  before-start, terminal facts, and terminal reconciliation so the three
   *  paths cannot diverge. */
  async function terminalizeTurn(t, session, turn, terminalState, meta, runtimeEventId, ciphertext) {
    await t.query(
      `UPDATE turns SET state = 'terminal', terminal_state = $2, terminal_meta = $3, terminal_at = now() WHERE id = $1`,
      [turn.id, terminalState, JSON.stringify(meta ?? {})]);
    if (session.active_turn_id === turn.id) {
      await t.query(`UPDATE native_sessions SET active_turn_id = NULL, updated_at = now() WHERE id = $1`, [session.id]);
    }
    await t.query(
      `UPDATE commands SET state = 'applied', disposition = $2 WHERE session_id = $3 AND kind = 'cancel'
         AND target_turn_id = $1 AND state IN ('queued','delivered')`,
      [turn.id, terminalState === 'cancelled' ? 'cancelled' : 'completed_before_cancel', session.id]);
    const { seq } = await nextSeq(t, session.id);
    await appendEvent(t, session.id, seq, {
      kind: 'turn.terminal', turnId: turn.id, runtimeEventId: runtimeEventId ?? null, ciphertext: ciphertext ?? null,
    });
    return seq;
  }

  // ── Daemon leases ─────────────────────────────────────────────────────────

  async function acquireLease(accountId, daemonId, body) {
    const token = randomUUID() + randomUUID();
    const lease = await db.tx(async (t) => {
      const latest = await one(
        t, `SELECT account_id, epoch, id, released_at FROM daemon_leases WHERE daemon_id = $1 ORDER BY acquired_at DESC LIMIT 1`,
        [daemonId]);
      if (latest && latest.account_id !== accountId) throw new ApiError(403, 'daemon_owned_by_other_account');
      if (!latest) {
        const { rows: [{ n }] } = await t.query(
          `SELECT count(DISTINCT daemon_id)::int AS n FROM daemon_leases WHERE account_id = $1`, [accountId]);
        if (n >= MAX_DAEMONS_PER_ACCOUNT) throw new ApiError(429, 'too_many_daemons');
      }
      const epoch = latest ? Number(latest.epoch) + 1 : 1;
      if (latest && !latest.released_at) {
        await t.query(`UPDATE daemon_leases SET released_at = now() WHERE id = $1`, [latest.id]);
      }
      const id = randomUUID();
      await t.query(
        `INSERT INTO daemon_leases (id, daemon_id, account_id, epoch, token_hash, capabilities, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6, now() + interval '20 seconds')`,
        [id, daemonId, accountId, epoch, hashToken(token), JSON.stringify(body.capabilities ?? {})]);
      return { leaseId: id, daemonId, epoch: String(epoch) };
    });
    // A new epoch fences out the old process; anything it had in flight will
    // be rejected on write and re-resolved via reconcile.
    return { ...lease, leaseToken: token, ttlSeconds: 20 };
  }

  async function renewLease(leaseId, tokenHash) {
    return db.tx(async (t) => {
      const lease = await fencedLease(t, leaseId, tokenHash);
      await t.query(`UPDATE daemon_leases SET renewed_at = now(), expires_at = now() + interval '20 seconds' WHERE id = $1`, [leaseId]);
      return { epoch: String(lease.epoch) };
    });
  }

  // ── Claims (two lanes, §6) ────────────────────────────────────────────────

  /** Offer discipline shared by both lanes: if the command already has an
   *  outstanding current-epoch delivery, RE-OFFER that same delivery (covers
   *  a lost claim response) — never skip past it, never mint a duplicate. */
  async function offerCommand(t, lease, c) {
    const existing = await one(
      t,
      `SELECT * FROM deliveries WHERE command_id = $1 AND lease_epoch = $2 AND disposition IS NULL
       ORDER BY offered_at DESC LIMIT 1`,
      [c.id, lease.epoch]);
    if (existing) {
      await t.query(`UPDATE deliveries SET offered_at = now() WHERE id = $1`, [existing.id]);
      return existing.id;
    }
    const { rows: [{ n }] } = await t.query(`SELECT count(*)::int AS n FROM deliveries WHERE command_id = $1`, [c.id]);
    const deliveryId = randomUUID();
    await t.query(
      `INSERT INTO deliveries (id, command_id, daemon_id, lease_epoch, lane, attempt)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [deliveryId, c.id, lease.daemon_id, lease.epoch, c.kind === 'cancel' ? 'control' : 'work', n + 1]);
    return deliveryId;
  }

  /** Work lane: per bound session, the spawn command (if provisioning) or the
   *  HEAD queued prompt — strictly oldest-first, only when nothing is
   *  executing. The head is never skipped. */
  async function claimWork(leaseId, tokenHash) {
    return db.tx(async (t) => {
      const lease = await fencedLease(t, leaseId, tokenHash);
      const { rows: sessions } = await t.query(
        `SELECT * FROM native_sessions WHERE owner_daemon_id = $1 AND account_id = $2 AND state NOT IN ('failed','archived')`,
        [lease.daemon_id, lease.account_id]);
      const offers = [];
      for (const s of sessions) {
        const { rows: spawns } = await t.query(
          `SELECT * FROM commands WHERE session_id = $1 AND kind = 'spawn_session' AND state IN ('queued','delivered') ORDER BY seq`,
          [s.id]);
        for (const c of spawns) {
          const deliveryId = await offerCommand(t, lease, c);
          offers.push({
            deliveryId, commandId: c.id, sessionId: s.id, kind: 'spawn_session',
            seq: String(c.seq), ciphertext: c.ciphertext,
            clientIntentId: c.client_intent_id, requestHash: c.request_hash,
            createDir: s.spawn_create_dir === true,
          });
        }
        if (!s.local_session_id) continue; // prompts only after binding
        const executing = await one(
          t, `SELECT id FROM turns WHERE session_id = $1 AND state IN ('dispatching','running','cancelling','orphaned') LIMIT 1`, [s.id]);
        if (executing) continue;
        const head = await one(
          t,
          `SELECT c.*, tu.id AS head_turn_id FROM turns tu JOIN commands c ON c.id = tu.prompt_command_id
           WHERE tu.session_id = $1 AND tu.state = 'queued' ORDER BY tu.request_seq LIMIT 1`,
          [s.id]);
        if (!head) continue;
        const deliveryId = await offerCommand(t, lease, head);
        // Carry the cited attachment ids so the daemon can fetch device-born
        // content — without this the reference is invisible past the relay.
        const { rows: atts } = await t.query(
          `SELECT id, size FROM attachments WHERE referenced_by = $1 ORDER BY created_at`, [head.id]);
        offers.push({
          deliveryId, commandId: head.id, sessionId: s.id, kind: 'prompt',
          seq: String(head.seq), turnId: head.head_turn_id, ciphertext: head.ciphertext,
          clientIntentId: head.client_intent_id, requestHash: head.request_hash,
          attachments: atts.map((a) => ({ id: a.id, size: a.size })),
        });
      }
      return { epoch: String(lease.epoch), offers };
    });
  }

  /** Control lane: pending cancel commands (priority, small). */
  async function claimControl(leaseId, tokenHash) {
    return db.tx(async (t) => {
      const lease = await fencedLease(t, leaseId, tokenHash);
      const { rows } = await t.query(
        `SELECT c.* FROM commands c JOIN native_sessions s ON s.id = c.session_id
         WHERE s.owner_daemon_id = $1 AND s.account_id = $2 AND c.kind = 'cancel' AND c.state IN ('queued','delivered')
           AND EXISTS (SELECT 1 FROM turns tu WHERE tu.id = c.target_turn_id AND tu.state <> 'terminal')
         ORDER BY c.seq`, [lease.daemon_id, lease.account_id]);
      const offers = [];
      for (const c of rows) {
        const deliveryId = await offerCommand(t, lease, c);
        offers.push({
          deliveryId, commandId: c.id, sessionId: c.session_id, kind: 'cancel',
          seq: String(c.seq), targetTurnId: c.target_turn_id, scope: c.scope,
        });
      }
      return { epoch: String(lease.epoch), offers };
    });
  }

  async function deliveryReceived(deliveryId, leaseRef) {
    await db.tx(async (t) => {
      const lease = await fencedLease(t, leaseRef.id, leaseRef.token_hash, leaseRef.epoch);
      const d = await one(t, `SELECT * FROM deliveries WHERE id = $1 AND daemon_id = $2`, [deliveryId, lease.daemon_id]);
      if (!d) throw new ApiError(404, 'delivery_not_found');
      if (String(d.lease_epoch) !== String(lease.epoch)) throw new ApiError(412, 'lease_epoch_stale');
      // Superseded by an edit (or a spawn retry): the daemon is holding a
      // payload that is no longer the message. Refuse, so it re-claims (#57).
      if (d.disposition) throw new ApiError(409, 'delivery_superseded');
      await t.query(`UPDATE deliveries SET received_at = now() WHERE id = $1`, [deliveryId]);
      await t.query(`UPDATE commands SET state = 'delivered' WHERE id = $1 AND state = 'queued'`, [d.command_id]);
    });
  }

  // ── Turn facts (§3) ───────────────────────────────────────────────────────

  /** A daemon may only submit/start a turn it holds a CURRENT-epoch delivery
   *  for — a fencing link between the claim and the lifecycle write. */
  async function requireCurrentDelivery(t, turn, lease) {
    const d = await one(
      t,
      `SELECT id FROM deliveries WHERE command_id = $1 AND lease_epoch = $2 AND disposition IS NULL LIMIT 1`,
      [turn.prompt_command_id, lease.epoch]);
    if (!d) throw new ApiError(409, 'no_current_delivery');
  }

  async function turnSubmitted(turnId, leaseRef) {
    await withTurn(turnId, leaseRef, async (t, s, turn, lease) => {
      if (turn.state === 'terminal') throw new ApiError(409, 'turn_terminal');
      await requireCurrentDelivery(t, turn, lease);
      if (turn.state === 'queued') {
        await t.query(`UPDATE turns SET state = 'dispatching', lease_epoch = $2 WHERE id = $1`, [turnId, lease.epoch]);
      }
      await t.query(
        `UPDATE deliveries SET submitted_at = now() WHERE command_id = $1 AND lease_epoch = $2 AND submitted_at IS NULL`,
        [turn.prompt_command_id, lease.epoch]);
    });
  }

  /** turn.start CAS: refuse after cancellation, double-start, stale epoch,
   *  missing delivery, or when an EARLIER nonterminal turn exists (queue-head
   *  discipline). */
  async function turnStarted(turnId, leaseRef, body) {
    return withTurn(turnId, leaseRef, async (t, s, turn, lease) => {
      if (turn.state === 'terminal') throw new ApiError(409, turn.terminal_state === 'cancelled' ? 'turn_cancelled' : 'turn_terminal');
      if (turn.cancel_requested) throw new ApiError(409, 'turn_cancelled');
      if (turn.state === 'running') return { turnId, state: 'running', replay: true };
      if (turn.state === 'orphaned') throw new ApiError(409, 'turn_orphaned_reconcile_first');
      if (s.active_turn_id && s.active_turn_id !== turnId) throw new ApiError(409, 'another_turn_active');
      await requireCurrentDelivery(t, turn, lease);
      const earlier = await one(
        t, `SELECT id FROM turns WHERE session_id = $1 AND request_seq < $2 AND state <> 'terminal' LIMIT 1`,
        [s.id, turn.request_seq]);
      if (earlier) throw new ApiError(409, 'not_queue_head');
      const runToken = body.runToken ?? randomUUID();
      await t.query(
        `UPDATE turns SET state = 'running', lease_epoch = $2, run_token = $3, started_at = now(), last_progress_at = now() WHERE id = $1`,
        [turnId, lease.epoch, runToken]);
      await t.query(`UPDATE native_sessions SET active_turn_id = $2, state = 'active', updated_at = now() WHERE id = $1`, [s.id, turnId]);
      await t.query(`UPDATE commands SET state = 'applied', disposition = 'started' WHERE id = $1`, [turn.prompt_command_id]);
      const { seq } = await nextSeq(t, s.id);
      await appendEvent(t, s.id, seq, { kind: 'turn.started', turnId, runtimeEventId: body.runtimeEventId ?? null });
      return { turnId, state: 'running', runToken };
    });
  }

  async function turnFact(turnId, leaseRef, body) {
    return withTurn(turnId, leaseRef, async (t, s, turn, lease) => {
      // Centralized runtime-fact idempotency: an exact retry of ANY fact kind
      // that carries a runtimeEventId replays instead of erroring.
      if (body.runtimeEventId) {
        const dupe = await one(t, `SELECT seq FROM session_events WHERE session_id = $1 AND runtime_event_id = $2`,
          [s.id, body.runtimeEventId]);
        if (dupe) return { ok: true, seq: String(dupe.seq), replay: true };
      }
      if (turn.state === 'terminal' && body.type !== 'output') {
        if (body.type === 'terminal') return { ok: true, replay: true };
        throw new ApiError(409, 'turn_terminal');
      }
      switch (body.type) {
        case 'receipt': {
          await t.query(`UPDATE turns SET transcript_uuid = $2, last_progress_at = now() WHERE id = $1`, [turnId, body.transcriptUuid]);
          await t.query(`UPDATE deliveries SET receipted_at = now() WHERE command_id = $1 AND lease_epoch = $2 AND receipted_at IS NULL`,
            [turn.prompt_command_id, lease.epoch]);
          const { seq } = await nextSeq(t, s.id);
          await appendEvent(t, s.id, seq, { kind: 'turn.receipted', turnId, runtimeEventId: body.runtimeEventId ?? null });
          return { ok: true, seq };
        }
        case 'output': {
          if ((body.ciphertext?.length ?? 0) > MAX_CIPHERTEXT) throw new ApiError(413, 'ciphertext_too_large');
          const { rows: [{ n }] } = await t.query(
            `SELECT count(*)::int AS n FROM session_events WHERE session_id = $1`, [s.id]);
          if (n >= MAX_EVENTS_PER_SESSION) throw new ApiError(429, 'session_event_budget_exhausted');
          await t.query(`UPDATE turns SET last_progress_at = now() WHERE id = $1`, [turnId]);
          const { seq } = await nextSeq(t, s.id);
          await appendEvent(t, s.id, seq, {
            kind: body.kind ?? 'output', turnId, runtimeEventId: body.runtimeEventId ?? null, ciphertext: body.ciphertext,
          });
          return { ok: true, seq };
        }
        case 'terminal': {
          const terminalState = body.terminalState; // completed | failed | cancelled | interrupted
          if (!['completed', 'failed', 'cancelled', 'interrupted'].includes(terminalState)) {
            throw new ApiError(400, 'bad_terminal_state');
          }
          const seq = await terminalizeTurn(t, s, turn, terminalState, body.meta, body.runtimeEventId, body.ciphertext);
          return { ok: true, seq };
        }
        default:
          throw new ApiError(400, 'bad_fact_type');
      }
    });
  }

  /** Output the daemon produced OUTSIDE any relay turn (a prompt typed at
   *  the terminal, an agent finishing after the lane's turn closed). Same
   *  fence, budget and replay rules as a turn output fact; turnId is null. */
  async function sessionFact(sessionId, leaseRef, body) {
    if (body.type !== 'output') throw new ApiError(400, 'bad_fact_type');
    if ((body.ciphertext?.length ?? 0) > MAX_CIPHERTEXT) throw new ApiError(413, 'ciphertext_too_large');
    const out = await db.tx(async (t) => {
      const lease = await fencedLease(t, leaseRef.id, leaseRef.token_hash, leaseRef.epoch);
      const s = await loadSession(t, sessionId, null);
      if (s.owner_daemon_id !== lease.daemon_id || s.account_id !== lease.account_id) throw new ApiError(403, 'not_owner_daemon');
      if (body.runtimeEventId) {
        const dupe = await one(t, `SELECT seq FROM session_events WHERE session_id = $1 AND runtime_event_id = $2`,
          [s.id, body.runtimeEventId]);
        if (dupe) return { ok: true, seq: String(dupe.seq), replay: true, accountId: s.account_id };
      }
      const { rows: [{ n }] } = await t.query(`SELECT count(*)::int AS n FROM session_events WHERE session_id = $1`, [s.id]);
      if (n >= MAX_EVENTS_PER_SESSION) throw new ApiError(429, 'session_event_budget_exhausted');
      const { seq } = await nextSeq(t, s.id);
      await appendEvent(t, s.id, seq, { kind: body.kind ?? 'output', turnId: null, runtimeEventId: body.runtimeEventId ?? null, ciphertext: body.ciphertext });
      return { ok: true, seq, accountId: s.account_id };
    });
    notify.pokeAccount(out.accountId, sessionId, ['events']);
    const { accountId: _a, ...rest } = out;
    return rest;
  }

  /** Post-restart resolution — ONLY for orphaned turns (the sweep or a fence
   *  violation put them there). `running` re-fences to the new epoch;
   *  `terminal` goes through the shared terminalization (cancel commands
   *  resolve, slot clears). */
  async function reconcileTurn(turnId, leaseRef, body) {
    return withTurn(turnId, leaseRef, async (t, s, turn, lease) => {
      if (turn.state === 'terminal') return { turnId, state: 'terminal', terminalState: turn.terminal_state, replay: true };
      // The OWNER daemon (same lease epoch) may also resolve a turn that is
      // still dispatching/running/cancelling: it is telling us it has no
      // worker for it any more — a terminal that never landed, a loop that
      // died — and nothing else can release the execution slot while its
      // renewals keep the lease alive (#74). Anyone else needs it orphaned.
      const ownerLive = String(turn.lease_epoch) === String(lease.epoch) && ['dispatching', 'running', 'cancelling'].includes(turn.state);
      if (turn.state !== 'orphaned' && !(ownerLive && body.resolution === 'terminal')) throw new ApiError(409, 'turn_not_orphaned');
      if (body.resolution === 'running') {
        if (s.active_turn_id && s.active_turn_id !== turnId) throw new ApiError(409, 'another_turn_active');
        await t.query(`UPDATE turns SET state = $2, lease_epoch = $3, last_progress_at = now() WHERE id = $1`,
          [turnId, turn.cancel_requested ? 'cancelling' : 'running', lease.epoch]);
        await t.query(`UPDATE native_sessions SET active_turn_id = $2, recovery_required = FALSE, updated_at = now() WHERE id = $1`,
          [s.id, turnId]);
        return { turnId, state: turn.cancel_requested ? 'cancelling' : 'running' };
      }
      if (body.resolution === 'terminal') {
        const terminalState = body.terminalState ?? 'interrupted';
        if (!['completed', 'failed', 'cancelled', 'interrupted'].includes(terminalState)) {
          throw new ApiError(400, 'bad_terminal_state');
        }
        await terminalizeTurn(t, s, turn, terminalState, { ...body.meta, reconciled: true });
        await t.query(`UPDATE native_sessions SET recovery_required = FALSE, updated_at = now() WHERE id = $1`, [s.id]);
        return { turnId, state: 'terminal', terminalState };
      }
      throw new ApiError(400, 'bad_resolution');
    });
  }

  /** Shared fenced-turn transaction wrapper: fences the lease INSIDE the tx,
   *  loads turn + session, verifies daemon ownership, pokes after commit. */
  async function withTurn(turnId, leaseRef, fn) {
    let poke = null;
    const out = await db.tx(async (t) => {
      const lease = await fencedLease(t, leaseRef.id, leaseRef.token_hash, leaseRef.epoch);
      const turn = await one(t, `SELECT * FROM turns WHERE id = $1`, [turnId]);
      if (!turn) throw new ApiError(404, 'turn_not_found');
      const s = await loadSession(t, turn.session_id, null);
      if (s.owner_daemon_id !== lease.daemon_id || s.account_id !== lease.account_id) throw new ApiError(403, 'not_owner_daemon');
      const r = await fn(t, s, turn, lease);
      poke = [s.account_id, s.id];
      return r;
    });
    if (poke) notify.pokeAccount(poke[0], poke[1], ['events', 'state']);
    return out;
  }

  // ── Reads ─────────────────────────────────────────────────────────────────

  async function listSessions(accountId) {
    const { rows } = await db.query(
      `SELECT s.*,
         (SELECT count(*)::int FROM turns t WHERE t.session_id = s.id AND t.state = 'queued') AS queued_turns,
         EXISTS (SELECT 1 FROM daemon_leases l WHERE l.daemon_id = s.owner_daemon_id
                   AND l.released_at IS NULL AND l.expires_at > now()) AS online,
         (SELECT tu.state FROM turns tu WHERE tu.session_id = s.id
            AND tu.state IN ('dispatching','running','cancelling')
          ORDER BY tu.request_seq LIMIT 1) AS executing_state,
         (SELECT max(GREATEST(tu.created_at, COALESCE(tu.terminal_at, tu.created_at))) FROM turns tu WHERE tu.session_id = s.id) AS last_turn_at
       FROM native_sessions s WHERE s.account_id = $1 ORDER BY s.created_at`, [accountId]);
    return rows.map((s) => ({
      sessionId: s.id, daemonId: s.owner_daemon_id, localSessionId: s.local_session_id,
      state: s.state, revision: String(s.revision), headSeq: String(Number(s.next_seq) - 1),
      sessionKeyEnvelope: s.session_key_envelope, encryptedMetadata: s.encrypted_metadata,
      queuedTurns: s.queued_turns,
      // presence + activity, from the ONE authority the queue itself trusts
      online: !!s.online,
      executing: s.executing_state ?? null,
      updatedAt: new Date(s.updated_at).getTime(),
      createdAt: new Date(s.created_at).getTime(),
      lastTurnAt: s.last_turn_at ? new Date(s.last_turn_at).getTime() : null,
    }));
  }

  /** Snapshot-consistent projection: one transaction, and the delivery stage
   *  is visible (accepted vs delivered vs dispatching vs running). */
  async function sessionState(accountId, sessionId) {
    return db.tx(async (t) => {
      const s = await one(t, `SELECT * FROM native_sessions WHERE id = $1 AND account_id = $2`, [sessionId, accountId]);
      if (!s) throw new ApiError(404, 'session_not_found');
      const lease = await one(
        t, `SELECT *, (expires_at < now()) AS is_expired FROM daemon_leases WHERE daemon_id = $1 AND released_at IS NULL`,
        [s.owner_daemon_id]);
      const online = !!lease && !lease.is_expired;
      const active = await one(
        t,
        `SELECT * FROM turns WHERE session_id = $1 AND state IN ('dispatching','running','cancelling','orphaned')
         ORDER BY request_seq LIMIT 1`, [sessionId]);
      const { rows: [{ queued }] } = await t.query(
        `SELECT count(*)::int AS queued FROM turns WHERE session_id = $1 AND state = 'queued'`, [sessionId]);
      const { rows: [{ delivered }] } = await t.query(
        `SELECT count(DISTINCT tu.id)::int AS delivered FROM turns tu
           JOIN deliveries d ON d.command_id = tu.prompt_command_id AND d.received_at IS NOT NULL AND d.disposition IS NULL
         WHERE tu.session_id = $1 AND tu.state = 'queued'`, [sessionId]);

      let execution = 'idle';
      if (active) {
        if (active.state === 'orphaned' || !online) execution = 'orphaned';
        else if (active.state === 'cancelling') execution = 'cancelling';
        else if (active.state === 'dispatching') execution = 'dispatching';
        else execution = 'running';
      }
      const lastProgress = active?.last_progress_at ? new Date(active.last_progress_at).getTime() : null;
      return {
        sessionId, revision: String(s.revision), headSeq: String(Number(s.next_seq) - 1),
        sessionState: s.state, recoveryRequired: s.recovery_required,
        spawnFailure: s.spawn_failure ?? null,
        daemon: {
          daemonId: s.owner_daemon_id, status: online ? 'online' : 'offline',
          lastSeenAt: lease ? lease.renewed_at : null,
          leaseExpiresAt: lease ? lease.expires_at : null,
          epoch: lease ? String(lease.epoch) : null,
        },
        queue: { queuedTurns: queued, deliveredTurns: delivered },
        execution: {
          state: execution,
          turnId: active ? active.id : null,
          lastProgressAt: active?.last_progress_at ?? null,
          suspectedStalled: execution === 'running' && lastProgress != null && Date.now() - lastProgress > 120_000,
          cancelRequested: !!active?.cancel_requested,
        },
      };
    });
  }

  /** Forward page (`after`) or, with `before`, the NEWEST events below that
   *  seq — one request per backward page instead of walking the whole log
   *  from 0 (app issue #4). Both return ascending seq. */
  async function sessionEvents(accountId, sessionId, afterSeq, limit, beforeSeq = null) {
    const s = (await db.query(`SELECT id FROM native_sessions WHERE id = $1 AND account_id = $2`, [sessionId, accountId])).rows[0];
    if (!s) throw new ApiError(404, 'session_not_found');
    const lim = Math.min(Number(limit ?? 200), 500);
    let rows;
    if (beforeSeq !== null && beforeSeq !== undefined) {
      ({ rows } = await db.query(
        `SELECT * FROM session_events WHERE session_id = $1 AND seq < $2 ORDER BY seq DESC LIMIT $3`,
        [sessionId, String(beforeSeq), lim + 1]));
      rows = rows.slice(0, lim).reverse().concat(rows.length > lim ? [rows[lim]] : []); // oldest-first page + the overflow marker
      const page = rows.slice(0, Math.min(rows.length, lim));
      return { messages: page.map(rowToEvent), hasMore: rows.length > lim };
    }
    ({ rows } = await db.query(
      `SELECT * FROM session_events WHERE session_id = $1 AND seq > $2 ORDER BY seq LIMIT $3`,
      [sessionId, String(afterSeq ?? 0), lim + 1]));
    const page = rows.slice(0, lim);
    return { messages: page.map(rowToEvent), hasMore: rows.length > lim };
  }
  function rowToEvent(e) {
    return {
      id: e.event_id, seq: String(e.seq), kind: e.kind,
      turnId: e.turn_id, commandId: e.command_id,
      origin: e.origin_client_intent_id
        ? { actorId: e.origin_actor_id, clientIntentId: e.origin_client_intent_id, requestHash: e.origin_request_hash }
        : null,
      content: e.ciphertext ? { ciphertext: e.ciphertext } : null,
      createdAt: new Date(e.created_at).getTime(),
    };
  }

  /** Worker sweep, directly over TURNS (not just active_turn_id): any
   *  execution-bearing turn whose daemon lease is gone, expired, or from an
   *  older epoch becomes orphaned until reconciled. Covers the crash-after-
   *  submit window (dispatching, never started). */
  async function sweepExpiredLeases() {
    const flagged = await db.tx(async (t) => {
      const { rows } = await t.query(
        `SELECT tu.id AS turn_id, s.id AS session_id, s.account_id FROM turns tu
           JOIN native_sessions s ON s.id = tu.session_id
           LEFT JOIN daemon_leases l ON l.daemon_id = s.owner_daemon_id AND l.released_at IS NULL
         WHERE tu.state IN ('dispatching','running','cancelling')
           AND (l.id IS NULL OR l.expires_at < now() OR tu.lease_epoch IS NULL OR tu.lease_epoch < l.epoch)`);
      for (const r of rows) {
        await t.query(`UPDATE turns SET state = 'orphaned' WHERE id = $1`, [r.turn_id]);
        await t.query(`UPDATE native_sessions SET recovery_required = TRUE, revision = revision + 1, updated_at = now() WHERE id = $1`,
          [r.session_id]);
      }
      return rows;
    });
    for (const r of flagged) notify.pokeAccount(r.account_id, r.session_id, ['state']);
    return flagged.length;
  }

  return {
    createSession, bindSession, acceptPrompt, acceptCancellation,
    acquireLease, renewLease, claimWork, claimControl, deliveryReceived,
    turnSubmitted, turnStarted, turnFact, sessionFact, reconcileTurn,
    listSessions, sessionState, sessionEvents, sweepExpiredLeases,
    fencedLease, hashToken, assertDaemonOwned, updateSessionCard,
    spawnFailed, retrySpawn,
  };
}
