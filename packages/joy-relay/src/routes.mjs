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

// ── per-route documentation (rendered by docs.mjs; no runtime effect) ──────
const DOC_capabilities = {
      tag: 'Meta',
      description: 'Protocol handshake. Returns the relay flavor, protocol version, and feature list — clients use this to detect a native-capable relay before speaking /joy/v1.',
      result: { type: 'object', properties: { relay: { type: 'string', example: 'joy-relay' }, protocol: { type: 'object', properties: { major: { type: 'integer' }, minor: { type: 'integer' } } }, features: { type: 'array', items: { type: 'string' }, example: ['sessions','turns','cancellations','claims','events','state','sse'] } } },
    };

const DOC_listSessions = {
      tag: 'Sessions',
      description: 'All non-archived durable sessions for the account, with each session\'s current head sequence and revision — the resync anchor after a disconnect (compare headSeq against your last-seen seq, then page /events).',
      result: { type: 'object', properties: { sessions: { type: 'array', items: { type: 'object', properties: { sessionId: { type: 'string', format: 'uuid' }, state: { type: 'string', enum: ['provisioning','starting','active','idle','failed','archived'] }, headSeq: { type: 'string', description: 'Highest event seq committed for this session' }, revision: { type: 'string' } } } } } },
    };

const DOC_createSession = {
      tag: 'Sessions',
      description: 'Create a durable session. Two modes: **spawn** (default) queues a spawn_session command for the owning daemon to pick up on its work lane; **announce_existing** registers a session the daemon already runs locally. Idempotent per (actor, creationIntentId): an exact retry replays the original result; a retry with DIFFERENT content is rejected with 409 idempotency_mismatch. 429 too_many_sessions above the per-account cap.',
      body: { type: 'object', required: ['creationIntentId','daemonId'], properties: {
        creationIntentId: { type: 'string', description: 'Client-chosen idempotency key, stable across retries' },
        daemonId: { type: 'string', description: 'Machine that will own the session (must belong to this account)' },
        mode: { type: 'string', enum: ['spawn','announce_existing'], default: 'spawn' },
        spawnSpec: { type: 'string', description: 'E2E-encrypted spawn parameters (spawn mode); the relay never reads it' },
        localSessionId: { type: 'string', description: 'REQUIRED for announce_existing: the daemon-local session id' },
        sessionKeyEnvelope: { type: 'string', description: 'REQUIRED for announce_existing: encrypted per-session key envelope' },
        encryptedMetadata: { type: 'string' } } },
      result: { type: 'object', properties: { sessionId: { type: 'string', format: 'uuid' }, state: { type: 'string', enum: ['provisioning','starting'] }, spawnCommandId: { type: 'string', description: 'spawn mode only' }, replay: { type: 'boolean', description: 'true when idempotent replay of a prior create' } } },
      errors: { 409: 'idempotency_mismatch', 429: 'too_many_sessions', 403: 'daemon not owned by account' },
    };

const DOC_submitTurn = {
      tag: 'Turns',
      description: 'Queue a prompt as a durable turn. The payload is an E2E ciphertext — the relay stores and forwards, never reads. Idempotent per (actor, clientIntentId) with request-hash verification. Rejected while the session has no key yet (provisioning) or is dead; 429 queue_full above the per-session queued-turn cap; 413 above the ciphertext size cap. On success the owning daemon is woken on its work lane.',
      body: { type: 'object', required: ['clientIntentId','ciphertext'], properties: {
        clientIntentId: { type: 'string', description: 'Client-chosen idempotency key' },
        ciphertext: { type: 'string', description: 'E2E-encrypted prompt (NaCl, session key)' } } },
      result: { type: 'object', properties: { clientIntentId: { type: 'string' }, requestHash: { type: 'string' }, commandId: { type: 'string' }, eventId: { type: 'string' }, seq: { type: 'string', description: 'Event-log position of turn.queued' }, turnId: { type: 'string', format: 'uuid' }, disposition: { type: 'string', example: 'queued' } } },
      errors: { 409: 'session_not_ready / idempotency_mismatch', 413: 'ciphertext_too_large', 429: 'queue_full' },
    };

const DOC_cancelTurn = {
      tag: 'Turns',
      description: 'Request cancellation of a turn. A QUEUED turn is cancelled airtight before start (a late turn.start is refused). A RUNNING turn gets a cancel command on the control lane for the daemon to act on. Already-terminal turns return disposition already_terminal. Idempotent per (actor, clientIntentId).',
      body: { type: 'object', required: ['clientIntentId'], properties: {
        clientIntentId: { type: 'string' },
        scope: { type: 'string', enum: ['turn_and_pending_before_barrier','turn_only'], default: 'turn_and_pending_before_barrier' } } },
      result: { type: 'object', properties: { disposition: { type: 'string', enum: ['cancelled_before_start','cancel_requested','already_terminal'] }, seq: { type: 'string' } } },
      errors: { 404: 'turn_not_found' },
    };

const DOC_sessionState = {
      tag: 'Sessions',
      description: 'Point-in-time snapshot: session state, active turn, queued turns, head seq. Cheaper than paging events when you only need "where are we now".',
      result: { type: 'object', properties: { sessionId: { type: 'string' }, state: { type: 'string' }, activeTurnId: { type: 'string', nullable: true }, headSeq: { type: 'string' }, queuedTurns: { type: 'array', items: { type: 'object' } } } },
    };

const DOC_sessionEvents = {
      tag: 'Sessions',
      description: 'Page the append-only event log after a sequence number. Events carry E2E ciphertexts for content kinds (turn.queued, output) and plain lifecycle facts (turn.started, turn.receipted, terminal states). This is the resync path: hello/poke tells you headSeq moved, you page from your cursor.',
      query: { after_seq: { type: 'string', description: 'Return events with seq greater than this (default 0)' }, limit: { type: 'string' } },
      result: { type: 'object', properties: { events: { type: 'array', items: { type: 'object', properties: { seq: { type: 'string' }, kind: { type: 'string', example: 'turn.queued' }, turnId: { type: 'string' }, ciphertext: { type: 'string', nullable: true } } } }, hasMore: { type: 'boolean' } } },
    };

const DOC_sse = {
      tag: 'Sessions',
      description: 'Server-sent events push channel. Opens with a `hello` frame listing every session with its headSeq/revision (your resync anchors), then pushes pokes as sessions change; `: ping` comfort noise every 15s. Registration happens before the snapshot so a concurrent commit cannot be lost. 429 when the per-account stream cap is hit.',
      result: { type: 'string', description: 'text/event-stream: hello {v, sessions:[{sessionId, headSeq, revision}]}, then change pokes' },
      errors: { 429: 'too_many_streams' },
    };

const DOC_acquireLease = {
      tag: 'Daemon leases',
      description: 'A daemon takes exclusive control of its machine identity. Each acquisition bumps the epoch, fencing out any previous process — anything the old holder had in flight is refused on write and resolved via /reconcile. The lease token returned here authenticates ALL daemon-surface calls (never the bearer). TTL 20s; renew continuously.',
      body: { type: 'object', properties: { capabilities: { type: 'object', description: 'Advertised daemon capabilities, stored on the lease' } } },
      result: { type: 'object', properties: { leaseId: { type: 'string', format: 'uuid' }, daemonId: { type: 'string' }, epoch: { type: 'string', description: 'Monotonic fence; stale epochs are rejected with 412' }, leaseToken: { type: 'string', description: 'Bearer-equivalent for the daemon surface — sent as x-joy-lease-token' }, ttlSeconds: { type: 'integer', example: 20 } } },
      errors: { 403: 'daemon_owned_by_other_account', 429: 'too_many_daemons' },
    };

const DOC_renewLease = {
      tag: 'Daemon leases',
      description: 'Heartbeat: extends the lease 20s from now. Auth is the lease token itself (x-joy-lease-token) — no account bearer. A lapsed lease orphans its running turns via the sweep; the daemon then re-acquires (new epoch) and reconciles.',
      headers: ['x-joy-lease-token'],
      result: { type: 'object', properties: { epoch: { type: 'string' } } },
      errors: { 401: 'lease_unknown / missing_lease_token', 412: 'lease_expired' },
    };

const DOC_claimWork = {
      tag: 'Daemon leases',
      description: 'Long-poll the WORK lane: spawn_session commands and the head queued prompt of each idle session (one executing turn per session — strict queue order). Blocks up to waitMs (cap 30s) for a wake; registration precedes the query so a command committed in the gap cannot be missed. Each offer carries a deliveryId to ack via /deliveries/{id}/received.',
      headers: ['x-joy-lease-token', 'x-joy-lease-epoch (optional fast-fail)'],
      body: { type: 'object', properties: { waitMs: { type: 'integer', maximum: 30000, default: 25000 }, noWait: { type: 'boolean', description: 'Return immediately even when empty' } } },
      result: { type: 'object', properties: { epoch: { type: 'string' }, offers: { type: 'array', items: { type: 'object', properties: { deliveryId: { type: 'string' }, commandId: { type: 'string' }, sessionId: { type: 'string' }, kind: { type: 'string', enum: ['spawn_session','prompt'] }, seq: { type: 'string' }, turnId: { type: 'string', description: 'prompt offers only' }, ciphertext: { type: 'string' }, clientIntentId: { type: 'string' }, requestHash: { type: 'string' } } } } } },
      errors: { 401: 'lease_unknown', 412: 'lease_epoch_stale / lease_expired' },
    };

const DOC_claimControl = {
      tag: 'Daemon leases',
      description: 'Long-poll the CONTROL lane: pending cancel commands for non-terminal turns. Separate from work so a cancel is never stuck behind a long prompt delivery. Same lease auth, wake and ack semantics as the work lane.',
      headers: ['x-joy-lease-token', 'x-joy-lease-epoch (optional fast-fail)'],
      body: { type: 'object', properties: { waitMs: { type: 'integer', maximum: 30000, default: 25000 }, noWait: { type: 'boolean' } } },
      result: { type: 'object', properties: { epoch: { type: 'string' }, offers: { type: 'array', items: { type: 'object', properties: { deliveryId: { type: 'string' }, commandId: { type: 'string' }, sessionId: { type: 'string' }, kind: { type: 'string', example: 'cancel' }, seq: { type: 'string' }, targetTurnId: { type: 'string' }, scope: { type: 'string' } } } } } },
      errors: { 401: 'lease_unknown', 412: 'lease_epoch_stale / lease_expired' },
    };

const DOC_deliveryAck = {
      tag: 'Daemon lifecycle',
      description: 'Acknowledge receipt of an offered command (from a claim). Fenced by the full lease header triplet inside the transaction — a stale epoch cannot ack.',
      headers: ['x-joy-lease-id', 'x-joy-lease-token', 'x-joy-lease-epoch'],
      result: { type: 'object', properties: { ok: { type: 'boolean' } } },
      errors: { 401: 'missing_lease_credentials', 412: 'stale/expired lease' },
    };

const DOC_bind = {
      tag: 'Daemon lifecycle',
      description: 'After executing a spawn_session command, the daemon binds the durable session to its local runtime and uploads the encrypted session key envelope. Only the owner daemon may bind; re-binding the same localSessionId is an idempotent no-op; binding an already-bound session with a different id is 409.',
      headers: ['x-joy-lease-id', 'x-joy-lease-token', 'x-joy-lease-epoch'],
      body: { type: 'object', required: ['localSessionId','sessionKeyEnvelope'], properties: { localSessionId: { type: 'string' }, sessionKeyEnvelope: { type: 'string', description: 'Encrypted per-session key — clients need it to decrypt events' } } },
      result: { type: 'object', properties: { ok: { type: 'boolean' } } },
      errors: { 403: 'not_owner_daemon', 409: 'already_bound' },
    };

const DOC_submitted = {
      tag: 'Daemon lifecycle',
      description: 'The daemon confirms it handed the prompt to the local agent process (pre-start). Distinct from turn start so a crash between the two is distinguishable during reconcile.',
      headers: ['x-joy-lease-id', 'x-joy-lease-token', 'x-joy-lease-epoch'],
      result: { type: 'object', properties: { ok: { type: 'boolean' } } },
    };

const DOC_start = {
      tag: 'Daemon lifecycle',
      description: 'CAS the turn to running. Refused if the turn was cancelled before start (the airtight path), if another turn is active, if an earlier queued turn exists (strict order), or if the offer\'s delivery is not current for this epoch. Returns a runToken the daemon threads through subsequent facts.',
      headers: ['x-joy-lease-id', 'x-joy-lease-token', 'x-joy-lease-epoch'],
      body: { type: 'object', properties: { runToken: { type: 'string', description: 'Optional client-chosen; generated when absent' }, runtimeEventId: { type: 'string' } } },
      result: { type: 'object', properties: { turnId: { type: 'string' }, state: { type: 'string', example: 'running' }, runToken: { type: 'string' }, replay: { type: 'boolean' } } },
      errors: { 409: 'turn_cancelled / another_turn_active / not_queue_head / turn_orphaned_reconcile_first' },
    };

const DOC_facts = {
      tag: 'Daemon lifecycle',
      description: 'Append a runtime fact to the running turn. Three types: **receipt** (transcript uuid observed — pairs the delivery), **output** (E2E ciphertext appended to the event log; budgeted per session), **terminal** (completed | failed | cancelled | interrupted — closes the turn, clears the active slot, resolves cancel commands). Facts carrying runtimeEventId are replay-safe: an exact retry returns the original seq.',
      headers: ['x-joy-lease-id', 'x-joy-lease-token', 'x-joy-lease-epoch'],
      body: { type: 'object', required: ['type'], properties: {
        type: { type: 'string', enum: ['receipt','output','terminal'] },
        runtimeEventId: { type: 'string', description: 'Idempotency key for this fact' },
        transcriptUuid: { type: 'string', description: 'receipt: local transcript identity' },
        ciphertext: { type: 'string', description: 'output/terminal: E2E payload' },
        kind: { type: 'string', description: 'output: event kind override (default output)' },
        terminalState: { type: 'string', enum: ['completed','failed','cancelled','interrupted'], description: 'terminal only' },
        meta: { type: 'object', description: 'terminal only' } } },
      result: { type: 'object', properties: { ok: { type: 'boolean' }, seq: { type: 'string' }, replay: { type: 'boolean' } } },
      errors: { 400: 'bad_fact_type / bad_terminal_state', 409: 'turn_terminal', 413: 'ciphertext_too_large', 429: 'session_event_budget_exhausted' },
    };

const DOC_reconcile = {
      tag: 'Daemon lifecycle',
      description: 'Post-restart resolution for ORPHANED turns only (lease lapse or fence violation moved them there). resolution=running re-fences the turn onto the new epoch (state becomes cancelling if a cancel was pending); resolution=terminal closes it (default interrupted). Terminal turns replay idempotently.',
      headers: ['x-joy-lease-id', 'x-joy-lease-token', 'x-joy-lease-epoch'],
      body: { type: 'object', required: ['resolution'], properties: { resolution: { type: 'string', enum: ['running','terminal'] }, terminalState: { type: 'string', enum: ['completed','failed','cancelled','interrupted'], default: 'interrupted' } } },
      result: { type: 'object', properties: { turnId: { type: 'string' }, state: { type: 'string' }, terminalState: { type: 'string' }, replay: { type: 'boolean' } } },
      errors: { 409: 'turn_not_orphaned / another_turn_active' },
    };



export function createRouter({ core, auth, notify, db }) {
  // route table: [method, regex, handler(ctx, match, body)]
  const routes = [];
  const route = (method, pattern, opts, handler) => {
    routes.push({ method, pattern, regex: new RegExp(`^${pattern}$`), opts, handler });
  };

  // ── client surface ────────────────────────────────────────────────────────

  route('GET', '/joy/v1/capabilities', { summary: 'Nucleus capabilities/version (no auth)', auth: false, doc: DOC_capabilities }, async () => CAPABILITIES);

  route('GET', '/joy/v1/sessions', { summary: 'List durable sessions', doc: DOC_listSessions }, async (ctx) => ({ sessions: await core.listSessions(ctx.accountId) }));

  route('POST', '/joy/v1/session-creations', { summary: 'Create a durable session (idempotent per actor)', doc: DOC_createSession }, async (ctx, m, body) => {
    need(body, 'creationIntentId', 'daemonId');
    if (body.mode === 'announce_existing') need(body, 'localSessionId', 'sessionKeyEnvelope');
    return core.createSession(ctx.accountId, ctx.actorId, body);
  });

  route('POST', '/joy/v1/sessions/([\\w-]+)/turns', { summary: 'Submit a turn to the durable queue', params: ['sessionId'], doc: DOC_submitTurn }, async (ctx, m, body) => {
    need(body, 'clientIntentId', 'ciphertext');
    return core.acceptPrompt(ctx.accountId, ctx.actorId, m[1], body);
  });

  route('POST', '/joy/v1/sessions/([\\w-]+)/turns/([\\w-]+)/cancellations', { summary: 'Cancel a queued/running turn', params: ['sessionId', 'turnId'], doc: DOC_cancelTurn }, async (ctx, m, body) => {
    need(body, 'clientIntentId');
    return core.acceptCancellation(ctx.accountId, ctx.actorId, m[1], m[2], body);
  });

  route('GET', '/joy/v1/sessions/([\\w-]+)/state', { summary: 'Session state snapshot', params: ['sessionId'], doc: DOC_sessionState }, async (ctx, m) => core.sessionState(ctx.accountId, m[1]));

  route('GET', '/joy/v1/sessions/([\\w-]+)/events', { summary: 'Session event log slice', params: ['sessionId'], doc: DOC_sessionEvents }, async (ctx, m, body, url) =>
    core.sessionEvents(ctx.accountId, m[1], url.searchParams.get('after_seq') ?? url.searchParams.get('afterSeq') ?? 0,
      url.searchParams.get('limit')));

  route('GET', '/joy/v1/events/stream', { summary: 'SSE event stream', sse: true, doc: DOC_sse }, async (ctx, m, body, url, req, res) => {
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

  route('POST', '/joy/v1/daemons/([\\w.-]+)/leases', { summary: 'Acquire a daemon lease', params: ['machineId'], doc: DOC_acquireLease }, async (ctx, m, body) =>
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

  route('PUT', '/joy/v1/daemon-leases/([\\w-]+)', { summary: 'Heartbeat/renew a lease (lease-token auth)', params: ['leaseId'], auth: false, doc: DOC_renewLease }, async (ctx, m, body, url, req) => {
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
  route('POST', '/joy/v1/daemon-leases/([\\w-]+)/claims/work', { summary: 'Long-poll claim work under a lease', params: ['leaseId'], auth: false, doc: DOC_claimWork }, claimHandler('work'));
  route('POST', '/joy/v1/daemon-leases/([\\w-]+)/claims/control', { summary: 'Long-poll claim control messages under a lease', params: ['leaseId'], auth: false, doc: DOC_claimControl }, claimHandler('control'));

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

  route('POST', '/joy/v1/deliveries/([\\w-]+)/received', { summary: 'Ack a delivery', params: ['deliveryId'], auth: false, doc: DOC_deliveryAck },
    withLeaseHeaders((lease, m) => core.deliveryReceived(m[1], lease).then(() => ({ ok: true }))));
  route('POST', '/joy/v1/sessions/([\\w-]+)/bind', { summary: 'Bind a daemon to a session', params: ['sessionId'], auth: false, doc: DOC_bind },
    withLeaseHeaders((lease, m, body) => {
      need(body, 'localSessionId', 'sessionKeyEnvelope');
      return core.bindSession(m[1], lease, body).then(() => ({ ok: true }));
    }));
  route('POST', '/joy/v1/turns/([\\w-]+)/submitted', { summary: 'Mark a turn submitted to the agent', params: ['turnId'], auth: false, doc: DOC_submitted },
    withLeaseHeaders((lease, m) => core.turnSubmitted(m[1], lease).then(() => ({ ok: true }))));
  route('POST', '/joy/v1/turns/([\\w-]+)/start', { summary: 'Mark a turn started', params: ['turnId'], auth: false, doc: DOC_start },
    withLeaseHeaders((lease, m, body) => core.turnStarted(m[1], lease, body ?? {})));
  route('POST', '/joy/v1/turns/([\\w-]+)/facts', { summary: 'Append turn facts (progress/results)', params: ['turnId'], auth: false, doc: DOC_facts },
    withLeaseHeaders((lease, m, body) => {
      need(body, 'type');
      return core.turnFact(m[1], lease, body);
    }));
  route('POST', '/joy/v1/turns/([\\w-]+)/reconcile', { summary: 'Reconcile turn state after a daemon restart', params: ['turnId'], auth: false, doc: DOC_reconcile },
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
    auth: r.opts.auth !== false, sse: r.opts.sse === true, doc: r.opts.doc ?? null,
  }));
  return { handle, routeTable };
}
