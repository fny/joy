// Browsable JOY relay API docs: GET /openapi.json + GET /docs (Redoc) on both
// entrypoints. The path table is generated from the live /joy/v2 route
// table (v2.mjs routeTable()) so it cannot drift from dispatch; the
// narrative for each surface lives in docs/API.md.
// The perimeter gate wraps these like everything else once it's flipped.

const P = { type: 'object', additionalProperties: true };

/** Paths generated from the router's own table — docs cannot drift from
 *  dispatch. Per-route `doc` blocks (body/result/errors) are optional. */
function nativePaths(routeTable) {
  const paths = {};
  for (const r of routeTable) {
    let i = 0;
    const path = r.pattern.replace(/\([^)]*\)/g, () => `{${r.params[i++] ?? `p${i}`}}`);
    const doc = r.doc ?? {};
    const parameters = [
      ...(r.params ?? []).map((name) => ({ name, in: 'path', required: true, schema: { type: 'string' } })),
      ...Object.entries(doc.query ?? {}).map(([name, schema]) => ({ name, in: 'query', required: false, schema })),
      ...(doc.headers ?? []).map((h) => {
        const [name, ...rest] = h.split(' ');
        return { name, in: 'header', required: !rest.join(' ').includes('optional'), description: rest.join(' ').replace(/[()]/g, ''), schema: { type: 'string' } };
      }),
    ];
    const responses = {
      200: { description: 'Success', content: doc.result?.type === 'string'
        ? { 'text/event-stream': { schema: { type: 'string', description: doc.result.description } } }
        : { 'application/json': { schema: doc.result ?? P } } },
      ...Object.fromEntries(Object.entries(doc.errors ?? {}).map(([code, what]) => [
        code, { description: what, content: { 'application/json': { schema: { type: 'object', properties: { error: { type: 'string', example: String(what).split(' ')[0] } } } } } },
      ])),
    };
    if (r.auth) responses[401] = { description: 'Missing or invalid bearer token' };
    (paths[path] ??= {})[r.method.toLowerCase()] = {
      summary: r.summary,
      ...(doc.description ? { description: doc.description } : {}),
      tags: [doc.tag ?? 'joy/v2'],
      ...(r.auth ? {} : { security: [] }),
      ...(r.sse ? { 'x-sse': true } : {}),
      parameters,
      ...(doc.body && r.method !== 'GET' ? { requestBody: { required: true, content: { 'application/json': { schema: doc.body } } } } : {}),
      responses,
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
      description: [
        'The joy relay\'s durable session protocol. Everything a client or daemon needs to run agent conversations that survive disconnects, daemon restarts, and relay failover — without either side trusting the other\'s liveness.',
        '',
        '## The model',
        '- **Sessions** are relay-owned records with an append-only, seq-ordered event log. All content is E2E ciphertext; the relay stores and forwards, never reads.',
        '- **Turns** are durable prompts: queued at the relay, claimed by the owning daemon, executed strictly in order, closed with a terminal fact. Every client write is idempotent via clientIntentId + request hash — retries replay, altered retries are rejected.',
        '- **Leases** give one daemon process exclusive control of a machine identity. Epochs fence out crashed predecessors; orphaned turns are resolved explicitly via reconcile.',
        '',
        '## Auth',
        '- Client surface: `Authorization: Bearer <account token>`.',
        '- Daemon surface: the lease token (`x-joy-lease-token`, plus `x-joy-lease-id` / `x-joy-lease-epoch` on lifecycle writes) — never the bearer.',
        '- When the perimeter gate is enabled, EVERY request additionally carries `x-joy-relay-key` (or `?joyRelayKey=`), derived from the account secret.',
        '',
        'Machine-level operations (queue, pane, usage, limits, agent config…) are the joy-daemon\'s API — see its local /docs on each machine. The /joy/v2 account, session, attachment and tunnel surface is described in docs/API.md; there is no upstream — unknown paths are 404.',
      ].join('\n'),
    },
    servers: [{ url: host }],
    components: {
      securitySchemes: {
        bearer: { type: 'http', scheme: 'bearer', description: 'Account token from POST /joy/v2/auth' },
        relayKey: { type: 'apiKey', in: 'header', name: 'x-joy-relay-key', description: 'Perimeter key (only when the gate is enabled; derived from the account secret)' },
      },
    },
    security: [{ bearer: [] }],
    tags: [
      { name: 'joy/v2', description: 'Every route the relay serves. Client surface uses the account bearer; daemon-surface routes (/daemon/*) use the lease token.' },
      { name: 'Meta', description: 'Protocol discovery.' },
      { name: 'Sessions', description: 'Durable sessions: the relay-owned record of each agent conversation. Clients create, list, snapshot, and page the append-only event log; the SSE stream pushes change pokes. Content is E2E ciphertext throughout.' },
      { name: 'Turns', description: 'The durable prompt queue. A turn is one prompt\'s lifecycle: queued → dispatching → running → terminal (completed | failed | cancelled | interrupted). Cancel-before-start is airtight; cancel-while-running rides the control lane.' },
      { name: 'Daemon leases', description: 'How a machine\'s daemon takes exclusive, crash-safe control: epoch-fenced leases (TTL 20s, renew constantly) and two long-poll claim lanes — WORK (spawns + head prompts) and CONTROL (cancels, never stuck behind work).' },
      { name: 'Daemon lifecycle', description: 'Fenced write-backs from the executing daemon: ack deliveries, bind spawned sessions, flip turns through submitted/started, stream facts (receipt / output / terminal), and reconcile orphans after a restart. All fenced by the x-joy-lease-* header triplet inside each transaction.' },
    ],
    'x-tagGroups': [
      { name: 'Routes', tags: ['joy/v2'] },
      { name: 'Concepts', tags: ['Meta', 'Sessions', 'Turns', 'Daemon leases', 'Daemon lifecycle'] },
    ],
    paths: nativePaths(routeTable?.routes ?? []),
  };
}

// The specification is EMBEDDED in the page rather than fetched: a second
// request would have to carry both the docs token and the perimeter key the
// page was opened with, and the generated URL carried only the token — under
// a flipped gate the spec fetch got 401 and the docs never loaded (#616).
// The already-authorized page is the only request there is.
const redocPage = (spec) => `<!doctype html><html><head><title>joy relay API</title>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{margin:0}</style></head><body>
<div id="redoc"></div>
<script src="https://cdn.redoc.ly/redoc/latest/bundles/redoc.standalone.js"></script>
<script>Redoc.init(${JSON.stringify(spec).replace(/</g, '\\u003c')}, {}, document.getElementById('redoc'));</script>
</body></html>`;

// Docs gate: a deliberately-simple token so the API surface isn't browsable
// by anyone who finds the port (deterrent, not cryptography — the perimeter
// gate is the real lock once flipped). ?token=… on the URL; override via
// JOY_RELAY_DOCS_TOKEN in the service env.
const DOCS_TOKEN = process.env.JOY_RELAY_DOCS_TOKEN || 'farazyashar';

/** JOY_RELAY_TRUST_PROXY: "1"/"true" always honours x-forwarded-proto,
 *  "0"/"false" never does; unset (the deployed default) uses the shape rule
 *  in requestScheme. */
const TRUST_PROXY = parseTrust(process.env.JOY_RELAY_TRUST_PROXY);
function parseTrust(v) {
  if (v === undefined || v === '') return undefined;
  return !/^(0|false|no|off)$/i.test(String(v).trim());
}

/** The scheme this request arrived on, for the advertised server URL.
 *  Hard-coding https made a plain-HTTP relay publish a server URL nothing
 *  served (#617); trusting any x-forwarded-proto let a direct client have the
 *  spec advertise `bogus://`. So:
 *    - only `http` / `https` count (first value of a comma list, lowercased);
 *      anything else falls back to the socket;
 *    - the header is honoured only when the request looks proxied. In
 *      production server.mjs listens on plain HTTP on 127.0.0.1 behind Caddy
 *      (infra/Caddyfile), whose reverse_proxy always sets X-Forwarded-For,
 *      X-Forwarded-Proto AND X-Forwarded-Host together — so by default we
 *      require an x-forwarded-for or x-forwarded-host alongside the proto. A
 *      lone x-forwarded-proto (a curl straight at :3105) is ignored.
 *      JOY_RELAY_TRUST_PROXY=1 honours the header unconditionally (a proxy
 *      that only forwards proto); =0 never honours it (no proxy at all).
 *  Nothing security-relevant hangs off this — it only decides which URL the
 *  OpenAPI document names as its server. */
export function requestScheme(req, trustProxy = TRUST_PROXY) {
  const socketScheme = req.socket?.encrypted ? 'https' : 'http';
  const h = req.headers ?? {};
  const forwarded = String(h['x-forwarded-proto'] ?? '').split(',')[0].trim().toLowerCase();
  if (forwarded !== 'http' && forwarded !== 'https') return socketScheme;
  const looksProxied = trustProxy === true
    || (trustProxy === undefined && (h['x-forwarded-for'] !== undefined || h['x-forwarded-host'] !== undefined));
  return looksProxied ? forwarded : socketScheme;
}

/** Handle /docs and /openapi.json; returns true when the request was ours.
 *  Runs AFTER the gate (callers check the gate first), so a flipped relay
 *  keys these like everything else. */
export function handleDocs(req, res, { version, routeTable = null, trustProxy = TRUST_PROXY }) {
  const url = req.url ?? '';
  const path = url.split('?')[0];
  if (req.method !== 'GET' || (path !== '/docs' && path !== '/openapi.json')) return false;
  const q = url.match(/[?&]token=([^&]+)/);
  // A malformed percent-escape (`?token=%`) made decodeURIComponent throw
  // out of the request callback — an unhandled rejection that took the relay
  // down from one unauthenticated request (issue #59). Invalid = wrong token.
  let candidate = null;
  try { candidate = q ? decodeURIComponent(q[1]) : null; } catch { candidate = null; }
  if (candidate === null || candidate !== DOCS_TOKEN) {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'docs token required (?token=…)' }));
    return true;
  }
  const scheme = requestScheme(req, trustProxy);
  const host = `${scheme}://${req.headers.host ?? 'joy.voltai.party:4997'}`;
  const spec = buildRelaySpec({ version, host, routeTable });
  if (path === '/openapi.json') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(spec));
  } else {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(redocPage(spec));
  }
  return true;
}
