// Wave D (review campaign 2026-09) — server-side lows: docs scheme and
// embedded spec (#616, #617) and the token-secret bootstrap (#606).
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { handleDocs } from '../src/docs.mjs';
import { loadOrCreateTokenSecret } from '../src/secret.mjs';

function fakeRes() {
  const res = { status: null, headers: null, body: '' };
  res.writeHead = (status, headers) => { res.status = status; res.headers = headers; };
  res.end = (body) => { res.body = body ?? ''; };
  return res;
}

describe('docs (#616, #617)', () => {
  const token = process.env.JOY_RELAY_DOCS_TOKEN || 'farazyashar';
  const routeTable = { routes: [{ method: 'GET', pattern: '/joy/v2/capabilities', auth: false, summary: 'probe', params: [] }] };

  // Caddy's reverse_proxy (infra/Caddyfile) sets For/Proto/Host together.
  const caddy = { 'x-forwarded-for': '203.0.113.9', 'x-forwarded-host': 'joy.example:4997' };
  const serverUrl = (headers, socket = {}, opts = {}) => {
    const res = fakeRes();
    handleDocs({ method: 'GET', url: `/openapi.json?token=${token}`, headers, socket }, res, { version: 't', routeTable, ...opts });
    expect(res.status).toBe(200);
    return JSON.parse(res.body).servers[0].url;
  };

  it('#617 the advertised server matches the scheme the request arrived on', () => {
    expect(serverUrl({ host: 'localhost:3105' })).toBe('http://localhost:3105');
    expect(serverUrl({ host: 'joy.example:4997', 'x-forwarded-proto': 'https', ...caddy })).toBe('https://joy.example:4997');
    expect(serverUrl({ host: 'joy.example' }, { encrypted: true })).toBe('https://joy.example');
  });

  it('#617 x-forwarded-proto is validated: only http/https, first of a comma list, case-insensitive', () => {
    expect(serverUrl({ host: 'h', 'x-forwarded-proto': 'bogus', ...caddy })).toBe('http://h');
    expect(serverUrl({ host: 'h', 'x-forwarded-proto': 'javascript:', ...caddy }, { encrypted: true })).toBe('https://h');
    expect(serverUrl({ host: 'h', 'x-forwarded-proto': 'HTTPS', ...caddy })).toBe('https://h');
    expect(serverUrl({ host: 'h', 'x-forwarded-proto': 'https, http', ...caddy })).toBe('https://h');
    expect(serverUrl({ host: 'h', 'x-forwarded-proto': 'http', ...caddy }, { encrypted: true })).toBe('http://h');
    expect(serverUrl({ host: 'h', 'x-forwarded-proto': '', ...caddy })).toBe('http://h');
  });

  it('#617 x-forwarded-proto is honoured only when the request looks proxied, or JOY_RELAY_TRUST_PROXY says so', () => {
    // A lone x-forwarded-proto straight at the listener is ignored.
    expect(serverUrl({ host: 'h', 'x-forwarded-proto': 'https' })).toBe('http://h');
    // Either companion header Caddy sends is enough.
    expect(serverUrl({ host: 'h', 'x-forwarded-proto': 'https', 'x-forwarded-for': '203.0.113.9' })).toBe('https://h');
    expect(serverUrl({ host: 'h', 'x-forwarded-proto': 'https', 'x-forwarded-host': 'h' })).toBe('https://h');
    // Explicit trust: honour unconditionally / never.
    expect(serverUrl({ host: 'h', 'x-forwarded-proto': 'https' }, {}, { trustProxy: true })).toBe('https://h');
    expect(serverUrl({ host: 'h', 'x-forwarded-proto': 'https', ...caddy }, {}, { trustProxy: false })).toBe('http://h');
    // Validation still applies under explicit trust.
    expect(serverUrl({ host: 'h', 'x-forwarded-proto': 'bogus' }, {}, { trustProxy: true })).toBe('http://h');
  });

  it('#616 the docs page embeds its specification instead of fetching it without the perimeter key', () => {
    const res = fakeRes();
    handleDocs({ method: 'GET', url: `/docs?token=${token}&joyRelayKey=k`, headers: { host: 'localhost:3105' }, socket: {} }, res, { version: 't', routeTable });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).not.toContain('spec-url=');
    expect(res.body).toContain('Redoc.init(');
    expect(res.body).toContain('"/joy/v2/capabilities"');
    expect(res.body).not.toMatch(/<\/script>[^]*<\/script>[^]*<\/script>[^]*<\/script>/); // JSON is script-safe
  });
});

describe('token secret bootstrap (#606)', () => {
  const tmp = () => mkdtempSync(join(tmpdir(), 'joy-relay-secret-'));
  const quiet = { warn() {} };

  it('generates once, atomically, and reads the same secret back', () => {
    const dir = tmp();
    const a = loadOrCreateTokenSecret(dir, { env: {}, log: quiet });
    expect(a.length).toBeGreaterThanOrEqual(16);
    expect(readFileSync(join(dir, 'token.secret'), 'utf8')).toBe(a);
    expect(loadOrCreateTokenSecret(dir, { env: {}, log: quiet })).toBe(a);
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]); // no leftover temp file
    rmSync(dir, { recursive: true, force: true });
  });

  it('an empty file (interrupted first write) is regenerated instead of served', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'token.secret'), '');
    let warned = 0;
    const s = loadOrCreateTokenSecret(dir, { env: {}, log: { warn() { warned++; } } });
    expect(s.length).toBeGreaterThanOrEqual(16);
    expect(warned).toBe(1);
    expect(readFileSync(join(dir, 'token.secret'), 'utf8')).toBe(s);
    rmSync(dir, { recursive: true, force: true });
  });

  it('a non-empty unusable file is refused with the fix spelled out, never silently replaced', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'token.secret'), 'short');
    expect(() => loadOrCreateTokenSecret(dir, { env: {}, log: quiet })).toThrow(/at least 16.*JOY_RELAY_TOKEN_SECRET/);
    expect(readFileSync(join(dir, 'token.secret'), 'utf8')).toBe('short');
    rmSync(dir, { recursive: true, force: true });
  });

  it('a write that fails leaves the final path absent so the next start retries', () => {
    const dir = tmp();
    expect(() => loadOrCreateTokenSecret(dir, { env: {}, log: quiet, generate: () => { throw new Error('ENOSPC'); } })).toThrow(/ENOSPC/);
    expect(readdirSync(dir)).toEqual([]);
    expect(loadOrCreateTokenSecret(dir, { env: {}, log: quiet }).length).toBeGreaterThanOrEqual(16);
    rmSync(dir, { recursive: true, force: true });
  });

  it('the environment wins over the file', () => {
    const dir = tmp();
    expect(loadOrCreateTokenSecret(dir, { env: { JOY_RELAY_TOKEN_SECRET: 'from-the-service-env' }, log: quiet })).toBe('from-the-service-env');
    expect(readdirSync(dir)).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });
});
