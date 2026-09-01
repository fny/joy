// Browsable JOY relay API docs: GET /openapi.json + GET /docs (Redoc) on both
// entrypoints. Documents the /joy/v1 surface ONLY, generated from the live
// route table (routes.mjs routeTable()) so it cannot drift from dispatch.
// /joy/v2 (accounts, sessions, tunnel) is documented in docs/API.md; the
// generated table below covers the /joy/v1 nucleus routes.
// The perimeter gate wraps these like everything else once it's flipped.

const P = { type: 'object', additionalProperties: true };

/** /joy/v1 paths generated from the router's own table (routes.mjs
 *  routeTable() incl. per-route doc blocks) — docs cannot drift from
 *  dispatch, and every operation renders full request/response fields. */
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
      tags: [doc.tag ?? 'joy/v1'],
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
        'Machine-level operations (queue, pane, usage, limits, agent config…) are the joy-daemon\'s API — see its local /docs on each machine. The /joy/v2 account, session and tunnel surface is described in docs/API.md; there is no upstream — unknown paths are 404.',
      ].join('\n'),
    },
    servers: [{ url: host }],
    ...(routeTable?.served === false ? { 'x-note': 'On this instance /joy/v1 requests are currently served by the dev relay (:14997); the API below is identical.' } : {}),
    components: {
      securitySchemes: {
        bearer: { type: 'http', scheme: 'bearer', description: 'Account/machine token from /v1/auth' },
        relayKey: { type: 'apiKey', in: 'header', name: 'x-joy-relay-key', description: 'Perimeter key (only when the gate is enabled; derived from the account secret)' },
      },
    },
    security: [{ bearer: [] }],
    tags: [
      { name: 'Meta', description: 'Protocol discovery.' },
      { name: 'Sessions', description: 'Durable sessions: the relay-owned record of each agent conversation. Clients create, list, snapshot, and page the append-only event log; the SSE stream pushes change pokes. Content is E2E ciphertext throughout.' },
      { name: 'Turns', description: 'The durable prompt queue. A turn is one prompt\'s lifecycle: queued → dispatching → running → terminal (completed | failed | cancelled | interrupted). Cancel-before-start is airtight; cancel-while-running rides the control lane.' },
      { name: 'Daemon leases', description: 'How a machine\'s daemon takes exclusive, crash-safe control: epoch-fenced leases (TTL 20s, renew constantly) and two long-poll claim lanes — WORK (spawns + head prompts) and CONTROL (cancels, never stuck behind work).' },
      { name: 'Daemon lifecycle', description: 'Fenced write-backs from the executing daemon: ack deliveries, bind spawned sessions, flip turns through submitted/started, stream facts (receipt / output / terminal), and reconcile orphans after a restart. All fenced by the x-joy-lease-* header triplet inside each transaction.' },
    ],
    'x-tagGroups': [
      { name: 'Client surface', tags: ['Meta', 'Sessions', 'Turns'] },
      { name: 'Daemon surface', tags: ['Daemon leases', 'Daemon lifecycle'] },
    ],
    paths: nativePaths(routeTable?.routes ?? []),
  };
}

// The page's spec fetch must carry the same docs token it was opened with.
const redocPage = (docsToken) => `<!doctype html><html><head><title>joy relay API</title>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{margin:0}</style></head><body>
<redoc spec-url="/openapi.json?token=${encodeURIComponent(docsToken)}"></redoc>
<script src="https://cdn.redoc.ly/redoc/latest/bundles/redoc.standalone.js"></script>
</body></html>`;

// Docs gate: a deliberately-simple token so the API surface isn't browsable
// by anyone who finds the port (deterrent, not cryptography — the perimeter
// gate is the real lock once flipped). ?token=… on the URL; override via
// JOY_RELAY_DOCS_TOKEN in the service env.
const DOCS_TOKEN = process.env.JOY_RELAY_DOCS_TOKEN || 'farazyashar';

/** Handle /docs and /openapi.json; returns true when the request was ours.
 *  Runs AFTER the gate (callers check the gate first), so a flipped relay
 *  keys these like everything else. */
export function handleDocs(req, res, { version, routeTable = null }) {
  const url = req.url ?? '';
  const path = url.split('?')[0];
  if (req.method !== 'GET' || (path !== '/docs' && path !== '/openapi.json')) return false;
  const q = url.match(/[?&]token=([^&]+)/);
  if (!q || decodeURIComponent(q[1]) !== DOCS_TOKEN) {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'docs token required (?token=…)' }));
    return true;
  }
  const host = `https://${req.headers.host ?? 'joy.voltai.party:4997'}`;
  if (path === '/openapi.json') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(buildRelaySpec({ version, host, routeTable })));
  } else {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(redocPage(DOCS_TOKEN));
  }
  return true;
}
