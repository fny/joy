// Browsable JOY relay API docs: GET /openapi.json + GET /docs (Redoc) on both
// entrypoints. Documents the /joy/v1 surface ONLY, generated from the live
// route table (routes.mjs routeTable()) so it cannot drift from dispatch.
// Everything outside /joy/v1 is upstream passthrough and deliberately absent.
// The perimeter gate wraps these like everything else once it's flipped.

const P = { type: 'object', additionalProperties: true };

/** /joy/v1 paths generated from the router's own table (routes.mjs
 *  routeTable()) — the docs cannot drift from dispatch. */
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
        'The joy relay API: durable sessions, turns, leases, deliveries, and events under /joy/v1. When the perimeter gate is enabled, every request additionally needs x-joy-relay-key (or ?joyRelayKey=). Machine-level operations (queue, pane, usage, limits, agent config…) live on each machine\'s joy-daemon — see its local /docs. Everything outside /joy/v1 is proxied untouched to the upstream store and is not part of this API.',
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
