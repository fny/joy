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

/** /joy/v1 paths generated from the router's own table (routes.mjs
 *  routeTable()) — the docs cannot drift from dispatch. Absent table (the
 *  stable proxy runs no nucleus) → no native section is advertised. */
function nativePaths(routeTable) {
  const paths = {};
  for (const r of routeTable) {
    let i = 0;
    const path = r.pattern.replace(/\([^)]*\)/g, () => `{${r.params[i++] ?? `p${i}`}}`);
    (paths[path] ??= {})[r.method.toLowerCase()] = {
      summary: r.summary,
      tags: ['joy/v1 (native)'],
      ...(r.auth ? {} : { security: [] }),
      ...(r.sse ? { 'x-sse': true } : {}),
      parameters: (r.params ?? []).map((name) => ({ name, in: 'path', required: true, schema: { type: 'string' } })),
      responses: { 200: { description: 'Success', content: { 'application/json': { schema: P } } } },
    };
  }
  return paths;
}

export function buildRelaySpec({ version, host, routeTable = null }) {
  return {
    openapi: '3.1.0',
    info: {
      title: 'joy relay API',
      version,
      description:
        'What this host speaks: happy-server endpoints proxied byte-for-byte (curated overview — payloads are E2E-encrypted, the relay never reads them) plus the native /joy/v1 nucleus. Bearer tokens are issued by /v1/auth; when the perimeter gate is enabled every request additionally needs x-joy-relay-key (or ?joyRelayKey=). Machine-level operations (sessions, queue, pane, usage, limits, agent config…) live on each machine\'s joy-daemon — see its local /docs — and ride this relay as encrypted socket RPCs, not HTTP paths.',
    },
    servers: [{ url: host }],
    'x-passthrough-note': 'The happy-server section is a CURATED OVERVIEW — upstream is a pristine mirror that publishes no spec, so it cannot be generated. /joy/v1 is generated from the live route table.'
      + (routeTable ? '' : ' This instance runs NO native nucleus (stable passthrough) — /joy/v1 is served by the dev relay (:14997).'),
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
      // ── native nucleus: generated from the live route table ─────────────
      ...(routeTable ? nativePaths(routeTable) : {}),
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
export function handleDocs(req, res, { version, routeTable = null }) {
  const path = (req.url ?? '').split('?')[0];
  if (req.method !== 'GET' || (path !== '/docs' && path !== '/openapi.json')) return false;
  const host = `https://${req.headers.host ?? 'joy.voltai.party:4997'}`;
  if (path === '/openapi.json') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(buildRelaySpec({ version, host, routeTable })));
  } else {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(REDOC_PAGE);
  }
  return true;
}
