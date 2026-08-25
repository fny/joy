// /joy/v2 — the durable-plane surface, mounted ADDITIVELY beside /joy/v1.
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
import { ApiError, hashToken } from './core.mjs';

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
const intent = (p) => `${p}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

function messageStatus(cmdState, turnState, terminalState) {
  if (cmdState === 'cancelled' || terminalState === 'cancelled') return 'cancelled';
  if (cmdState === 'indeterminate' || turnState === 'orphaned') return 'failed';
  if (turnState === 'terminal') return terminalState === 'completed' ? 'delivered' : 'failed';
  if (turnState === 'running' || turnState === 'cancelling') return 'delivered';
  if (turnState === 'dispatching') return 'delivering';
  return 'queued';
}
function failureFor(status, turnState) {
  if (status !== 'failed') return undefined;
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
    failure: failureFor(status, r.turn_state),
    turnId: r.turn_id, position: String(r.request_seq),
    createdAt: new Date(r.created_at).getTime(),
  };
}
const MSG_SELECT = `
  SELECT c.id, c.ciphertext, c.state AS cmd_state, c.turn_id, c.created_at,
         tu.state AS turn_state, tu.terminal_state, tu.request_seq
  FROM commands c JOIN turns tu ON tu.id = c.turn_id
  WHERE c.session_id = $1 AND c.kind = 'prompt'`;

export function createV2Router({ core, auth, notify, db, tunnel, attachments }) {
  const routes = [];
  const route = (method, pattern, opts, handler) =>
    routes.push({ method, regex: new RegExp(`^${pattern}$`), opts, handler });

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
    core.sessionEvents(ctx.accountId, m[1], url.searchParams.get('after'), url.searchParams.get('limit')));

  // ── client: SSE doorbell (same stream contract as v1) ─────────────────────
  route('GET', '/events/stream', {}, async (ctx, m, body, url, req, res) => {
    const handle = notify.addSse(ctx.accountId, res);
    if (!handle) throw new ApiError(429, 'too_many_streams');
    res.writeHead(200, {
      'content-type': 'text/event-stream', 'cache-control': 'no-cache',
      connection: 'keep-alive', 'x-accel-buffering': 'no',
    });
    const sessions = await core.listSessions(ctx.accountId);
    res.write(`event: hello\ndata: ${JSON.stringify({
      v: 2, sessions: sessions.map((s) => ({ sessionId: s.sessionId, headSeq: s.headSeq, revision: s.revision })),
    })}\n\n`);
    handle.markReady();
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* closed */ } }, 15_000);
    res.on('close', () => clearInterval(ping));
    return null; // handler owns the response
  });

  // ── client: messages ──────────────────────────────────────────────────────
  route('GET', '/sessions/([\\w-]+)/messages', {}, async (ctx, m, body, url) => {
    const status = url.searchParams.get('status');
    const limit = Math.min(Number(url.searchParams.get('limit') ?? 100), 500);
    const rows = await db.tx(async (t) => {
      await ownedSession(t, m[1], ctx.accountId);
      const { rows } = await t.query(`${MSG_SELECT} ORDER BY tu.request_seq LIMIT $2`, [m[1], limit]);
      return rows;
    });
    let messages = rows.map(rowToMessage);
    if (status) messages = messages.filter((x) => x.status === status);
    return { messages };
  });
  route('POST', '/sessions/([\\w-]+)/messages', {}, async (ctx, m, body) => {
    if (typeof body.ciphertext !== 'string') throw new ApiError(400, 'missing_ciphertext');
    // Bytes-first-reference-second: every cited attachment must already exist
    // for this session BEFORE the message is accepted, so a bad id can never
    // strand a queued message.
    const ids = Array.isArray(body.attachments) ? body.attachments : [];
    if (ids.length > 0) {
      await db.tx((t) => attachments.reference(t, m[1], null, ids));
    }
    const accepted = await core.acceptPrompt(ctx.accountId, ctx.actorId, m[1], {
      ciphertext: body.ciphertext, clientIntentId: body.clientIntentId ?? intent('v2m'),
    });
    if (ids.length > 0) {
      await db.tx((t) => attachments.reference(t, m[1], accepted.commandId, ids));
    }
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
      }
      if (body.position !== undefined) {
        // Reorder among this session's QUEUED turns: permute their existing
        // request_seq values so the global sequence stays dense and unique.
        const { rows: queued } = await t.query(
          `SELECT id, request_seq FROM turns WHERE session_id = $1 AND state = 'queued' ORDER BY request_seq`, [m[1]]);
        const from = queued.findIndex((q) => q.id === r.turn_id);
        const to = Math.max(0, Math.min(queued.length - 1, Number(body.position)));
        if (from >= 0 && from !== to) {
          const order = queued.map((q) => q.id);
          order.splice(to, 0, order.splice(from, 1)[0]);
          const seqs = queued.map((q) => q.request_seq);
          for (let i = 0; i < order.length; i++) {
            await t.query(`UPDATE turns SET request_seq = $1 WHERE id = $2`, [seqs[i], order[i]]);
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
    // (terminalization, barrier bookkeeping, late-start CAS all shared).
    const r = await db.tx(async (t) => {
      await ownedSession(t, m[1], ctx.accountId);
      return loadMessage(t, m[1], m[2]);
    });
    const status = messageStatus(r.cmd_state, r.turn_state, r.terminal_state);
    if (status !== 'queued') throw new ApiError(409, { error: 'not_deletable', status });
    const out = await core.acceptCancellation(ctx.accountId, ctx.actorId, m[1], r.turn_id,
      { clientIntentId: intent('v2d'), scope: 'turn' });
    return { ok: true, disposition: out.disposition };
  });
  route('POST', '/sessions/([\\w-]+)/messages/([\\w-]+)/retry', {}, async (ctx, m) => {
    // Only an ORPHANED turn is retryable: the human saw mayHaveDelivered and
    // authorized a re-attempt of the SAME message. Everything else is 409.
    let daemonId = null;
    const out = await db.tx(async (t) => {
      const s = await ownedSession(t, m[1], ctx.accountId);
      const r = await loadMessage(t, m[1], m[2]);
      if (r.turn_state !== 'orphaned') throw new ApiError(409, 'not_retryable');
      await t.query(`UPDATE turns SET state = 'queued', lease_epoch = NULL, run_token = NULL WHERE id = $1`, [r.turn_id]);
      await t.query(`UPDATE commands SET state = 'queued' WHERE id = $1`, [m[2]]);
      await t.query(
        `UPDATE native_sessions SET recovery_required = FALSE,
           active_turn_id = CASE WHEN active_turn_id = $2 THEN NULL ELSE active_turn_id END,
           updated_at = now() WHERE id = $1`, [m[1], r.turn_id]);
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
      `SELECT account_id, active_turn_id FROM native_sessions WHERE id = $1`, [m[1]]);
    if (!s || s.account_id !== ctx.accountId) throw new ApiError(404, 'session_not_found');
    if (s.active_turn_id && s.active_turn_id !== m[2]) {
      throw new ApiError(409, { error: 'different_turn_active', activeTurnId: s.active_turn_id });
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

  // ── client: E2E tunnel to a machine (endpoint-agnostic, relay-blind) ──────
  route('POST', '/machines/([\\w.-]+)/http', { raw: true }, async (ctx, m, body, url, req, res) => {
    // Ownership FIRST, before reading the body.
    await core.assertDaemonOwned(m[1], ctx.accountId);
    const payload = await readRaw(req, TUNNEL_REQUEST_MAX);
    tunnel.clientRequest(m[1], payload, res);
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
  route('POST', '/daemon/turns/([\\w-]+)/submitted', { auth: false },
    withLeaseHeaders((lease, m) => core.turnSubmitted(m[1], lease).then(() => ({ ok: true }))));
  route('POST', '/daemon/turns/([\\w-]+)/start', { auth: false },
    withLeaseHeaders((lease, m, body) => core.turnStarted(m[1], lease, body ?? {})));
  route('POST', '/daemon/turns/([\\w-]+)/facts', { auth: false },
    withLeaseHeaders(async (lease, m, body) => {
      if (!body.type) throw new ApiError(400, 'missing_type');
      // Ephemeral lane: streaming deltas fan out over SSE and are NEVER
      // persisted — the durable output block that follows supersedes them.
      if (body.type === 'output' && body.ephemeral === true) {
        const { rows: [row] } = await db.query(
          `SELECT s.account_id, s.id AS session_id, s.owner_daemon_id, l.epoch
           FROM turns tu JOIN native_sessions s ON s.id = tu.session_id
           LEFT JOIN daemon_leases l ON l.id = $2 AND l.released_at IS NULL AND l.token_hash = $3
           WHERE tu.id = $1`, [m[1], lease.id, lease.token_hash]);
        if (!row || row.epoch == null) throw new ApiError(401, 'lease_unknown');
        if (String(row.epoch) !== String(lease.epoch)) throw new ApiError(412, 'lease_epoch_stale');
        notify.emitEphemeral(row.account_id, row.session_id, m[1], body.ciphertext);
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
    const chunk = await readRaw(req, TUNNEL_REQUEST_MAX);
    return tunnel.daemonFrames(m[1], lease.daemon_id, chunk, url.searchParams.get('done') === '1');
  });

  // ── dispatch ──────────────────────────────────────────────────────────────
  async function handle(req, res) {
    if (!req.url?.startsWith('/joy/v2')) return false;
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
      const status = e instanceof ApiError ? e.status : 500;
      const code = e instanceof ApiError ? e.code : 'internal_error';
      if (status === 500) console.error('[joy-relay v2] internal error:', e);
      if (!res.headersSent) {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(typeof code === 'object' ? code : { error: code }));
      } else {
        res.end();
      }
    }
    return true;
  }
  return { handle };
}
