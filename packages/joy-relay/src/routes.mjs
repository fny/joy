// /joy/v1 router: thin HTTP shell over core.mjs. Hand-rolled matching and
// validation (zero-dep bias) — every handler validates the fields it uses and
// returns typed ApiErrors; anything unmatched falls through to the legacy
// passthrough.
import { ApiError, hashToken } from './core.mjs';

const CAPABILITIES = {
  relay: 'joy-relay',
  protocol: { major: 1, minor: 0 },
  features: ['sessions', 'turns', 'cancellations', 'claims', 'events', 'state', 'sse'],
};

function readBody(req, limit = 512 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new ApiError(413, 'body_too_large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new ApiError(400, 'bad_json')); }
    });
    req.on('error', reject);
  });
}

function need(body, ...fields) {
  for (const f of fields) {
    if (body[f] === undefined || body[f] === null || body[f] === '') throw new ApiError(400, `missing_${f}`);
  }
}

const CLAIM_WAIT_MS = 25_000;

export function createRouter({ core, auth, notify, db }) {
  // route table: [method, regex, handler(ctx, match, body)]
  const routes = [];
  const route = (method, pattern, opts, handler) => {
    routes.push({ method, pattern, regex: new RegExp(`^${pattern}$`), opts, handler });
  };

  // ── client surface ────────────────────────────────────────────────────────

  route('GET', '/joy/v1/capabilities', { summary: 'Nucleus capabilities/version (no auth)', auth: false }, async () => CAPABILITIES);

  route('GET', '/joy/v1/sessions', { summary: 'List durable sessions',}, async (ctx) => ({ sessions: await core.listSessions(ctx.accountId) }));

  route('POST', '/joy/v1/session-creations', { summary: 'Create a durable session (idempotent per actor)',}, async (ctx, m, body) => {
    need(body, 'creationIntentId', 'daemonId');
    if (body.mode === 'announce_existing') need(body, 'localSessionId', 'sessionKeyEnvelope');
    return core.createSession(ctx.accountId, ctx.actorId, body);
  });

  route('POST', '/joy/v1/sessions/([\\w-]+)/turns', { summary: 'Submit a turn to the durable queue', params: ['sessionId'],}, async (ctx, m, body) => {
    need(body, 'clientIntentId', 'ciphertext');
    return core.acceptPrompt(ctx.accountId, ctx.actorId, m[1], body);
  });

  route('POST', '/joy/v1/sessions/([\\w-]+)/turns/([\\w-]+)/cancellations', { summary: 'Cancel a queued/running turn', params: ['sessionId', 'turnId'],}, async (ctx, m, body) => {
    need(body, 'clientIntentId');
    return core.acceptCancellation(ctx.accountId, ctx.actorId, m[1], m[2], body);
  });

  route('GET', '/joy/v1/sessions/([\\w-]+)/state', { summary: 'Session state snapshot', params: ['sessionId'],}, async (ctx, m) => core.sessionState(ctx.accountId, m[1]));

  route('GET', '/joy/v1/sessions/([\\w-]+)/events', { summary: 'Session event log slice', params: ['sessionId'],}, async (ctx, m, body, url) =>
    core.sessionEvents(ctx.accountId, m[1], url.searchParams.get('after_seq') ?? url.searchParams.get('afterSeq') ?? 0,
      url.searchParams.get('limit')));

  route('GET', '/joy/v1/events/stream', { summary: 'SSE event stream', sse: true }, async (ctx, m, body, url, req, res) => {
    // Register FIRST (buffering), then snapshot, then flush — a commit that
    // lands between snapshot and registration cannot be lost.
    const handle = notify.addSse(ctx.accountId, res);
    if (!handle) throw new ApiError(429, 'too_many_streams');
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    const sessions = await core.listSessions(ctx.accountId);
    res.write(`event: hello\ndata: ${JSON.stringify({
      v: 1, sessions: sessions.map((s) => ({ sessionId: s.sessionId, headSeq: s.headSeq, revision: s.revision })),
    })}\n\n`);
    handle.markReady();
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* closed */ } }, 15_000);
    res.on('close', () => clearInterval(ping));
    return null; // handler owns the response
  });

  // ── daemon surface ────────────────────────────────────────────────────────

  route('POST', '/joy/v1/daemons/([\\w.-]+)/leases', { summary: 'Acquire a daemon lease', params: ['machineId'],}, async (ctx, m, body) =>
    core.acquireLease(ctx.accountId, m[1], body));

  // Pre-resolution for claims only (the waiter needs daemon_id). All actual
  // fencing happens INSIDE each core transaction via fencedLease — this
  // lookup is advisory and includes the same expiry check for fast failure.
  const leaseCtx = async (leaseId, req) => {
    const token = req.headers['x-joy-lease-token'];
    if (!token) throw new ApiError(401, 'missing_lease_token');
    const tokenHash = hashToken(String(token));
    const epoch = req.headers['x-joy-lease-epoch'];
    const { rows } = await db.query(
      `SELECT *, (expires_at < now()) AS is_expired FROM daemon_leases
       WHERE id = $1 AND released_at IS NULL AND token_hash = $2`, [leaseId, tokenHash]);
    const lease = rows[0];
    if (!lease) throw new ApiError(401, 'lease_unknown');
    if (epoch !== undefined && epoch !== null && String(lease.epoch) !== String(epoch)) throw new ApiError(412, 'lease_epoch_stale');
    if (lease.is_expired) throw new ApiError(412, 'lease_expired');
    return { id: lease.id, daemon_id: lease.daemon_id, epoch: lease.epoch, token_hash: tokenHash, account_id: lease.account_id };
  };

  route('PUT', '/joy/v1/daemon-leases/([\\w-]+)', { summary: 'Heartbeat/renew a lease (lease-token auth)', params: ['leaseId'], auth: false }, async (ctx, m, body, url, req) => {
    const token = req.headers['x-joy-lease-token'];
    if (!token) throw new ApiError(401, 'missing_lease_token');
    return core.renewLease(m[1], hashToken(String(token)));
  });

  const claimHandler = (lane) => async (ctx, m, body, url, req) => {
    const lease = await leaseCtx(m[1], req);
    const fn = lane === 'work' ? core.claimWork : core.claimControl;
    // Register the waiter BEFORE the query so a command committed in the gap
    // wakes us instead of being missed (lost-wake safety). If the first query
    // already has offers the abandoned waiter resolves later harmlessly.
    const waited = notify.waitForDaemon(lease.daemon_id, lane, Math.min(Number(body?.waitMs ?? CLAIM_WAIT_MS), 30_000));
    const first = await fn(lease.id, lease.token_hash);
    if (first.offers.length > 0 || body?.noWait) return first;
    await waited;
    return fn(lease.id, lease.token_hash);
  };
  route('POST', '/joy/v1/daemon-leases/([\\w-]+)/claims/work', { summary: 'Long-poll claim work under a lease', params: ['leaseId'], auth: false }, claimHandler('work'));
  route('POST', '/joy/v1/daemon-leases/([\\w-]+)/claims/control', { summary: 'Long-poll claim control messages under a lease', params: ['leaseId'], auth: false }, claimHandler('control'));

  /** Daemon lifecycle writes: build the lease REFERENCE from headers only —
   *  the core fences it inside the mutation's own transaction, so there is
   *  no gap between check and write. Epoch is mandatory here. */
  const withLeaseHeaders = (fn) => async (ctx, m, body, url, req) => {
    const leaseId = req.headers['x-joy-lease-id'];
    const token = req.headers['x-joy-lease-token'];
    const epoch = req.headers['x-joy-lease-epoch'];
    if (!leaseId || !token) throw new ApiError(401, 'missing_lease_credentials');
    if (epoch === undefined || epoch === null || epoch === '') throw new ApiError(401, 'missing_lease_epoch');
    const leaseRef = { id: String(leaseId), token_hash: hashToken(String(token)), epoch: String(epoch) };
    return fn(leaseRef, m, body);
  };

  route('POST', '/joy/v1/deliveries/([\\w-]+)/received', { summary: 'Ack a delivery', params: ['deliveryId'], auth: false },
    withLeaseHeaders((lease, m) => core.deliveryReceived(m[1], lease).then(() => ({ ok: true }))));
  route('POST', '/joy/v1/sessions/([\\w-]+)/bind', { summary: 'Bind a daemon to a session', params: ['sessionId'], auth: false },
    withLeaseHeaders((lease, m, body) => {
      need(body, 'localSessionId', 'sessionKeyEnvelope');
      return core.bindSession(m[1], lease, body).then(() => ({ ok: true }));
    }));
  route('POST', '/joy/v1/turns/([\\w-]+)/submitted', { summary: 'Mark a turn submitted to the agent', params: ['turnId'], auth: false },
    withLeaseHeaders((lease, m) => core.turnSubmitted(m[1], lease).then(() => ({ ok: true }))));
  route('POST', '/joy/v1/turns/([\\w-]+)/start', { summary: 'Mark a turn started', params: ['turnId'], auth: false },
    withLeaseHeaders((lease, m, body) => core.turnStarted(m[1], lease, body ?? {})));
  route('POST', '/joy/v1/turns/([\\w-]+)/facts', { summary: 'Append turn facts (progress/results)', params: ['turnId'], auth: false },
    withLeaseHeaders((lease, m, body) => {
      need(body, 'type');
      return core.turnFact(m[1], lease, body);
    }));
  route('POST', '/joy/v1/turns/([\\w-]+)/reconcile', { summary: 'Reconcile turn state after a daemon restart', params: ['turnId'], auth: false },
    withLeaseHeaders((lease, m, body) => {
      need(body, 'resolution');
      return core.reconcileTurn(m[1], lease, body);
    }));

  // ── dispatch ──────────────────────────────────────────────────────────────

  /** Returns true if the request was handled natively. */
  async function handle(req, res) {
    if (!req.url?.startsWith('/joy/v1')) return false;
    const url = new URL(req.url, 'http://joy-relay');
    const match = routes.find((r) => r.method === req.method && r.regex.test(url.pathname));
    try {
      if (!match) throw new ApiError(404, 'not_found');
      const ctx = { accountId: null, actorId: null };
      if (match.opts.auth !== false) {
        const header = req.headers.authorization ?? '';
        const token = header.startsWith('Bearer ') ? header.slice(7) : null;
        ctx.accountId = await auth.verifyToken(token);
        if (!ctx.accountId) throw new ApiError(401, 'unauthorized');
        // Actor identity is DERIVED from the presented token (stable per
        // device/daemon credential), never from a caller-chosen header —
        // idempotency scoping cannot be spoofed sideways.
        ctx.actorId = `tok:${hashToken(token).slice(0, 32)}`;
      }
      const m = url.pathname.match(match.regex);
      const body = req.method === 'GET' ? {} : await readBody(req);
      const out = await match.handler(ctx, m, body, url, req, res);
      if (out === null) return true; // handler owns the response (SSE)
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out));
    } catch (e) {
      const status = e instanceof ApiError ? e.status : 500;
      const code = e instanceof ApiError ? e.code : 'internal_error';
      if (status === 500) console.error('[joy-relay] internal error:', e);
      if (!res.headersSent) {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: code }));
      } else {
        res.end();
      }
    }
    return true;
  }

  /** Docs view of the table (docs.mjs): pattern + names, no handlers. */
  const routeTable = () => routes.map((r) => ({
    method: r.method, pattern: r.pattern,
    params: r.opts.params ?? [], summary: r.opts.summary ?? r.pattern,
    auth: r.opts.auth !== false, sse: r.opts.sse === true,
  }));
  return { handle, routeTable };
}
