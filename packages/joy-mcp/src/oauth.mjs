// OAuth 2.1 for one account. The Claude app's custom connectors discover the
// authorization server, register dynamically, and send the user to
// /authorize; the login there is the account's backup code, checked by
// deriving its signing key and comparing with the paired account — the code
// itself is never stored. Tokens are random, stored hashed, with a refresh
// path. Bearer tokens minted from the CLI (`joy-mcp token new`) live in the
// same store with no expiry, for Claude Code and scripts.
import { randomBytes, createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { InvalidRequestError, InvalidGrantError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { codeMatchesAccount } from './account.mjs';

const ACCESS_TTL_MS = 7 * 24 * 3600_000;
const REFRESH_TTL_MS = 180 * 24 * 3600_000;
const CODE_TTL_MS = 10 * 60_000;

const sha = (s) => createHash('sha256').update(s).digest('hex');
const fresh = () => randomBytes(32).toString('base64url');

export class FileStore {
  constructor(dir) {
    this.path = join(dir, 'oauth.json');
    this.data = existsSync(this.path) ? JSON.parse(readFileSync(this.path, 'utf8')) : { clients: {}, tokens: {} };
    this.data.clients ??= {}; this.data.tokens ??= {};
  }
  save() {
    writeFileSync(this.path, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    try { chmodSync(this.path, 0o600); } catch { /* umask */ }
  }
}

export class JoyOAuthProvider {
  /** @param {{ store: FileStore, account: { accountPublicKey: string } | null, loginPath?: string }} opts */
  constructor({ store, account, loginPath = '/authorize/login' }) {
    this.store = store;
    this.account = account;
    this.loginPath = loginPath;
    this.codes = new Map();     // code → { client, params, expiresAt }
    this.pendingLogins = new Map(); // login id → { client, params, expiresAt }
    this.clientsStore = {
      getClient: (id) => this.store.data.clients[id],
      registerClient: (client) => {
        const full = { ...client, client_id: randomUUID(), client_id_issued_at: Math.floor(Date.now() / 1000) };
        this.store.data.clients[full.client_id] = full;
        this.store.save();
        return full;
      },
    };
  }

  /** GET /authorize (validated by the SDK): show the login page. */
  async authorize(client, params, res) {
    if (!client.redirect_uris?.includes(params.redirectUri)) throw new InvalidRequestError('Unregistered redirect_uri');
    const id = fresh();
    this.pendingLogins.set(id, { client, params, expiresAt: Date.now() + CODE_TTL_MS });
    this.#sweep();
    res.status(200).type('html').send(loginPage({ loginId: id, clientName: client.client_name ?? client.client_id, action: this.loginPath }));
  }

  /** POST /authorize/login — the form. Returns { redirect } or { error }. */
  completeLogin({ loginId, code }) {
    const pending = this.pendingLogins.get(loginId);
    if (!pending || pending.expiresAt < Date.now()) return { error: 'This sign-in page expired. Start again from the connector.' };
    if (!this.account) return { error: 'This server is not paired to an account yet.' };
    if (!codeMatchesAccount(code, this.account)) return { error: 'That is not the backup code of the paired account.' };
    this.pendingLogins.delete(loginId);
    const authCode = fresh();
    this.codes.set(authCode, { client: pending.client, params: pending.params, expiresAt: Date.now() + CODE_TTL_MS });
    const target = new URL(pending.params.redirectUri);
    target.searchParams.set('code', authCode);
    if (pending.params.state !== undefined) target.searchParams.set('state', pending.params.state);
    return { redirect: target.toString() };
  }

  async challengeForAuthorizationCode(_client, authorizationCode) {
    const c = this.codes.get(authorizationCode);
    if (!c || c.expiresAt < Date.now()) throw new InvalidGrantError('Invalid or expired authorization code');
    return c.params.codeChallenge;
  }

  async exchangeAuthorizationCode(client, authorizationCode) {
    const c = this.codes.get(authorizationCode);
    if (!c || c.expiresAt < Date.now()) throw new InvalidGrantError('Invalid or expired authorization code');
    if (c.client.client_id !== client.client_id) throw new InvalidGrantError('Authorization code was issued to another client');
    this.codes.delete(authorizationCode);
    return this.#issue(client.client_id, c.params.scopes ?? [], c.params.resource?.toString());
  }

  async exchangeRefreshToken(client, refreshToken, scopes) {
    const rec = this.store.data.tokens[sha(refreshToken)];
    if (!rec || rec.type !== 'refresh' || rec.clientId !== client.client_id) throw new InvalidGrantError('Invalid refresh token');
    if (rec.expiresAt && rec.expiresAt < Date.now()) throw new InvalidGrantError('Refresh token expired');
    delete this.store.data.tokens[sha(refreshToken)];
    if (rec.access) delete this.store.data.tokens[rec.access];
    return this.#issue(client.client_id, scopes?.length ? scopes : rec.scopes, rec.resource);
  }

  #issue(clientId, scopes, resource) {
    const access = fresh(); const refresh = fresh();
    const now = Date.now();
    this.store.data.tokens[sha(access)] = { type: 'access', clientId, scopes, resource, issuedAt: now, expiresAt: now + ACCESS_TTL_MS };
    this.store.data.tokens[sha(refresh)] = { type: 'refresh', clientId, scopes, resource, issuedAt: now, expiresAt: now + REFRESH_TTL_MS, access: sha(access) };
    this.store.save();
    return { access_token: access, token_type: 'bearer', expires_in: Math.floor(ACCESS_TTL_MS / 1000), refresh_token: refresh, scope: scopes.join(' ') };
  }

  async verifyAccessToken(token) {
    const rec = this.store.data.tokens[sha(token)];
    if (!rec || (rec.type !== 'access' && rec.type !== 'bearer')) throw new InvalidTokenError('Invalid token');
    if (rec.expiresAt && rec.expiresAt < Date.now()) throw new InvalidTokenError('Token expired');
    // The SDK's bearer middleware insists on an expiry: a CLI-minted bearer
    // has none, so it reports one far away and stays valid until revoked.
    const expiresAt = Math.floor((rec.expiresAt ?? Date.now() + 10 * 365 * 24 * 3600_000) / 1000);
    return { token, clientId: rec.clientId, scopes: rec.scopes ?? [], expiresAt, ...(rec.resource ? { resource: new URL(rec.resource) } : {}), extra: { name: rec.name ?? rec.clientId } };
  }

  async revokeToken(_client, { token }) {
    delete this.store.data.tokens[sha(token)];
    this.store.save();
  }

  /** A long-lived bearer for a script or Claude Code. Returns the secret once. */
  mintBearer(name) {
    const token = fresh();
    this.store.data.tokens[sha(token)] = { type: 'bearer', clientId: `bearer:${name}`, name, scopes: [], issuedAt: Date.now(), expiresAt: null };
    this.store.save();
    return token;
  }
  listTokens() {
    return Object.entries(this.store.data.tokens).map(([h, t]) => ({ hash: h.slice(0, 8), type: t.type, client: t.name ?? t.clientId, issuedAt: t.issuedAt, expiresAt: t.expiresAt }));
  }
  /** Who a client is, for the provenance stamp on sends. */
  clientLabel(auth) {
    const c = this.store.data.clients[auth?.clientId];
    return (auth?.extra?.name ?? c?.client_name ?? auth?.clientId ?? 'client').replace(/[^A-Za-z0-9_.-]+/g, '-').slice(0, 40);
  }

  #sweep() {
    const now = Date.now();
    for (const [k, v] of this.pendingLogins) if (v.expiresAt < now) this.pendingLogins.delete(k);
    for (const [k, v] of this.codes) if (v.expiresAt < now) this.codes.delete(k);
  }
}

export function loginPage({ loginId, clientName, action, error }) {
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect to joy</title>
<style>
  body{margin:0;background:#0F1418;color:#E7ECF0;font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;display:grid;place-items:center;min-height:100vh}
  form{background:#161C22;border:1px solid #2A343E;border-radius:10px;padding:28px 30px;width:min(440px,92vw);display:flex;flex-direction:column;gap:14px}
  h1{font-size:20px;margin:0}p{margin:0;color:#A9B4BF}label{display:flex;flex-direction:column;gap:6px;font-size:13px;color:#A9B4BF}
  input{font:15px ui-monospace,SFMono-Regular,Menlo,monospace;padding:10px 12px;border-radius:6px;border:1px solid #2A343E;background:#0F1418;color:#E7ECF0}
  button{padding:10px 14px;border-radius:6px;border:0;background:#4CC4CF;color:#0B1518;font-weight:600;font-size:15px;cursor:pointer}
  .err{color:#FF9C95;font-size:13px}
</style>
<form method="post" action="${esc(action)}">
  <h1>Connect ${esc(clientName)} to joy</h1>
  <p>This gives it what the joy app has: every session on every machine. Paste the account's backup code to allow it.</p>
  ${error ? `<div class="err">${esc(error)}</div>` : ''}
  <input type="hidden" name="loginId" value="${esc(loginId)}">
  <label>Backup code<input name="code" autocomplete="off" autofocus required placeholder="XXXXX-XXXXX-…"></label>
  <button type="submit">Allow</button>
</form>`;
}
