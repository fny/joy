// Browsable relay API docs: GET /openapi.json + GET /docs (Redoc) served by
// BOTH entrypoints (stable proxy + dev native). happy-server has no docs
// surface and the daemons' /docs are localhost-only, so this is the one
// reachable-from-anywhere view of what joy.voltai.party actually speaks:
// the happy-server passthrough surface (curated overview — happy-server is a
// pristine mirror we don't instrument) plus the native /joy/v1 nucleus.
// The perimeter gate wraps these like everything else once it's flipped.

const P = { type: 'object', additionalProperties: true };

function op(summary, opts = {}) {
  return {
    summary,
    tags: opts.tags ?? ['happy-server passthrough'],
    ...(opts.passthrough === false ? {} : { 'x-passthrough': 'happy-server' }),
    ...(opts.params ? { requestBody: { content: { 'application/json': { schema: opts.params } } } } : {}),
    responses: { 200: { description: 'Success', content: { 'application/json': { schema: opts.result ?? P } } } },
  };
}

function native(summary, opts = {}) {
  return op(summary, { ...opts, tags: ['joy/v1 (native)'], passthrough: false });
}

export function buildRelaySpec({ version, host }) {
  return {
    openapi: '3.1.0',
    info: {
      title: 'joy relay API',
      version,
      description:
        'What this host speaks: happy-server endpoints proxied byte-for-byte (curated overview — payloads are E2E-encrypted, the relay never reads them) plus the native /joy/v1 nucleus. Bearer tokens are issued by /v1/auth; when the perimeter gate is enabled every request additionally needs x-joy-relay-key (or ?joyRelayKey=). Machine-level operations (sessions, queue, pane, usage, limits, agent config…) live on each machine\'s joy-daemon — see its local /docs — and ride this relay as encrypted socket RPCs, not HTTP paths.',
    },
    servers: [{ url: host }],
    components: {
      securitySchemes: {
        bearer: { type: 'http', scheme: 'bearer', description: 'Account/machine token from /v1/auth' },
        relayKey: { type: 'apiKey', in: 'header', name: 'x-joy-relay-key', description: 'Perimeter key (only when the gate is enabled; derived from the account secret)' },
      },
    },
    security: [{ bearer: [] }],
    paths: {
      // ── happy-server passthrough (overview) ─────────────────────────────
      '/v1/auth': { post: op('Login or auto-create an account (challenge signed with the account key). No bearer needed.', {}) },
      '/v1/auth/request': { post: op('Terminal/device pairing: request approval for a fresh keypair') },
      '/v1/auth/response': { post: op('Approve a pairing request (encrypted key bundle)') },
      '/v1/sessions': { get: op('List account sessions (encrypted metadata rows)') },
      '/v3/sessions/{id}/messages': { get: op('Read session messages after a seq (encrypted rows, seq-ordered)') },
      '/v1/machines': { get: op('List registered machines (+ encrypted daemonState heartbeat)') },
      '/v1/push-tokens': { get: op('Registered Expo push tokens for the account') },
      '/v1/sessions/{id}/attachments/request-upload': { post: op('Attachment blob upload handshake → PUT/S3 target (10MB cap)') },
      '/v1/sessions/{id}/attachments/request-download': { post: op('Attachment blob download handshake → downloadUrl') },
      '/v1/updates': { get: op('socket.io endpoint: realtime rows + RPC forwarding (≈1MB message cap). Upgrade requests carry ?joyRelayKey= when gated.') },
      // ── native nucleus ──────────────────────────────────────────────────
      '/joy/v1/capabilities': { get: native('Nucleus capabilities/version (no auth)') },
      '/joy/v1/sessions': { get: native('List durable sessions') },
      '/joy/v1/session-creations': { post: native('Create a durable session') },
      '/joy/v1/sessions/{id}/turns': { post: native('Submit a turn to the durable queue') },
      '/joy/v1/sessions/{id}/turns/{turnId}/cancellations': { post: native('Cancel a queued/running turn') },
      '/joy/v1/sessions/{id}/state': { get: native('Session state snapshot') },
      '/joy/v1/sessions/{id}/events': { get: native('Session event log slice') },
      '/joy/v1/events/stream': { get: native('SSE event stream') },
      '/joy/v1/daemons/{machine}/leases': { post: native('Acquire a daemon lease') },
      '/joy/v1/daemon-leases/{leaseId}': { put: native('Heartbeat/renew a lease (lease-token auth)') },
      '/joy/v1/daemon-leases/{leaseId}/claims/work': { post: native('Claim work under a lease') },
      '/joy/v1/daemon-leases/{leaseId}/claims/control': { post: native('Claim control messages under a lease') },
      '/joy/v1/deliveries/{id}/received': { post: native('Ack a delivery') },
      '/joy/v1/sessions/{id}/bind': { post: native('Bind a daemon to a session') },
      '/joy/v1/turns/{id}/submitted': { post: native('Mark a turn submitted') },
      '/joy/v1/turns/{id}/start': { post: native('Mark a turn started') },
      '/joy/v1/turns/{id}/facts': { post: native('Append turn facts (progress/results)') },
      '/joy/v1/turns/{id}/reconcile': { post: native('Reconcile turn state after a daemon restart') },
    },
  };
}

const REDOC_PAGE = `<!doctype html><html><head><title>joy relay API</title>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{margin:0}</style></head><body>
<redoc spec-url="/openapi.json"></redoc>
<script src="https://cdn.redoc.ly/redoc/latest/bundles/redoc.standalone.js"></script>
</body></html>`;

/** Handle /docs and /openapi.json; returns true when the request was ours.
 *  Runs AFTER the gate (callers check the gate first), so a flipped relay
 *  keys these like everything else. */
export function handleDocs(req, res, { version }) {
  const path = (req.url ?? '').split('?')[0];
  if (req.method !== 'GET' || (path !== '/docs' && path !== '/openapi.json')) return false;
  const host = `https://${req.headers.host ?? 'joy.voltai.party:4997'}`;
  if (path === '/openapi.json') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(buildRelaySpec({ version, host })));
  } else {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(REDOC_PAGE);
  }
  return true;
}
