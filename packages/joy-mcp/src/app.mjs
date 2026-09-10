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
  app.set('trust proxy', true);
  app.use(express.json({ limit: '4mb' }));
  app.use(express.urlencoded({ extended: false }));

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
        if (sid || !isInitializeRequest(req.body)) {
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
    if (!transport) { res.status(400).send('Invalid or missing session ID'); return; }
    await transport.handleRequest(req, res);
  };
  app.post('/mcp', auth, post);
  app.get('/mcp', auth, getOrDelete);
  app.delete('/mcp', auth, getOrDelete);

  app.get('/healthz', (_req, res) => res.json({ ok: true, sessions: hub.index.rows.size, connections: hub.connections.size, mcp_sessions: transports.size }));
  return app;
}
