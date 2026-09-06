// /joy/v2 — the relay's only surface: accounts, pairing, machines, push, sessions, attachments, tunnel.
// v1 is untouched; both routers share core, db, notify and the same tunnel.
// The surface splits by caller: client routes at the root (account auth),
// daemon-process routes under /daemon (lease auth; acquire bootstraps on
// account auth). Tunnel entry is /machines/{machineId}/http — clients target
// a MACHINE; "daemon" names only the process.
//
// v2 vocabulary over v1 tables: a MESSAGE is a prompt command plus its turn.
//   command cancelled                                      → "cancelled"
//   command indeterminate | turn orphaned |
//     turn terminal(failed/interrupted)                    → "failed"
//   turn running | cancelling | terminal(completed)        → "delivered"
//   turn dispatching                                       → "delivering"
//   otherwise                                              → "queued"
// "orphaned" is the honest mayHaveDelivered case: the daemon died mid-flight
// and reconcile has not yet proven what happened.
import { randomUUID } from 'node:crypto';
import { ApiError, hashToken, nextSeq, appendEvent, messageStatusOf } from './core.mjs';

const CLAIM_WAIT_MS = 25_000;
const TUNNEL_REQUEST_MAX = 32 * 1024 * 1024;
const ATTACH_REQUEST_MAX = 32 * 1024 * 1024;

function readRaw(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new ApiError(413, 'body_too_large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
function readJson(req, limit = 512 * 1024) {
  return readRaw(req, limit).then((b) => {
    if (b.length === 0) return {};
    try { return JSON.parse(b.toString('utf8')); } catch { throw new ApiError(400, 'bad_json'); }
  });
}
/** The body size a client DECLARED (0 when absent/chunked) — lets admission
 *  and the size cap speak before a single body byte is buffered. */
function declaredLength(req) {
  const n = Number(req.headers['content-length']);
  return Number.isFinite(n) && n > 0 ? n : 0;
}
/** A client that left mid-body: Node surfaces it as an ECONNRESET 'aborted'
 *  error from the request stream. Not a relay fault — no 500, no stack trace
 *  (one was logged per abort, a free log-spam vector). */
const isClientAbort = (e, req) => !(e instanceof ApiError) && (e?.code === 'ECONNRESET' || e?.message === 'aborted' || req.destroyed === true);
const intent = (p) => `${p}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

// One mapping, shared with the core so the DELETE precondition it checks
// inside its transaction (#621) agrees with what clients read. Note the
// command-acked-while-turn-queued case reads "delivering": the payload is OUT
// of our hands, so the message is no longer editable.
const messageStatus = (cmdState, turnState, terminalState) =>
  messageStatusOf(cmdState, { state: turnState, terminal_state: terminalState });
function failureFor(status, turnState, cmdState) {
  if (status !== 'failed') return undefined;
  if (cmdState === 'rejected') return { reason: 'rejected by daemon', retryable: false, mayHaveDelivered: false };
  if (cmdState === 'indeterminate') return { reason: 'delivery outcome unknown', retryable: false, mayHaveDelivered: true };
  return {
    reason: turnState === 'orphaned' ? 'daemon lost mid-delivery' : 'turn failed',
    retryable: turnState === 'orphaned',
    mayHaveDelivered: turnState === 'orphaned',
  };
}
function rowToMessage(r) {
  const status = messageStatus(r.cmd_state, r.turn_state, r.terminal_state);
  return {
    id: r.id, ciphertext: r.ciphertext, status,
    failure: failureFor(status, r.turn_state, r.cmd_state),
    turnId: r.turn_id, seq: String(r.request_seq),
    createdAt: new Date(r.created_at).getTime(),
  };
}
const MSG_SELECT = `
  SELECT c.id, c.ciphertext, c.state AS cmd_state, c.turn_id, c.created_at,
         tu.state AS turn_state, tu.terminal_state, tu.request_seq, tu.cancel_requested
  FROM commands c JOIN turns tu ON tu.id = c.turn_id
  WHERE c.session_id = $1 AND c.kind = 'prompt'`;

export function createV2Router({ core, auth, notify, db, tunnel, attachments, accounts }) {
  const routes = [];
  const route = (method, pattern, opts, handler) =>
    routes.push({ method, pattern, regex: new RegExp(`^${pattern}$`), opts, handler });

  // ── meta ──────────────────────────────────────────────────────────────────
  route('GET', '/capabilities', { auth: false, summary: 'Relay flavor + protocol version (no auth); clients probe this before trusting a server URL' }, async () => ({
    relay: 'joy-relay',
    protocol: { major: 2, minor: 0 },
    features: ['accounts', 'pairing', 'machines', 'push', 'sessions', 'messages', 'turns', 'cancellations', 'attachments', 'events', 'sse', 'tunnel'],
  }));

  async function ownedSession(t, sessionId, accountId) {
    const { rows: [s] } = await t.query(`SELECT * FROM native_sessions WHERE id = $1`, [sessionId]);
    if (!s || s.account_id !== accountId) throw new ApiError(404, 'session_not_found');
    return s;
  }
  async function loadMessage(t, sessionId, messageId) {
    const { rows: [r] } = await t.query(`${MSG_SELECT} AND c.id = $2`, [sessionId, messageId]);
    if (!r) throw new ApiError(404, 'message_not_found');
    return r;
  }

  // ── client: sessions ──────────────────────────────────────────────────────
  route('GET', '/sessions', {}, async (ctx) => ({ sessions: await core.listSessions(ctx.accountId) }));
  route('POST', '/sessions', {}, async (ctx, m, body) => core.createSession(ctx.accountId, ctx.actorId, body));
  route('GET', '/sessions/([\\w-]+)', {}, async (ctx, m) => core.sessionState(ctx.accountId, m[1]));
  route('DELETE', '/sessions/([\\w-]+)', {}, async (ctx, m) => {
    await db.tx(async (t) => {
      await ownedSession(t, m[1], ctx.accountId);
      await attachments.purgeSession(t, m[1]);
      await t.query(`DELETE FROM deliveries WHERE command_id IN (SELECT id FROM commands WHERE session_id = $1)`, [m[1]]);
      await t.query(`DELETE FROM session_events WHERE session_id = $1`, [m[1]]);
      await t.query(`DELETE FROM turns WHERE session_id = $1`, [m[1]]);
      await t.query(`DELETE FROM commands WHERE session_id = $1`, [m[1]]);
      await t.query(`DELETE FROM native_sessions WHERE id = $1`, [m[1]]);
    });
    notify.pokeAccount(ctx.accountId, m[1], ['state']);
    return { ok: true };
  });
  route('GET', '/sessions/([\\w-]+)/events', {}, async (ctx, m, body, url) =>
    core.sessionEvents(ctx.accountId, m[1], url.searchParams.get('after'), url.searchParams.get('limit'), url.searchParams.get('before')));
  // Retry a spawn that FAILED (e.g. cwd missing), opting into directory
  // creation — the durable-queue analog of v1's 'Create directory?' approval.
  route('POST', '/sessions/([\\w-]+)/spawn/retry', {}, async (ctx, m, body) =>
    core.retrySpawn(ctx.accountId, ctx.actorId, m[1], body.createDir === true));

  // ── client: SSE doorbell (same stream contract as v1) ─────────────────────
  route('GET', '/events/stream', {}, async (ctx, m, body, url, req, res) => {
    const handle = notify.addSse(ctx.accountId, res);
    if (!handle) throw new ApiError(429, 'too_many_streams');
    // Cleanup is registered BEFORE the snapshot read (#619): a client that
    // disconnected while listSessions was pending used to arm a heartbeat
    // interval after its own close event, so nothing ever cleared it and the
    // closed response stayed referenced for the life of the process.
    let ping = null;
    let closed = false;
    res.on('close', () => { closed = true; if (ping) clearInterval(ping); });
    res.writeHead(200, {
      'content-type': 'text/event-stream', 'cache-control': 'no-cache',
      connection: 'keep-alive', 'x-accel-buffering': 'no',
    });
    const sessions = await core.listSessions(ctx.accountId);
    if (closed || res.destroyed || res.writableEnded) return null; // gone during the read: no greeting, no timer
    res.write(`event: hello\ndata: ${JSON.stringify({
      v: 2, sessions: sessions.map((s) => ({ sessionId: s.sessionId, headSeq: s.headSeq, revision: s.revision })),
    })}\n\n`);
    handle.markReady();
    ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* closed */ } }, 15_000);
    return null; // handler owns the response
  });

  // ── client: messages ──────────────────────────────────────────────────────
  route('GET', '/sessions/([\\w-]+)/messages', {}, async (ctx, m, body, url) => {
    const status = url.searchParams.get('status');
    const limit = Math.min(Number(url.searchParams.get('limit') ?? 100), 500);
    const rows = await db.tx(async (t) => {
      await ownedSession(t, m[1], ctx.accountId);
      // With a status filter the LIMIT must apply AFTER filtering, or a
      // page-sized prefix of non-matching rows hides real matches.
      const { rows } = status
        ? await t.query(`${MSG_SELECT} ORDER BY tu.request_seq`, [m[1]])
        : await t.query(`${MSG_SELECT} ORDER BY tu.request_seq LIMIT $2`, [m[1], limit]);
      return rows;
    });
    let messages = rows.map(rowToMessage);
    if (status) messages = messages.filter((x) => x.status === status).slice(0, limit);
    return { messages };
  });
  route('POST', '/sessions/([\\w-]+)/messages', {}, async (ctx, m, body) => {
    if (typeof body.ciphertext !== 'string') throw new ApiError(400, 'missing_ciphertext');
    // Bytes-first-reference-second: every cited attachment must exist for this
    // session BEFORE the message is accepted. Validation and the sweep-guard
    // mark happen in ONE transaction — the orphan sweep can never delete an
    // attachment between validation and the message landing.
    const clientIntentId = body.clientIntentId ?? intent('v2m');
    const ids = Array.isArray(body.attachments) ? body.attachments : [];
    const marker = `intent:${clientIntentId}`;
    // Reference + accept + claim commit together (see core.acceptPrompt):
    // a retry that replays skips both hooks, so a re-uploaded duplicate blob
    // simply stays unreferenced and ages out with the orphan sweep.
    const accepted = await core.acceptPrompt(ctx.accountId, ctx.actorId, m[1], {
      ciphertext: body.ciphertext, clientIntentId,
    }, ids.length === 0 ? {} : {
      beforeAccept: (t) => attachments.reference(t, m[1], marker, ids),
      afterAccept: (t, acc) => attachments.claim(t, ids, marker, acc.commandId),
    });
    return { status: 202, body: { messageId: accepted.commandId, turnId: accepted.turnId, seq: accepted.seq, disposition: accepted.disposition } };
  });
  route('GET', '/sessions/([\\w-]+)/messages/([\\w-]+)', {}, async (ctx, m) => {
    const r = await db.tx(async (t) => {
      await ownedSession(t, m[1], ctx.accountId);
      return loadMessage(t, m[1], m[2]);
    });
    return rowToMessage(r);
  });
  route('PATCH', '/sessions/([\\w-]+)/messages/([\\w-]+)', {}, async (ctx, m, body) => {
    const out = await db.tx(async (t) => {
      await ownedSession(t, m[1], ctx.accountId);
      const r = await loadMessage(t, m[1], m[2]);
      const status = messageStatus(r.cmd_state, r.turn_state, r.terminal_state);
      if (status !== 'queued') throw new ApiError(409, { error: 'not_editable', status });
      if (typeof body.ciphertext === 'string') {
        await t.query(`UPDATE commands SET ciphertext = $1 WHERE id = $2`, [body.ciphertext, m[2]]);
        // A delivery already handed to a daemon carries the OLD payload:
        // supersede it so /received refuses it and the next claim offers the
        // edit (issue #57 — the agent ran A while the chat showed B).
        await t.query(`UPDATE deliveries SET disposition = 'superseded' WHERE command_id = $1 AND disposition IS NULL`, [m[2]]);
        // Durable record of the edit: without it, a device replaying the
        // event log reconstructs the ORIGINAL text while GET shows the edit.
        const { seq } = await nextSeq(t, m[1]);
        await appendEvent(t, m[1], seq, {
          kind: 'message.edited', commandId: m[2], turnId: r.turn_id, ciphertext: body.ciphertext,
        });
      }
      if (body.position !== undefined) {
        // position is a ZERO-BASED INDEX among currently queued messages —
        // deliberately a different name and meaning than the durable `seq`
        // in reads, so the two cannot be confused round-trip.
        const to0 = Number(body.position);
        if (!Number.isInteger(to0) || to0 < 0) throw new ApiError(400, 'bad_position');
        // Reorder among this session's EDITABLE turns only — queued turns
        // whose command the daemon has not acknowledged — permuting their
        // existing request_seq values so the global sequence stays dense and
        // unique. An acknowledged head is already in the daemon's hands:
        // moving another message ahead of it let the head enter dispatching
        // behind the new front, where /start failed with not_queue_head and
        // the execution slot stayed occupied (#620). Acknowledged turns keep
        // their seq and stay ahead; the check is inside THIS transaction, so
        // an ack that lands first fixes the turn and one that lands after is
        // refused by the superseded delivery.
        const { rows: queued } = await t.query(
          `SELECT tu.id, tu.request_seq, c.id AS command_id FROM turns tu JOIN commands c ON c.id = tu.prompt_command_id
           WHERE tu.session_id = $1 AND tu.state = 'queued' AND c.state = 'queued' ORDER BY tu.request_seq`, [m[1]]);
        const from = queued.findIndex((q) => q.id === r.turn_id);
        const to = Math.min(queued.length - 1, to0);
        if (from >= 0 && from !== to) {
          const order = queued.map((q) => q.id);
          order.splice(to, 0, order.splice(from, 1)[0]);
          const seqs = queued.map((q) => q.request_seq);
          const commandOf = new Map(queued.map((q) => [q.id, q.command_id]));
          for (let i = 0; i < order.length; i++) {
            if (order[i] === queued[i].id) continue; // unmoved
            await t.query(`UPDATE turns SET request_seq = $1 WHERE id = $2`, [seqs[i], order[i]]);
            // An offered-but-unacknowledged delivery of a moved turn carries
            // a stale position: supersede it so /received refuses it and the
            // daemon re-claims the true head (same discipline as an edit).
            await t.query(`UPDATE deliveries SET disposition = 'superseded' WHERE command_id = $1 AND disposition IS NULL`,
              [commandOf.get(order[i])]);
          }
        }
      }
      return loadMessage(t, m[1], m[2]);
    });
    notify.pokeAccount(ctx.accountId, m[1], ['events', 'state']);
    return rowToMessage(out);
  });
  route('DELETE', '/sessions/([\\w-]+)/messages/([\\w-]+)', {}, async (ctx, m) => {
    // Delete = cancel while still queued. Delegated to the cancellation core
    // (terminalization, barrier bookkeeping, late-start CAS all shared). The
    // queued-only precondition is checked INSIDE the cancellation
    // transaction (#621): reading it here and cancelling in a second
    // transaction let the daemon ack, submit and start the turn in between,
    // and the "delete" interrupted a running agent.
    const r = await db.tx(async (t) => {
      await ownedSession(t, m[1], ctx.accountId);
      return loadMessage(t, m[1], m[2]);
    });
    const out = await core.acceptCancellation(ctx.accountId, ctx.actorId, m[1], r.turn_id,
      { clientIntentId: intent('v2d'), scope: 'turn' }, { requireQueued: true });
    return { ok: true, disposition: out.disposition };
  });
  route('POST', '/sessions/([\\w-]+)/messages/([\\w-]+)/retry', {}, async (ctx, m) => {
    // Only an ORPHANED turn is retryable: the human saw mayHaveDelivered and
    // authorized a re-attempt of the SAME message. Everything else is 409.
    let daemonId = null;
    const out = await db.tx(async (t) => {
      const s = await ownedSession(t, m[1], ctx.accountId);
      const r = await loadMessage(t, m[1], m[2]);
      // Lost-ack idempotency: a retry that already landed answers 202 again.
      if (r.turn_state === 'queued' && r.cmd_state === 'queued') {
        return { status: 202, body: { messageId: m[2], turnId: r.turn_id, replay: true } };
      }
      if (r.turn_state !== 'orphaned') throw new ApiError(409, 'not_retryable');
      // An orphan with a pending cancellation must not be requeued: the
      // control lane still offers the cancel and turn.start would refuse it
      // forever. The human resolves the cancellation first.
      if (r.cancel_requested) throw new ApiError(409, 'cancellation_pending');
      await t.query(
        `UPDATE turns SET state = 'queued', lease_epoch = NULL, run_token = NULL WHERE id = $1`, [r.turn_id]);
      await t.query(`UPDATE commands SET state = 'queued' WHERE id = $1`, [m[2]]);
      await t.query(
        `UPDATE native_sessions SET recovery_required = FALSE,
           active_turn_id = CASE WHEN active_turn_id = $2 THEN NULL ELSE active_turn_id END,
           updated_at = now() WHERE id = $1`, [m[1], r.turn_id]);
      const { seq } = await nextSeq(t, m[1]);
      await appendEvent(t, m[1], seq, {
        kind: 'turn.requeued', commandId: m[2], turnId: r.turn_id, originActorId: ctx.actorId,
      });
      daemonId = s.owner_daemon_id;
      return { status: 202, body: { messageId: m[2], turnId: r.turn_id } };
    });
    if (daemonId) notify.wakeDaemon(daemonId, 'work');
    notify.pokeAccount(ctx.accountId, m[1], ['events', 'state']);
    return out;
  });

  // ── client: turns ─────────────────────────────────────────────────────────
  route('GET', '/sessions/([\\w-]+)/turns/([\\w-]+)', {}, async (ctx, m) => {
    const row = await db.tx(async (t) => {
      await ownedSession(t, m[1], ctx.accountId);
      const { rows: [r] } = await t.query(`SELECT * FROM turns WHERE id = $1 AND session_id = $2`, [m[2], m[1]]);
      if (!r) throw new ApiError(404, 'turn_not_found');
      return r;
    });
    return {
      id: row.id, state: row.state, terminalState: row.terminal_state,
      messageId: row.prompt_command_id, cancelRequested: !!row.cancel_requested,
    };
  });
  route('POST', '/sessions/([\\w-]+)/turns/([\\w-]+)/cancellations', {}, async (ctx, m, body) => {
    // turnId is a PRECONDITION: cancelling a turn that is not the active one
    // answers 409 with the actual active turn, and nothing is aborted.
    const { rows: [s] } = await db.query(
      `SELECT account_id FROM native_sessions WHERE id = $1`, [m[1]]);
    if (!s || s.account_id !== ctx.accountId) throw new ApiError(404, 'session_not_found');
    // The executing turn straight from TURNS: active_turn_id fills only on
    // /start, which let a cancellation slip past a DISPATCHING turn. This is
    // a UX guard (best-effort read); acceptCancellation itself is state-safe.
    const { rows: [active] } = await db.query(
      `SELECT id FROM turns WHERE session_id = $1 AND state IN ('dispatching','running','cancelling')
       ORDER BY request_seq LIMIT 1`, [m[1]]);
    if (active && active.id !== m[2]) {
      throw new ApiError(409, { error: 'different_turn_active', activeTurnId: active.id });
    }
    return core.acceptCancellation(ctx.accountId, ctx.actorId, m[1], m[2],
      { clientIntentId: body.clientIntentId ?? intent('v2c'), scope: body.scope ?? 'turn' });
  });

  // ── client: attachments (device-born sealed bytes only) ───────────────────
  route('POST', '/attachments', { raw: true }, async (ctx, m, body, url, req) => {
    const sessionId = String(req.headers['x-session'] ?? '');
    if (!sessionId) throw new ApiError(400, 'missing_session');
    const payload = await readRaw(req, ATTACH_REQUEST_MAX);
    const r = await attachments.store(ctx.accountId, sessionId, String(req.headers['x-cipher-hash'] ?? '') || null, payload);
    return { status: r.deduped ? 200 : 201, body: { attachmentId: r.attachmentId, size: r.size } };
  });
  route('GET', '/attachments/([\\w-]+)', {}, async (ctx, m, body, url, req, res) => {
    const buf = await attachments.fetch(ctx.accountId, m[1]);
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'cache-control': 'immutable, max-age=31536000',
      'content-length': buf.length,
    });
    res.end(buf);
    return null;
  });

  // ── client: account plane (auth, pairing, profile, machines, push) ───────
  // Served natively by accounts.mjs: with these, a client needs NOTHING
  // outside /joy/v2 and the relay is the only server in the system.
  //
  // Direct challenge login (secret-key restore): the ONE call that turns an
  // account secret into a bearer token. No auth — it IS the login.
  route('POST', '/auth', { auth: false }, async (ctx, m, body) => accounts.login(body));
  // Pairing handshake, two flavours with identical mechanics: `terminal`
  // (a daemon being paired) and `account` (a new device restoring the
  // account). The requester posts an ephemeral key and polls (POST doubles
  // as the poll); an authorized device answers with the sealed secret.
  route('POST', '/auth/request', { auth: false }, async (ctx, m, body) => accounts.pairingRequest('terminal', body));
  route('GET', '/auth/request/status', { auth: false }, async (ctx, m, body, url) =>
    accounts.pairingStatus('terminal', url.searchParams.get('publicKey')));
  route('POST', '/auth/response', {}, async (ctx, m, body) => accounts.pairingRespond('terminal', ctx.accountId, body));
  route('POST', '/auth/account/request', { auth: false }, async (ctx, m, body) => accounts.pairingRequest('account', body));
  route('GET', '/auth/account/request/status', { auth: false }, async (ctx, m, body, url) =>
    accounts.pairingStatus('account', url.searchParams.get('publicKey')));
  route('POST', '/auth/account/response', {}, async (ctx, m, body) => accounts.pairingRespond('account', ctx.accountId, body));
  route('GET', '/account/profile', {}, async (ctx) => accounts.profile(ctx.accountId));

  // Machines: sealed metadata + daemonState with CAS versions; presence is
  // derived from lease liveness (see accounts.liveness).
  route('GET', '/machines', {}, async (ctx) => accounts.listMachines(ctx.accountId));
  // POST replaces the sealed blob; with `expectedMetadataVersion` it is a
  // conditional replace (409 metadata_version_mismatch on any other version).
  route('POST', '/machines', {}, async (ctx, m, body) => accounts.upsertMachine(ctx.accountId, body));
  route('GET', '/machines/([\\w.-]+)', {}, async (ctx, m) => accounts.getMachine(ctx.accountId, m[1]));
  route('PATCH', '/machines/([\\w.-]+)', {}, async (ctx, m, body) => accounts.patchMachine(ctx.accountId, m[1], body));
  route('DELETE', '/machines/([\\w.-]+)', {}, async (ctx, m) => accounts.deleteMachine(ctx.accountId, m[1]));

  // Push: token registry + delivery. Daemons ask the relay to deliver so no
  // device token ever has to leave the relay.
  route('POST', '/push-tokens', {}, async (ctx, m, body) => accounts.registerPushToken(ctx.accountId, body.token));
  route('GET', '/push-tokens', {}, async (ctx) => accounts.listPushTokens(ctx.accountId));
  route('DELETE', '/push-tokens/([^/]+)', {}, async (ctx, m) => accounts.deletePushToken(ctx.accountId, decodeURIComponent(m[1])));
  route('POST', '/push', {}, async (ctx, m, body) => accounts.sendPush(ctx.accountId, body));

  // ── client: E2E tunnel to a machine (endpoint-agnostic, relay-blind) ──────
  route('POST', '/machines/([\\w.-]+)/http', { raw: true }, async (ctx, m, body, url, req, res) => {
    // Ownership, liveness and capacity FIRST, before a single body byte is
    // buffered: an offline daemon or a full inbox used to cost the relay the
    // whole 32 MiB upload before it said no. The admission reserves the
    // declared size against the inbox budgets while the body is in flight,
    // so K unfinished uploads cannot pin K × 32 MiB either.
    await core.assertDaemonOwned(m[1], ctx.accountId);
    const reservation = tunnel.admit(m[1], declaredLength(req));
    let payload;
    try {
      payload = await readRaw(req, TUNNEL_REQUEST_MAX);
    } catch (e) {
      reservation.release();
      throw e;
    }
    tunnel.clientRequest(m[1], payload, res, reservation);
    return null; // tunnel owns res for the life of the exchange
  });

  // ── daemon surface (lease auth) ───────────────────────────────────────────
  route('POST', '/daemon/leases', {}, async (ctx, m, body) => {
    if (!body.machineId) throw new ApiError(400, 'missing_machineId');
    return core.acquireLease(ctx.accountId, String(body.machineId), body);
  });
  route('PUT', '/daemon/leases/([\\w-]+)', { auth: false }, async (ctx, m, body, url, req) => {
    const token = req.headers['x-joy-lease-token'];
    if (!token) throw new ApiError(401, 'missing_lease_token');
    return core.renewLease(m[1], hashToken(String(token)));
  });

  // Claims pre-resolve the lease (the waiter needs daemon_id); real fencing
  // happens INSIDE each core transaction.
  async function leaseCtx(leaseId, req) {
    const token = req.headers['x-joy-lease-token'];
    if (!token) throw new ApiError(401, 'missing_lease_token');
    const tokenHash = hashToken(String(token));
    const { rows } = await db.query(
      `SELECT *, (expires_at < now()) AS is_expired FROM daemon_leases
       WHERE id = $1 AND released_at IS NULL AND token_hash = $2`, [leaseId, tokenHash]);
    const lease = rows[0];
    if (!lease) throw new ApiError(401, 'lease_unknown');
    if (lease.is_expired) throw new ApiError(412, 'lease_expired');
    return { id: lease.id, daemon_id: lease.daemon_id, epoch: lease.epoch, token_hash: tokenHash, account_id: lease.account_id };
  }
  const claimHandler = (lane) => async (ctx, m, body, url, req) => {
    const lease = await leaseCtx(m[1], req);
    if (lane === 'tunnel') return tunnel.claim(lease.daemon_id, Number(body?.waitMs ?? CLAIM_WAIT_MS));
    const fn = lane === 'work' ? core.claimWork : core.claimControl;
    // Waiter registered BEFORE the query (lost-wake safety).
    const waited = notify.waitForDaemon(lease.daemon_id, lane, Math.min(Number(body?.waitMs ?? CLAIM_WAIT_MS), 30_000));
    const first = await fn(lease.id, lease.token_hash);
    if (first.offers.length > 0 || body?.noWait) return first;
    await waited;
    return fn(lease.id, lease.token_hash);
  };
  route('POST', '/daemon/leases/([\\w-]+)/claims/work', { auth: false }, claimHandler('work'));
  route('POST', '/daemon/leases/([\\w-]+)/claims/control', { auth: false }, claimHandler('control'));
  route('POST', '/daemon/leases/([\\w-]+)/claims/tunnel', { auth: false }, claimHandler('tunnel'));

  // Lifecycle writes: the lease REFERENCE comes from headers (id + token +
  // MANDATORY epoch); the core fences it inside the mutation's transaction.
  const withLeaseHeaders = (fn) => async (ctx, m, body, url, req) => {
    const leaseId = req.headers['x-joy-lease-id'];
    const token = req.headers['x-joy-lease-token'];
    const epoch = req.headers['x-joy-lease-epoch'];
    if (!leaseId || !token) throw new ApiError(401, 'missing_lease_credentials');
    if (epoch === undefined || epoch === null || epoch === '') throw new ApiError(401, 'missing_lease_epoch');
    const leaseRef = { id: String(leaseId), token_hash: hashToken(String(token)), epoch: String(epoch) };
    return fn(leaseRef, m, body);
  };
  route('POST', '/daemon/deliveries/([\\w-]+)/received', { auth: false },
    withLeaseHeaders((lease, m) => core.deliveryReceived(m[1], lease).then(() => ({ ok: true }))));
  route('POST', '/daemon/sessions/([\\w-]+)/bind', { auth: false },
    withLeaseHeaders((lease, m, body) => {
      if (!body.localSessionId || !body.sessionKeyEnvelope) throw new ApiError(400, 'missing_bind_fields');
      return core.bindSession(m[1], lease, body).then(() => ({ ok: true }));
    }));
  // Card publish: the daemon keeps the session's ENCRYPTED metadata (sealed
  // with the session content key) and lifecycle state current, so clients can
  // render the session list from v2 alone.
  route('PATCH', '/daemon/sessions/([\\w-]+)', { auth: false },
    withLeaseHeaders((lease, m, body) => core.updateSessionCard(m[1], lease, body).then(() => ({ ok: true }))));
  route('POST', '/daemon/sessions/([\\w-]+)/facts', { auth: false, summary: 'Daemon output outside a turn (sealed adapter record); lease-fenced' },
    withLeaseHeaders((lease, m, body) => core.sessionFact(m[1], lease, body ?? {})));
  // `deliveryId` (optional) names the spawn attempt the report belongs to;
  // a report for a superseded attempt is acknowledged but not applied (#612).
  route('POST', '/daemon/sessions/([\\w-]+)/spawn-failed', { auth: false },
    withLeaseHeaders((lease, m, body) => core.spawnFailed(m[1], lease, body.reason ?? 'spawn_failed',
      { deliveryId: typeof body.deliveryId === 'string' ? body.deliveryId : undefined })));
  route('POST', '/daemon/turns/([\\w-]+)/submitted', { auth: false },
    withLeaseHeaders((lease, m) => core.turnSubmitted(m[1], lease).then(() => ({ ok: true }))));
  route('POST', '/daemon/turns/([\\w-]+)/start', { auth: false },
    withLeaseHeaders((lease, m, body) => core.turnStarted(m[1], lease, body ?? {})));
  route('POST', '/daemon/turns/([\\w-]+)/facts', { auth: false },
    withLeaseHeaders(async (lease, m, body) => {
      if (!body.type) throw new ApiError(400, 'missing_type');
      // Ephemeral lane: streaming deltas fan out over SSE and are NEVER
      // persisted. The fence here must be as strict as core.withTurn's:
      // live unexpired lease, matching epoch, lease's daemon OWNS the turn's
      // session, and the turn is actually executing — otherwise any valid
      // lease could emit ciphertext into another account's stream.
      if (body.type === 'output' && body.ephemeral === true) {
        // Read lease AND turn in ONE transaction so a replacement actor that
        // bumps the epoch mid-check cannot slip a stale frame past the fence
        // (validation-to-use race). The emit runs only after the snapshot
        // agrees on epoch, ownership, and an executing turn.
        const target = await db.tx(async (t) => {
          const { rows: [l] } = await t.query(
            `SELECT *, (expires_at < now()) AS is_expired FROM daemon_leases
             WHERE id = $1 AND released_at IS NULL AND token_hash = $2`, [lease.id, lease.token_hash]);
          if (!l) throw new ApiError(401, 'lease_unknown');
          if (l.is_expired) throw new ApiError(412, 'lease_expired');
          if (String(l.epoch) !== String(lease.epoch)) throw new ApiError(412, 'lease_epoch_stale');
          const { rows: [row] } = await t.query(
            `SELECT s.account_id, s.owner_daemon_id, s.id AS session_id, tu.state AS turn_state
             FROM turns tu JOIN native_sessions s ON s.id = tu.session_id WHERE tu.id = $1`, [m[1]]);
          if (!row) throw new ApiError(404, 'turn_not_found');
          if (row.owner_daemon_id !== l.daemon_id || row.account_id !== l.account_id) {
            throw new ApiError(403, 'not_owner_daemon');
          }
          if (!['dispatching', 'running', 'cancelling'].includes(row.turn_state)) {
            throw new ApiError(409, 'turn_not_active');
          }
          return row;
        });
        notify.emitEphemeral(target.account_id, target.session_id, m[1], body.ciphertext);
        return { ok: true, ephemeral: true };
      }
      return core.turnFact(m[1], lease, body);
    }));
  route('POST', '/daemon/turns/([\\w-]+)/reconcile', { auth: false },
    withLeaseHeaders((lease, m, body) => {
      if (!body.resolution) throw new ApiError(400, 'missing_resolution');
      return core.reconcileTurn(m[1], lease, body);
    }));
  route('POST', '/daemon/tunnel/([\\w-]+)/frames', { auth: false, raw: true }, async (ctx, m, body, url, req) => {
    const leaseId = String(req.headers['x-joy-lease-id'] ?? '');
    if (!leaseId) throw new ApiError(401, 'missing_lease_id');
    const lease = await leaseCtx(leaseId, req);
    // Existence, ownership and the client's presence are settled BEFORE the
    // frame body is read: a post for a gone request used to cost a full
    // (up to 32 MiB) body read before the 404.
    tunnel.assertAnswerable(m[1], lease.daemon_id);
    if (declaredLength(req) > TUNNEL_REQUEST_MAX) throw new ApiError(413, 'body_too_large');
    const chunk = await readRaw(req, TUNNEL_REQUEST_MAX);
    return tunnel.daemonFrames(m[1], lease.daemon_id, chunk, url.searchParams.get('done') === '1');
  });

  // ── dispatch ──────────────────────────────────────────────────────────────
  async function handle(req, res) {
    if (!req.url?.startsWith('/joy/v2')) return false;
    // Browser clients (the app's web build) hit v2 cross-origin. Auth is a
    // bearer header (no cookies), content is sealed — a permissive ACAO is
    // safe and required. Wrapping writeHead covers every response path
    // (JSON, SSE, attachments, tunnel, errors) in one place.
    const cors = {
      'access-control-allow-origin': req.headers.origin ?? '*',
      'access-control-allow-headers': 'authorization, content-type, x-session, x-cipher-hash, x-joy-relay-key, x-joy-client',
      'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
      'access-control-max-age': '86400',
    };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return true; }
    const origWriteHead = res.writeHead.bind(res);
    res.writeHead = (status, headers) => origWriteHead(status, { ...cors, ...(headers ?? {}) });
    const url = new URL(req.url, 'http://joy-relay');
    const path = url.pathname.slice('/joy/v2'.length) || '/';
    const match = routes.find((r) => r.method === req.method && r.regex.test(path));
    try {
      if (!match) throw new ApiError(404, 'not_found');
      const ctx = { accountId: null, actorId: null };
      if (match.opts.auth !== false) {
        const header = req.headers.authorization ?? '';
        const token = header.startsWith('Bearer ') ? header.slice(7) : null;
        ctx.accountId = await auth.verifyToken(token);
        if (!ctx.accountId) throw new ApiError(401, 'unauthorized');
        ctx.actorId = `tok:${hashToken(token).slice(0, 32)}`;
      }
      const m = path.match(match.regex);
      const body = req.method === 'GET' || req.method === 'DELETE' || match.opts.raw ? {} : await readJson(req);
      const out = await match.handler(ctx, m, body, url, req, res);
      if (out === null) return true; // handler owns the response
      const isEnvelope = out && typeof out === 'object' && typeof out.status === 'number' && 'body' in out;
      res.writeHead(isEnvelope ? out.status : 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(isEnvelope ? out.body : out));
    } catch (e) {
      if (isClientAbort(e, req)) { // the client left mid-body: nobody to answer, nothing to log
        try { res.destroy(); } catch { /* already gone */ }
        return true;
      }
      const status = e instanceof ApiError ? e.status : 500;
      const code = e instanceof ApiError ? e.code : 'internal_error';
      if (status === 500) console.error('[joy-relay v2] internal error:', e);
      if (!res.headersSent) {
        res.writeHead(status, { 'content-type': 'application/json', ...(e instanceof ApiError && e.headers ? e.headers : {}) });
        res.end(JSON.stringify(typeof code === 'object' ? code : { error: code }));
      } else {
        res.end();
      }
    }
    return true;
  }
  /** Method + path of every v2 route (feeds /openapi.json so the docs cannot
   *  drift from dispatch). */
  const routeTable = () => routes.map((r) => ({
    method: r.method, pattern: `/joy/v2${r.pattern}`, auth: r.opts.auth !== false,
    summary: r.opts.summary, params: [], sse: r.pattern === '/events/stream',
  }));
  return { handle, routeTable };
}
