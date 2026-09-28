// Browsable JOY relay API docs: GET /openapi.json + GET /docs (Redoc) on both
// entrypoints. The path table is generated from the live /joy/v2 route
// table (v2.mjs routeTable()) so it cannot drift from dispatch; the
// user-facing orientation lives in docs/reference/api.md.
// The perimeter gate wraps these like everything else once it's flipped.

import fs from 'node:fs';

const P = { type: 'object', additionalProperties: true };

// Request/response types for the routes the app calls, from the app's own
// TypeScript types (scripts/openapi-types/gen-relay.mjs; the relay is plain
// JavaScript and has none of its own). Matched to routes by method + path.
// A route's own `doc` block wins; /daemon/* routes have no typed caller.
const GENERATED = (() => {
  try { return JSON.parse(fs.readFileSync(new URL('./openapi.types.json', import.meta.url), 'utf8')); }
  catch { return { routes: [], schemas: {} }; }
})();

/** The generated types for a route-table entry, if a typed caller exists. */
function generatedFor(r) {
  const re = new RegExp(`^${r.pattern.replace(/^\/joy\/v2/, '')}$`);
  const hit = GENERATED.routes.find((g) => g.method === r.method && re.test(g.samplePath));
  return hit ? { body: hit.body, result: hit.result, sources: hit.sources } : null;
}

/** Paths generated from the router's own table — docs cannot drift from
 *  dispatch. Per-route `doc` blocks (body/result/errors) are optional. */
function nativePaths(routeTable) {
  const paths = {};
  for (const r of routeTable) {
    let i = 0;
    const path = r.pattern.replace(/\([^)]*\)/g, () => `{${r.params[i++] ?? `p${i}`}}`);
    const gen = r.doc ? null : generatedFor(r);
    const doc = r.doc ?? gen ?? {};
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
      ...(r.description || doc.description ? { description: r.description ?? doc.description } : {}),
      tags: [doc.tag ?? 'joy/v2'],
      ...(r.auth ? {} : { security: [] }),
      ...(r.sse ? { 'x-sse': true } : {}),
      ...(gen ? { 'x-types-from': gen.sources } : {}),
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
        'The joy relay stores sessions and passes messages between the app and the daemons on your machines. A conversation continues when a device disconnects, a daemon restarts or the relay restarts.',
        '',
        '## How it works',
        '- **Sessions.** The relay keeps a record and an event log for each session. The content is encrypted end to end. The relay stores it and passes it on, but cannot read it.',
        '- **Turns.** Each prompt becomes a turn. The relay queues it, and the daemon of the machine takes the turns one at a time, in order. A client can send the same request again safely: the relay does not repeat it.',
        '- **Leases.** One daemon at a time controls a machine through a lease. A new lease has a higher epoch, which locks out a daemon that crashed. After a restart, the daemon settles the turns that it left open.',
        '',
        '## Authentication',
        '- The app sends `Authorization: Bearer <account token>`.',
        '- A daemon sends its lease token in `x-joy-lease-token`. Writes that change a session or turn also send `x-joy-lease-id` and `x-joy-lease-epoch`.',
        '- If the relay requires a relay key, every request also sends `x-joy-relay-key` (or `?joyRelayKey=`). The key comes from the account secret.',
        '',
        'The daemon on each machine has its own API for machine operations, such as the queue, the pane and usage. Its `/docs` page describes it. Unknown paths return 404.',
      ].join('\n'),
    },
    servers: [{ url: host }],
    components: {
      schemas: GENERATED.schemas,
      securitySchemes: {
        bearer: { type: 'http', scheme: 'bearer', description: 'The account token from `POST /joy/v2/auth`.' },
        relayKey: { type: 'apiKey', in: 'header', name: 'x-joy-relay-key', description: 'The relay key. It is necessary only when the relay requires it. It comes from the account secret.' },
      },
    },
    security: [{ bearer: [] }],
    tags: [
      { name: 'joy/v2', description: 'Every route of the relay. The app uses the account token. The `/daemon/*` routes use the lease token.' },
      { name: 'Meta', description: 'Information about the relay itself.' },
      { name: 'Sessions', description: 'A session is the record of one agent conversation. Clients create sessions, list them and read their event logs. The event stream tells clients when something changes. All content is encrypted end to end.' },
      { name: 'Turns', description: 'A turn is one prompt from queue to result. Its states are queued, dispatching, running and terminal. A terminal turn is completed, failed, cancelled or interrupted. A turn cancelled before it starts never runs.' },
      { name: 'Daemon leases', description: 'A lease gives one daemon control of a machine. A lease lasts 20 seconds, so the daemon renews it all the time. The daemon waits for work and for cancellations on two separate lanes.' },
      { name: 'Daemon lifecycle', description: 'What the daemon reports back: deliveries it got, sessions it started, the progress and output of each turn, and turns that a restart left open. Each write carries the lease headers.' },
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

// Docs gate: a token on the URL (?token=…) so the API surface is not
// browsable by anyone who finds the port — a deterrent, not cryptography; the
// perimeter access key is the real lock. There is NO default: a relay must be
// told either its docs token (JOY_RELAY_DOCS_TOKEN) or that it serves no docs
// (JOY_RELAY_DOCS=off), and server.mjs refuses to start with neither. The
// built-in token it used to fall back to was one guessable string shared by
// every relay that never set its own.
const DISABLED = /^(off|0|false|no|disabled|none)$/i;

/** The docs configuration an environment describes: `disabled` (explicitly
 *  off), `token` (the configured password), or `error` (neither — the relay
 *  must not start). Pure, so the launch rule is testable without a server. */
export function docsConfig(env = process.env) {
  if (DISABLED.test(String(env.JOY_RELAY_DOCS ?? '').trim())) return { disabled: true, token: null, error: null };
  const token = String(env.JOY_RELAY_DOCS_TOKEN ?? '').trim();
  if (!token) {
    return {
      disabled: false, token: null,
      error: 'JOY_RELAY_DOCS_TOKEN is not set. Set it to the password for this relay\'s API docs (/docs?token=…), '
        + 'or set JOY_RELAY_DOCS=off to serve no API docs.',
    };
  }
  return { disabled: false, token, error: null };
}

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
  // Default trust is decided by WHERE the connection comes from, not by
  // client-controlled headers: Caddy proxies from the same box, so a request
  // with forwarded headers arriving over loopback is the proxy's; the same
  // headers on a non-loopback connection are a direct client lying about the
  // scheme (Astra on 17708012, #617). JOY_RELAY_TRUST_PROXY=1/0 overrides.
  const remote = String(req.socket?.remoteAddress ?? '');
  const fromLoopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1' || remote.startsWith('127.');
  const looksProxied = trustProxy === true || (trustProxy === undefined && fromLoopback);
  return looksProxied ? forwarded : socketScheme;
}

/** Handle /docs and /openapi.json; returns true when the request was ours.
 *  Runs AFTER the gate (callers check the gate first), so a flipped relay
 *  keys these like everything else. */
export function handleDocs(req, res, { version, routeTable = null, trustProxy = TRUST_PROXY, docs = docsConfig() }) {
  const url = req.url ?? '';
  const path = url.split('?')[0];
  if (req.method !== 'GET' || (path !== '/docs' && path !== '/openapi.json')) return false;
  // Docs switched off, or no token configured (server.mjs never starts that
  // way; a caller that embeds the router gets no docs rather than open ones):
  // not ours — the router answers 404 like any unknown path.
  if (docs.disabled || !docs.token) return false;
  const DOCS_TOKEN = docs.token;
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
  const host = `${scheme}://${req.headers.host ?? 'localhost'}`;
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
