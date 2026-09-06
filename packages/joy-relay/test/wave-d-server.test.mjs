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

  it('#617 the advertised server matches the scheme the request arrived on', () => {
    const plain = fakeRes();
    handleDocs({ method: 'GET', url: `/openapi.json?token=${token}`, headers: { host: 'localhost:3105' }, socket: {} }, plain, { version: 't', routeTable });
    expect(plain.status).toBe(200);
    expect(JSON.parse(plain.body).servers).toEqual([{ url: 'http://localhost:3105' }]);
    const proxied = fakeRes();
    handleDocs({ method: 'GET', url: `/openapi.json?token=${token}`, headers: { host: 'joy.example:4997', 'x-forwarded-proto': 'https' }, socket: {} }, proxied, { version: 't', routeTable });
    expect(JSON.parse(proxied.body).servers).toEqual([{ url: 'https://joy.example:4997' }]);
    const tls = fakeRes();
    handleDocs({ method: 'GET', url: `/openapi.json?token=${token}`, headers: { host: 'joy.example' }, socket: { encrypted: true } }, tls, { version: 't', routeTable });
    expect(JSON.parse(tls.body).servers).toEqual([{ url: 'https://joy.example' }]);
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
