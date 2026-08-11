// The session coordinator: every native mutation is one serialized
// transaction that (1) validates against current state, (2) allocates the
// next session seq, (3) mutates relational state, (4) appends the canonical
// session_events row, and (5) collects wake-ups to fire AFTER commit.
// The relay never sees plaintext: `ciphertext` is opaque; visible fields
// exist only for routing, fencing, and reconciliation.
import { createHash, randomUUID } from 'node:crypto';

export const MAX_CIPHERTEXT = 256 * 1024;   // bytes of base64 payload accepted inline
export const MAX_QUEUED_TURNS = 100;

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
async function nextSeq(t, sessionId) {
  const row = await one(
    t,
    `UPDATE native_sessions SET next_seq = next_seq + 1, revision = revision + 1, updated_at = now()
     WHERE id = $1 RETURNING next_seq - 1 AS seq, revision`,
    [sessionId],
  );
  return { seq: String(row.seq), revision: String(row.revision) };
}

async function appendEvent(t, sessionId, seq, fields) {
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

  /** Fenced daemon context: lease must be current, unexpired, and match the
   *  presented epoch. Every daemon-side write goes through this. */
  async function fencedLease(t, leaseId, tokenHash, epoch) {
    const lease = await one(
      t,
      `SELECT * FROM daemon_leases WHERE id = $1 AND released_at IS NULL AND token_hash = $2`,
      [leaseId, tokenHash],
    );
    if (!lease) throw new ApiError(401, 'lease_unknown');
    if (epoch !== undefined && String(lease.epoch) !== String(epoch)) throw new ApiError(412, 'lease_epoch_stale');
    if (new Date(lease.expires_at).getTime() < Date.now()) throw new ApiError(412, 'lease_expired');
    return lease;
  }

  // ── Sessions ──────────────────────────────────────────────────────────────

  /** Both creation modes (§9): app spawn (provisioning + spawn command) and
   *  daemon announce_existing (starting, no spawn command). */
  async function createSession(accountId, actorId, body) {
    const mode = body.mode ?? 'spawn';
    const hash = requestHash({ mode, creationIntentId: body.creationIntentId, daemonId: body.daemonId, spec: body.spawnSpec ?? body.localSessionId });
    let wake = null;
    const result = await db.tx(async (t) => {
      const prior = await one(
        t,
        `SELECT * FROM native_sessions WHERE account_id = $1 AND creator_actor_id = $2 AND creation_intent_id = $3`,
        [accountId, actorId, body.creationIntentId],
      );
      if (prior) {
        return { sessionId: prior.id, state: prior.state, replay: true };
      }
      const sessionId = randomUUID();
      const state = mode === 'announce_existing' ? 'starting' : 'provisioning';
      await t.query(
        `INSERT INTO native_sessions (id, account_id, owner_daemon_id, local_session_id, creation_intent_id,
           creator_actor_id, state, session_key_envelope, encrypted_metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [sessionId, accountId, body.daemonId, mode === 'announce_existing' ? body.localSessionId : null,
         body.creationIntentId, actorId, state, body.sessionKeyEnvelope ?? null, body.encryptedMetadata ?? null],
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

  /** Daemon binds a spawned session to its local runtime (fenced). */
  async function bindSession(sessionId, lease, body) {
    const accountId = await db.tx(async (t) => {
      const s = await loadSession(t, sessionId, null);
      if (s.owner_daemon_id !== lease.daemon_id) throw new ApiError(403, 'not_owner_daemon');
      if (s.state !== 'provisioning' && s.state !== 'failed') {
        if (s.local_session_id === body.localSessionId) return s.account_id; // idempotent re-bind
        throw new ApiError(409, 'already_bound');
      }
      await t.query(
        `UPDATE native_sessions SET local_session_id = $2, session_key_envelope = $3,
           encrypted_metadata = COALESCE($4, encrypted_metadata), state = 'starting', updated_at = now()
         WHERE id = $1`,
        [sessionId, body.localSessionId, body.sessionKeyEnvelope, body.encryptedMetadata ?? null],
      );
      if (body.spawnCommandId) {
        await t.query(`UPDATE commands SET state = 'applied', disposition = 'applied' WHERE id = $1 AND session_id = $2`,
          [body.spawnCommandId, sessionId]);
      }
      const { seq } = await nextSeq(t, sessionId);
      await appendEvent(t, sessionId, seq, { kind: 'session.started', commandId: body.spawnCommandId ?? null });
      return s.account_id;
    });
    notify.pokeAccount(accountId, sessionId, ['state', 'events']);
  }

  // ── Prompt acceptance ─────────────────────────────────────────────────────

  async function acceptPrompt(accountId, actorId, sessionId, body) {
    if ((body.ciphertext?.length ?? 0) > MAX_CIPHERTEXT) throw new ApiError(413, 'ciphertext_too_large');
    const hash = requestHash({ kind: 'prompt', clientIntentId: body.clientIntentId, ciphertext: body.ciphertext });
    let daemonId = null;
    const accepted = await db.tx(async (t) => {
      const s = await loadSession(t, sessionId, accountId);
      const replay = await findExistingIntent(t, sessionId, actorId, body.clientIntentId, hash);
      if (replay) return replay;
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
      return {
        clientIntentId: body.clientIntentId, requestHash: hash, commandId, eventId,
        seq, turnId, disposition: 'queued',
      };
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
      } else if (target.state === 'queued' || target.state === 'dispatching') {
        // Cancel-before-start is airtight: mark the turn terminal(cancelled)
        // NOW; a late turn.start CAS will refuse it; delivery is suppressed.
        await terminalizeTurn(t, s, target, 'cancelled', { mode: 'before_start' }, seq);
        await t.query(`UPDATE commands SET state = 'cancelled', disposition = 'cancelled_before_start' WHERE id = $1`,
          [target.prompt_command_id]);
        disposition = 'cancelled_before_start';
        commandState = 'applied';
      } else {
        // running / cancelling — durable cancel command on the control lane.
        await t.query(
          `UPDATE turns SET state = 'cancelling', cancel_requested = TRUE, cancel_seq = $2 WHERE id = $1`,
          [targetTurnId, seq]);
        disposition = 'cancellation_requested';
        wakeControl = s.owner_daemon_id;
      }

      // Barrier: drain every queued turn with request_seq < C.
      if (scope === 'turn_and_pending_before_barrier') {
        const { rows: queued } = await t.query(
          `SELECT * FROM turns WHERE session_id = $1 AND state IN ('queued','dispatching') AND request_seq < $2 AND id <> $3`,
          [sessionId, seq, targetTurnId]);
        for (const q of queued) {
          await terminalizeTurn(t, s, q, 'cancelled', { mode: 'barrier' }, seq);
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

  /** Shared terminalization: turn → terminal, event appended, active turn
   *  cleared. Caller supplies the seq context that triggered it. */
  async function terminalizeTurn(t, session, turn, terminalState, meta, causeSeq) {
    await t.query(
      `UPDATE turns SET state = 'terminal', terminal_state = $2, terminal_meta = $3, terminal_at = now() WHERE id = $1`,
      [turn.id, terminalState, JSON.stringify(meta ?? {})]);
    if (session.active_turn_id === turn.id) {
      await t.query(`UPDATE native_sessions SET active_turn_id = NULL, updated_at = now() WHERE id = $1`, [session.id]);
    }
    const { seq } = await nextSeq(t, session.id);
    await appendEvent(t, session.id, seq, {
      kind: 'turn.terminal', turnId: turn.id,
      runtimeEventId: null,
      ciphertext: null,
    });
    return seq;
  }

  // ── Daemon leases ─────────────────────────────────────────────────────────

  async function acquireLease(accountId, daemonId, body) {
    const token = randomUUID() + randomUUID();
    const lease = await db.tx(async (t) => {
      const prior = await one(t, `SELECT * FROM daemon_leases WHERE daemon_id = $1 AND released_at IS NULL`, [daemonId]);
      if (prior && prior.account_id !== accountId) throw new ApiError(403, 'daemon_owned_by_other_account');
      const epoch = prior ? Number(prior.epoch) + 1 : 1;
      if (prior) {
        await t.query(`UPDATE daemon_leases SET released_at = now() WHERE id = $1`, [prior.id]);
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

  /** One eligible prompt per session: head of queue, only when nothing is
   *  executing. Returns offered deliveries (and marks them). */
  async function claimWork(leaseId, tokenHash) {
    let accountPokes = [];
    const out = await db.tx(async (t) => {
      const lease = await fencedLease(t, leaseId, tokenHash);
      const { rows: sessions } = await t.query(
        `SELECT * FROM native_sessions WHERE owner_daemon_id = $1 AND state NOT IN ('failed','archived')`,
        [lease.daemon_id]);
      const offers = [];
      for (const s of sessions) {
        // spawn commands are always deliverable
        const { rows: spawns } = await t.query(
          `SELECT c.* FROM commands c WHERE c.session_id = $1 AND c.kind = 'spawn_session' AND c.state = 'queued'
             AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.command_id = c.id AND d.lease_epoch = $2 AND d.disposition IS NULL)
           ORDER BY c.seq`, [s.id, lease.epoch]);
        let candidates = spawns;
        const executing = await one(
          t, `SELECT id FROM turns WHERE session_id = $1 AND state IN ('dispatching','running','cancelling','orphaned') LIMIT 1`, [s.id]);
        if (!executing) {
          const head = await one(
            t,
            `SELECT c.* FROM commands c JOIN turns tu ON tu.prompt_command_id = c.id
             WHERE c.session_id = $1 AND c.kind = 'prompt' AND c.state = 'queued' AND tu.state = 'queued'
               AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.command_id = c.id AND d.lease_epoch = $2 AND d.disposition IS NULL)
             ORDER BY c.seq LIMIT 1`,
            [s.id, lease.epoch]);
          if (head) candidates = candidates.concat([head]);
        }
        for (const c of candidates) {
          const { rows: [{ n }] } = await t.query(
            `SELECT count(*)::int AS n FROM deliveries WHERE command_id = $1`, [c.id]);
          const deliveryId = randomUUID();
          await t.query(
            `INSERT INTO deliveries (id, command_id, daemon_id, lease_epoch, lane, attempt)
             VALUES ($1,$2,$3,$4,'work',$5)`,
            [deliveryId, c.id, lease.daemon_id, lease.epoch, n + 1]);
          offers.push({
            deliveryId, commandId: c.id, sessionId: c.session_id, kind: c.kind,
            seq: String(c.seq), turnId: c.turn_id, ciphertext: c.ciphertext,
            clientIntentId: c.client_intent_id, requestHash: c.request_hash,
          });
          accountPokes.push([s.account_id, s.id]);
        }
      }
      return { epoch: String(lease.epoch), offers };
    });
    for (const [a, sid] of accountPokes) notify.pokeAccount(a, sid, ['state']);
    return out;
  }

  /** Control lane: cancel commands for running turns (priority, small). */
  async function claimControl(leaseId, tokenHash) {
    return db.tx(async (t) => {
      const lease = await fencedLease(t, leaseId, tokenHash);
      const { rows } = await t.query(
        `SELECT c.* FROM commands c JOIN native_sessions s ON s.id = c.session_id
         WHERE s.owner_daemon_id = $1 AND c.kind = 'cancel' AND c.state = 'queued'
           AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.command_id = c.id AND d.lease_epoch = $2 AND d.disposition IS NULL)
         ORDER BY c.seq`, [lease.daemon_id, lease.epoch]);
      const offers = [];
      for (const c of rows) {
        const { rows: [{ n }] } = await t.query(`SELECT count(*)::int AS n FROM deliveries WHERE command_id = $1`, [c.id]);
        const deliveryId = randomUUID();
        await t.query(
          `INSERT INTO deliveries (id, command_id, daemon_id, lease_epoch, lane, attempt) VALUES ($1,$2,$3,$4,'control',$5)`,
          [deliveryId, c.id, lease.daemon_id, lease.epoch, n + 1]);
        offers.push({
          deliveryId, commandId: c.id, sessionId: c.session_id, kind: 'cancel',
          seq: String(c.seq), targetTurnId: c.target_turn_id, scope: c.scope,
        });
      }
      return { epoch: String(lease.epoch), offers };
    });
  }

  async function deliveryReceived(deliveryId, lease) {
    await db.tx(async (t) => {
      const d = await one(t, `SELECT * FROM deliveries WHERE id = $1 AND daemon_id = $2`, [deliveryId, lease.daemon_id]);
      if (!d) throw new ApiError(404, 'delivery_not_found');
      if (String(d.lease_epoch) !== String(lease.epoch)) throw new ApiError(412, 'lease_epoch_stale');
      await t.query(`UPDATE deliveries SET received_at = now() WHERE id = $1`, [deliveryId]);
      await t.query(`UPDATE commands SET state = 'delivered' WHERE id = $1 AND state = 'queued'`, [d.command_id]);
    });
  }

  // ── Turn facts (§3) ───────────────────────────────────────────────────────

  async function turnSubmitted(turnId, lease) {
    await withTurn(turnId, lease, async (t, s, turn) => {
      if (turn.state === 'queued') {
        await t.query(`UPDATE turns SET state = 'dispatching', lease_epoch = $2 WHERE id = $1`, [turnId, lease.epoch]);
      }
      await t.query(
        `UPDATE deliveries SET submitted_at = now() WHERE command_id = $1 AND lease_epoch = $2 AND submitted_at IS NULL`,
        [turn.prompt_command_id, lease.epoch]);
    });
  }

  /** turn.start CAS: refuse after cancellation, double-start, or stale epoch. */
  async function turnStarted(turnId, lease, body) {
    return withTurn(turnId, lease, async (t, s, turn) => {
      if (turn.state === 'terminal') throw new ApiError(409, turn.terminal_state === 'cancelled' ? 'turn_cancelled' : 'turn_terminal');
      if (turn.cancel_requested) throw new ApiError(409, 'turn_cancelled');
      if (turn.state === 'running') return { turnId, state: 'running', replay: true };
      if (s.active_turn_id && s.active_turn_id !== turnId) throw new ApiError(409, 'another_turn_active');
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

  async function turnFact(turnId, lease, body) {
    return withTurn(turnId, lease, async (t, s, turn) => {
      if (turn.state === 'terminal' && body.type !== 'output') throw new ApiError(409, 'turn_terminal');
      switch (body.type) {
        case 'receipt': {
          await t.query(`UPDATE turns SET transcript_uuid = $2, last_progress_at = now() WHERE id = $1`, [turnId, body.transcriptUuid]);
          await t.query(`UPDATE deliveries SET receipted_at = now() WHERE command_id = $1 AND lease_epoch = $2 AND receipted_at IS NULL`,
            [turn.prompt_command_id, lease.epoch]);
          const { seq } = await nextSeq(t, s.id);
          await appendEvent(t, s.id, seq, { kind: 'turn.receipted', turnId, runtimeEventId: body.runtimeEventId ?? null });
          return { ok: true };
        }
        case 'output': {
          // Durable JSONL-derived fact. runtimeEventId (transcript UUID) makes
          // replay after daemon restart collapse instead of duplicating.
          if ((body.ciphertext?.length ?? 0) > MAX_CIPHERTEXT) throw new ApiError(413, 'ciphertext_too_large');
          if (body.runtimeEventId) {
            const dupe = await one(t, `SELECT seq FROM session_events WHERE session_id = $1 AND runtime_event_id = $2`,
              [s.id, body.runtimeEventId]);
            if (dupe) return { ok: true, seq: String(dupe.seq), replay: true };
          }
          await t.query(`UPDATE turns SET last_progress_at = now() WHERE id = $1`, [turnId]);
          const { seq } = await nextSeq(t, s.id);
          await appendEvent(t, s.id, seq, {
            kind: body.kind ?? 'output', turnId, runtimeEventId: body.runtimeEventId ?? null, ciphertext: body.ciphertext,
          });
          return { ok: true, seq };
        }
        case 'terminal': {
          if (turn.state === 'terminal') return { ok: true, replay: true };
          const terminalState = body.terminalState; // completed | failed | cancelled | interrupted
          if (!['completed', 'failed', 'cancelled', 'interrupted'].includes(terminalState)) {
            throw new ApiError(400, 'bad_terminal_state');
          }
          await t.query(
            `UPDATE turns SET state = 'terminal', terminal_state = $2, terminal_meta = $3, terminal_at = now() WHERE id = $1`,
            [turnId, terminalState, JSON.stringify(body.meta ?? {})]);
          if (s.active_turn_id === turnId) {
            await t.query(`UPDATE native_sessions SET active_turn_id = NULL, updated_at = now() WHERE id = $1`, [s.id]);
          }
          // resolve the cancel command, if one is pending on this turn
          await t.query(
            `UPDATE commands SET state = 'applied', disposition = $2 WHERE session_id = $3 AND kind = 'cancel'
               AND target_turn_id = $1 AND state IN ('queued','delivered')`,
            [turnId, terminalState === 'cancelled' ? 'cancelled' : 'completed_before_cancel', s.id]);
          const { seq } = await nextSeq(t, s.id);
          await appendEvent(t, s.id, seq, {
            kind: 'turn.terminal', turnId, runtimeEventId: body.runtimeEventId ?? null, ciphertext: body.ciphertext ?? null,
          });
          return { ok: true, seq };
        }
        default:
          throw new ApiError(400, 'bad_fact_type');
      }
    });
  }

  /** Post-restart resolution of orphaned/ambiguous turns under a NEW lease. */
  async function reconcileTurn(turnId, lease, body) {
    return withTurn(turnId, lease, async (t, s, turn) => {
      if (turn.state === 'terminal') return { turnId, state: 'terminal', terminalState: turn.terminal_state };
      if (body.resolution === 'running') {
        await t.query(`UPDATE turns SET state = 'running', lease_epoch = $2, last_progress_at = now() WHERE id = $1`,
          [turnId, lease.epoch]);
        await t.query(`UPDATE native_sessions SET active_turn_id = $2, recovery_required = FALSE, updated_at = now() WHERE id = $1`,
          [s.id, turnId]);
        return { turnId, state: 'running' };
      }
      if (body.resolution === 'terminal') {
        await t.query(
          `UPDATE turns SET state = 'terminal', terminal_state = $2, terminal_meta = $3, lease_epoch = $4, terminal_at = now() WHERE id = $1`,
          [turnId, body.terminalState ?? 'interrupted', JSON.stringify(body.meta ?? {}), lease.epoch]);
        if (s.active_turn_id === turnId) {
          await t.query(`UPDATE native_sessions SET active_turn_id = NULL, updated_at = now() WHERE id = $1`, [s.id]);
        }
        await t.query(`UPDATE native_sessions SET recovery_required = FALSE, updated_at = now() WHERE id = $1`, [s.id]);
        const { seq } = await nextSeq(t, s.id);
        await appendEvent(t, s.id, seq, { kind: 'turn.terminal', turnId });
        return { turnId, state: 'terminal', terminalState: body.terminalState ?? 'interrupted' };
      }
      throw new ApiError(400, 'bad_resolution');
    });
  }

  /** Shared fenced-turn transaction wrapper: loads turn + session, fences the
   *  lease epoch, fires account pokes after commit. */
  async function withTurn(turnId, lease, fn) {
    let poke = null;
    const out = await db.tx(async (t) => {
      await fencedLease(t, lease.id, lease.token_hash, lease.epoch);
      const turn = await one(t, `SELECT * FROM turns WHERE id = $1`, [turnId]);
      if (!turn) throw new ApiError(404, 'turn_not_found');
      const s = await loadSession(t, turn.session_id, null);
      if (s.owner_daemon_id !== lease.daemon_id) throw new ApiError(403, 'not_owner_daemon');
      const r = await fn(t, s, turn);
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
         (SELECT count(*)::int FROM turns t WHERE t.session_id = s.id AND t.state IN ('queued','dispatching')) AS queued_turns
       FROM native_sessions s WHERE s.account_id = $1 ORDER BY s.created_at`, [accountId]);
    return rows.map((s) => ({
      sessionId: s.id, daemonId: s.owner_daemon_id, localSessionId: s.local_session_id,
      state: s.state, revision: String(s.revision), headSeq: String(Number(s.next_seq) - 1),
      sessionKeyEnvelope: s.session_key_envelope, encryptedMetadata: s.encrypted_metadata,
      queuedTurns: s.queued_turns,
    }));
  }

  async function sessionState(accountId, sessionId) {
    const s = (await db.query(`SELECT * FROM native_sessions WHERE id = $1 AND account_id = $2`, [sessionId, accountId])).rows[0];
    if (!s) throw new ApiError(404, 'session_not_found');
    const lease = (await db.query(
      `SELECT * FROM daemon_leases WHERE daemon_id = $1 AND released_at IS NULL`, [s.owner_daemon_id])).rows[0];
    const online = !!lease && new Date(lease.expires_at).getTime() > Date.now();
    const active = s.active_turn_id
      ? (await db.query(`SELECT * FROM turns WHERE id = $1`, [s.active_turn_id])).rows[0]
      : (await db.query(
          `SELECT * FROM turns WHERE session_id = $1 AND state IN ('running','cancelling','orphaned') ORDER BY request_seq DESC LIMIT 1`,
          [sessionId])).rows[0];
    const { rows: [{ queued }] } = await db.query(
      `SELECT count(*)::int AS queued FROM turns WHERE session_id = $1 AND state IN ('queued','dispatching')`, [sessionId]);

    let execution = 'idle';
    if (active && active.state !== 'terminal') {
      if (!online) execution = 'orphaned';
      else if (active.state === 'cancelling') execution = 'cancelling';
      else execution = 'running';
    }
    const lastProgress = active?.last_progress_at ? new Date(active.last_progress_at).getTime() : null;
    return {
      sessionId, revision: String(s.revision), headSeq: String(Number(s.next_seq) - 1),
      sessionState: s.state, recoveryRequired: s.recovery_required,
      daemon: {
        daemonId: s.owner_daemon_id, status: online ? 'online' : 'offline',
        lastSeenAt: lease ? lease.renewed_at : null,
        leaseExpiresAt: lease ? lease.expires_at : null,
        epoch: lease ? String(lease.epoch) : null,
      },
      queue: { queuedTurns: queued },
      execution: {
        state: execution,
        turnId: active && active.state !== 'terminal' ? active.id : null,
        lastProgressAt: active?.last_progress_at ?? null,
        suspectedStalled: execution === 'running' && lastProgress != null && Date.now() - lastProgress > 120_000,
        cancelRequested: !!active?.cancel_requested,
      },
    };
  }

  async function sessionEvents(accountId, sessionId, afterSeq, limit) {
    const s = (await db.query(`SELECT id FROM native_sessions WHERE id = $1 AND account_id = $2`, [sessionId, accountId])).rows[0];
    if (!s) throw new ApiError(404, 'session_not_found');
    const lim = Math.min(Number(limit ?? 200), 500);
    const { rows } = await db.query(
      `SELECT * FROM session_events WHERE session_id = $1 AND seq > $2 ORDER BY seq LIMIT $3`,
      [sessionId, String(afterSeq ?? 0), lim + 1]);
    const page = rows.slice(0, lim);
    return {
      messages: page.map((e) => ({
        id: e.event_id, seq: String(e.seq), kind: e.kind,
        turnId: e.turn_id, commandId: e.command_id,
        origin: e.origin_client_intent_id
          ? { actorId: e.origin_actor_id, clientIntentId: e.origin_client_intent_id, requestHash: e.origin_request_hash }
          : null,
        content: e.ciphertext ? { ciphertext: e.ciphertext } : null,
        createdAt: new Date(e.created_at).getTime(),
      })),
      hasMore: rows.length > lim,
    };
  }

  /** Worker sweep: a running turn is orphaned when its daemon's lease is
   *  gone, expired, OR from an older epoch (the process that ran it died and
   *  a new one holds the lease) — until reconcile re-fences or terminalizes. */
  async function sweepExpiredLeases() {
    const flagged = await db.tx(async (t) => {
      const { rows } = await t.query(
        `SELECT s.id AS session_id, s.account_id FROM native_sessions s
           JOIN turns tu ON tu.id = s.active_turn_id
           LEFT JOIN daemon_leases l ON l.daemon_id = s.owner_daemon_id AND l.released_at IS NULL
         WHERE tu.state IN ('running','cancelling')
           AND (l.id IS NULL OR l.expires_at < now() OR tu.lease_epoch < l.epoch)
           AND s.recovery_required = FALSE`);
      for (const r of rows) {
        await t.query(
          `UPDATE turns SET state = 'orphaned' WHERE id = (SELECT active_turn_id FROM native_sessions WHERE id = $1)`,
          [r.session_id]);
        await t.query(`UPDATE native_sessions SET recovery_required = TRUE, updated_at = now() WHERE id = $1`, [r.session_id]);
      }
      return rows;
    });
    for (const r of flagged) notify.pokeAccount(r.account_id, r.session_id, ['state']);
    return flagged.length;
  }

  return {
    createSession, bindSession, acceptPrompt, acceptCancellation,
    acquireLease, renewLease, claimWork, claimControl, deliveryReceived,
    turnSubmitted, turnStarted, turnFact, reconcileTurn,
    listSessions, sessionState, sessionEvents, sweepExpiredLeases,
    fencedLease, hashToken,
  };
}
