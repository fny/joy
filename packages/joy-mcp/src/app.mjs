// The HTTP face: /mcp (Streamable HTTP, bearer-protected), the OAuth
// endpoints at the origin root, the login form, and a health probe. Caddy
// routes these paths on the relay origin to this process.
import express from 'express';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { createMcpServer } from './server.mjs';
import { loginPage } from './oauth.mjs';

/** @param {{ hub: import('./server.mjs').Hub, provider: import('./oauth.mjs').JoyOAuthProvider, publicUrl: string, log?: (s: string) => void }} opts */
export function createApp({ hub, provider, publicUrl, log = () => {} }) {
  const app = express();
  app.set('trust proxy', 1); // exactly one hop: caddy. `true` makes the SDK's rate limiter refuse to trust any IP.
  // The Claude app's connector setup runs in a browser: without CORS the 401
  // that carries WWW-Authenticate (how it discovers the OAuth server) is
  // unreadable and the UI says "no server responded". Every path gets it.
  // One line per request: who asked what, and how it ended — the only way
  // to tell a client that never arrived from one that arrived and was refused.
  app.use(express.json({ limit: '4mb' }));
  app.use(express.urlencoded({ extended: false }));
  app.use((req, res, next) => {
    const t0 = Date.now();
    res.on('finish', () => {
      const b = req.body;
      const rpc = b && typeof b === 'object' ? (Array.isArray(b) ? b.map((x) => x.method).join(',') : b.method ?? (b.result !== undefined ? 'result' : '-')) : '-';
      const tool = b && !Array.isArray(b) && b.method === 'tools/call' ? `:${b.params?.name}` : '';
      const sid = String(req.headers['mcp-session-id'] ?? '-').slice(0, 8);
      log(`${req.method} ${req.originalUrl.split('?')[0]} ${rpc}${tool} sid=${sid} → ${res.statusCode} ${Date.now() - t0}ms ip=${req.ip} ua=${String(req.headers['user-agent'] ?? '-').slice(0, 40)}`);
    });
    next();
  });
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID');
    res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id, Mcp-Protocol-Version, WWW-Authenticate');
    res.setHeader('Access-Control-Max-Age', '86400');
    if (req.method === 'OPTIONS') { res.status(204).end(); return; }
    next();
  });

  const issuer = new URL(publicUrl);
  const mcpUrl = new URL('/mcp', issuer);
  app.use(mcpAuthRouter({
    provider,
    issuerUrl: issuer,
    baseUrl: issuer,
    resourceServerUrl: mcpUrl,
    resourceName: 'joy',
    scopesSupported: ['joy'],
    clientRegistrationOptions: { clientSecretExpirySeconds: 0 },
  }));

  // RFC 9728 names the path-aware form (/.well-known/oauth-protected-resource/mcp);
  // some clients ask at the root first. Same document at both.
  app.get('/.well-known/oauth-protected-resource', (_req, res) => {
    res.json({ resource: mcpUrl.href, authorization_servers: [issuer.href], bearer_methods_supported: ['header'], resource_name: 'joy', scopes_supported: ['joy'] });
  });

  // The login form the authorize page posts to.
  app.post('/authorize/login', (req, res) => {
    const { loginId, code } = req.body ?? {};
    const r = provider.completeLogin({ loginId: String(loginId ?? ''), code: String(code ?? '') });
    if (r.redirect) { res.redirect(302, r.redirect); return; }
    res.status(400).type('html').send(loginPage({ loginId: String(loginId ?? ''), clientName: 'this client', action: '/authorize/login', error: r.error }));
  });

  const auth = requireBearerAuth({ verifier: provider, requiredScopes: [], resourceMetadataUrl: new URL('/.well-known/oauth-protected-resource/mcp', issuer).href });

  const transports = new Map(); // mcp session id → transport
  const post = async (req, res) => {
    const sid = req.headers['mcp-session-id'];
    try {
      let transport = sid ? transports.get(String(sid)) : undefined;
      if (!transport) {
        if (sid) {
          // A session this process does not know (a restart, or a client's
          // old id): 404 is what makes a client re-initialize on its own.
          res.status(404).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Session not found' }, id: null });
          return;
        }
        if (!isInitializeRequest(req.body)) {
          res.status(400).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Bad Request: no valid session id' }, id: null });
          return;
        }
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          enableDnsRebindingProtection: false,
          onsessioninitialized: (id) => { transports.set(id, transport); log(`mcp session ${id.slice(0, 8)} opened for ${provider.clientLabel(req.auth)}`); },
        });
        transport.onclose = () => { const id = transport.sessionId; if (id) transports.delete(id); };
        const server = createMcpServer(hub, { clientLabel: provider.clientLabel(req.auth) });
        await server.connect(transport);
      }
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      log(`mcp: ${e?.stack ?? e}`);
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
    }
  };
  const getOrDelete = async (req, res) => {
    const sid = req.headers['mcp-session-id'];
    const transport = sid ? transports.get(String(sid)) : undefined;
    if (!transport) { res.status(sid ? 404 : 400).send(sid ? 'Session not found' : 'Missing session ID'); return; }
    await transport.handleRequest(req, res);
  };
  app.post('/mcp', auth, post);
  app.get('/mcp', auth, getOrDelete);
  app.delete('/mcp', auth, getOrDelete);

  app.get('/healthz', (_req, res) => res.json({ ok: true, sessions: hub.index.rows.size, connections: hub.connections.size, mcp_sessions: transports.size }));
  return app;
}
