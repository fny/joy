// Wave D (review campaign 2026-09) — server-side lows: docs scheme and
// embedded spec (#616, #617) and the token-secret bootstrap (#606).
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { handleDocs, docsConfig } from '../src/docs.mjs';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadOrCreateTokenSecret } from '../src/secret.mjs';

function fakeRes() {
  const res = { status: null, headers: null, body: '' };
  res.writeHead = (status, headers) => { res.status = status; res.headers = headers; };
  res.end = (body) => { res.body = body ?? ''; };
  return res;
}

describe('docs (#616, #617)', () => {
  const token = 'test-docs-token';
  const docs = { disabled: false, token, error: null };
  const routeTable = { routes: [{ method: 'GET', pattern: '/joy/v2/capabilities', auth: false, summary: 'probe', params: [] }] };

  // Caddy's reverse_proxy (infra/Caddyfile) sets For/Proto/Host together.
  const caddy = { 'x-forwarded-for': '203.0.113.9', 'x-forwarded-host': 'joy.example:4997' };
  // Proxied requests arrive over loopback (Caddy on the same box); a direct
  // client comes from elsewhere.
  const LOOP = { remoteAddress: '127.0.0.1' };
  const DIRECT = { remoteAddress: '203.0.113.9' };
  const serverUrl = (headers, socket = LOOP, opts = {}) => {
    const res = fakeRes();
    handleDocs({ method: 'GET', url: `/openapi.json?token=${token}`, headers, socket }, res, { version: 't', routeTable, docs, ...opts });
    expect(res.status).toBe(200);
    return JSON.parse(res.body).servers[0].url;
  };

  it('#617 the advertised server matches the scheme the request arrived on', () => {
    expect(serverUrl({ host: 'localhost:3105' })).toBe('http://localhost:3105');
    expect(serverUrl({ host: 'joy.example:4997', 'x-forwarded-proto': 'https', ...caddy })).toBe('https://joy.example:4997');
    expect(serverUrl({ host: 'joy.example' }, { ...LOOP, encrypted: true })).toBe('https://joy.example');
  });

  it('#617 x-forwarded-proto is validated: only http/https, first of a comma list, case-insensitive', () => {
    expect(serverUrl({ host: 'h', 'x-forwarded-proto': 'bogus', ...caddy })).toBe('http://h');
    expect(serverUrl({ host: 'h', 'x-forwarded-proto': 'javascript:', ...caddy }, { ...LOOP, encrypted: true })).toBe('https://h');
    expect(serverUrl({ host: 'h', 'x-forwarded-proto': 'HTTPS', ...caddy })).toBe('https://h');
    expect(serverUrl({ host: 'h', 'x-forwarded-proto': 'https, http', ...caddy })).toBe('https://h');
    expect(serverUrl({ host: 'h', 'x-forwarded-proto': 'http', ...caddy }, { ...LOOP, encrypted: true })).toBe('http://h');
    expect(serverUrl({ host: 'h', 'x-forwarded-proto': '', ...caddy })).toBe('http://h');
  });

  it('#617 x-forwarded-proto is honoured only from the proxy (loopback), or when JOY_RELAY_TRUST_PROXY says so', () => {
    // A direct client cannot promote itself to https, whatever headers it sends
    // (Astra on 17708012: forwarded-for/host are client-controlled too).
    expect(serverUrl({ host: 'h', 'x-forwarded-proto': 'https' }, DIRECT)).toBe('http://h');
    expect(serverUrl({ host: 'h', 'x-forwarded-proto': 'https', 'x-forwarded-for': '127.0.0.1' }, DIRECT)).toBe('http://h');
    expect(serverUrl({ host: 'h', 'x-forwarded-proto': 'https', 'x-forwarded-host': 'h' }, DIRECT)).toBe('http://h');
    // The proxy on the same box is trusted by address.
    expect(serverUrl({ host: 'h', 'x-forwarded-proto': 'https' }, LOOP)).toBe('https://h');
    expect(serverUrl({ host: 'h', 'x-forwarded-proto': 'https' }, { remoteAddress: '::1' })).toBe('https://h');
    // Explicit overrides win in both directions; validation still applies.
    expect(serverUrl({ host: 'h', 'x-forwarded-proto': 'https' }, DIRECT, { trustProxy: true })).toBe('https://h');
    expect(serverUrl({ host: 'h', 'x-forwarded-proto': 'https', ...caddy }, LOOP, { trustProxy: false })).toBe('http://h');
    expect(serverUrl({ host: 'h', 'x-forwarded-proto': 'bogus' }, DIRECT, { trustProxy: true })).toBe('http://h');
  });

  it('#616 the docs page embeds its specification instead of fetching it without the perimeter key', () => {
    const res = fakeRes();
    handleDocs({ method: 'GET', url: `/docs?token=${token}&joyRelayKey=k`, headers: { host: 'localhost:3105' }, socket: {} }, res, { version: 't', routeTable, docs });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).not.toContain('spec-url=');
    expect(res.body).toContain('Redoc.init(');
    expect(res.body).toContain('"/joy/v2/capabilities"');
    expect(res.body).not.toMatch(/<\/script>[^]*<\/script>[^]*<\/script>[^]*<\/script>/); // JSON is script-safe
  });
});

describe('the docs token is required at launch unless the docs are switched off', () => {
  const req = (url) => ({ method: 'GET', url, headers: { host: 'localhost:3105' }, socket: {} });
  const routeTable = { routes: [] };

  it('no token and no opt-out is a launch error — there is no built-in token any more', () => {
    for (const env of [{}, { JOY_RELAY_DOCS_TOKEN: '' }, { JOY_RELAY_DOCS_TOKEN: '   ' }]) {
      const c = docsConfig(env);
      expect(c.error).toMatch(/JOY_RELAY_DOCS_TOKEN is not set/);
      expect(c.error).toMatch(/JOY_RELAY_DOCS=off/);
    }
  });

  it('a configured token is the only one that opens the docs', () => {
    const docs = docsConfig({ JOY_RELAY_DOCS_TOKEN: 's3cret-docs' });
    expect(docs).toEqual({ disabled: false, token: 's3cret-docs', error: null });
    const ok = fakeRes();
    expect(handleDocs(req('/openapi.json?token=s3cret-docs'), ok, { version: 't', routeTable, docs })).toBe(true);
    expect(ok.status).toBe(200);
    for (const wrong of ['/openapi.json?token=farazyashar', '/openapi.json', '/docs?token=nope']) {
      const res = fakeRes();
      handleDocs(req(wrong), res, { version: 't', routeTable, docs });
      expect(res.status, wrong).toBe(401);
    }
  });

  it('JOY_RELAY_DOCS=off serves no docs at all — the paths fall through to the router\'s 404', () => {
    for (const v of ['off', 'OFF', '0', 'false', 'no', 'disabled']) {
      const docs = docsConfig({ JOY_RELAY_DOCS: v, JOY_RELAY_DOCS_TOKEN: 'ignored' });
      expect(docs.disabled, v).toBe(true);
      expect(docs.error).toBeNull();
      expect(handleDocs(req('/docs?token=ignored'), fakeRes(), { version: 't', routeTable, docs })).toBe(false);
    }
  });

  it('server.mjs refuses to start without a docs token, before it touches the data directory', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'joy-relay-docs-'));
    try {
      const env = { ...process.env, JOY_RELAY_DATA_DIR: join(dataDir, 'relay'), JOY_RELAY_PORT: '0' };
      delete env.JOY_RELAY_DOCS_TOKEN; delete env.JOY_RELAY_DOCS;
      const server = fileURLToPath(new URL('../server.mjs', import.meta.url));
      const r = spawnSync(process.execPath, [server], { env, encoding: 'utf8', timeout: 20_000 });
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/refusing to start: JOY_RELAY_DOCS_TOKEN is not set/);
      expect(readdirSync(dataDir)).toEqual([]); // nothing created
    } finally { rmSync(dataDir, { recursive: true, force: true }); }
  });
});

describe('the relay stops cleanly on SIGTERM', () => {
  it('exits 0, closes the database and releases the data directory — a second relay starts on it right after', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'joy-relay-stop-'));
    const server = fileURLToPath(new URL('../server.mjs', import.meta.url));
    const env = { ...process.env, JOY_RELAY_DATA_DIR: join(dataDir, 'relay'), JOY_RELAY_PORT: '0', JOY_RELAY_DOCS: 'off' };
    const run = () => new Promise((resolve) => {
      const child = spawn(process.execPath, [server], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      const onData = (b) => {
        out += b;
        if (out.includes('[joy-relay] listening') && !child.killedBySim) { child.killedBySim = true; child.kill('SIGTERM'); }
      };
      child.stdout.on('data', onData); child.stderr.on('data', onData);
      const started = Date.now();
      child.on('exit', (code, signal) => resolve({ code, signal, out, ms: Date.now() - started }));
    });
    try {
      const first = await run();
      expect(first.out).toMatch(/SIGTERM: stopping/);
      expect(first.out).toMatch(/\[joy-relay\] stopped/);
      expect(first.signal).toBeNull();
      expect(first.code).toBe(0);
      const second = await run(); // the lock was released: no "already in use"
      expect(second.code).toBe(0);
      expect(second.out).not.toMatch(/lock|in use/i);
    } finally { rmSync(dataDir, { recursive: true, force: true }); }
  }, 60_000);
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
