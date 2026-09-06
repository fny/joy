// #606 residual: the atomic secret publish must honour SHORT WRITES. One
// writeSync whose return value was ignored could fsync and rename a truncated
// secret into place as a valid-looking one. node:fs is mocked here so the
// injection stays in its own file; everything else in the module is real.
import { describe, it, expect, vi, afterEach } from 'vitest';

const short = vi.hoisted(() => ({ plan: null, calls: [] }));
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal();
  return {
    ...fs,
    // Writes at most plan.shift() bytes per call when a plan is set (0 = a
    // write that makes no progress), by really writing only that many.
    writeSync(fd, buf, offset, length) {
      const cap = short.plan && short.plan.length ? short.plan.shift() : undefined;
      const n = cap === undefined ? length : Math.min(cap, length);
      short.calls.push({ asked: length, wrote: n });
      if (n === 0) return 0;
      return fs.writeSync(fd, buf, offset, n);
    },
  };
});

const { mkdtempSync, readFileSync, readdirSync, rmSync } = await import('node:fs');
const { join } = await import('node:path');
const { tmpdir } = await import('node:os');
const { loadOrCreateTokenSecret } = await import('../src/secret.mjs');

const quiet = { warn() {} };
const tmp = () => mkdtempSync(join(tmpdir(), 'joy-relay-secret-short-'));

afterEach(() => { short.plan = null; short.calls = []; });

describe('token secret short writes (#606)', () => {
  it('a short write is continued until every byte is on disk before the rename', () => {
    const dir = tmp();
    short.plan = [5, 7]; // first two calls truncated, the rest unrestricted
    const secret = 'a-secret-of-exactly-thirty-two-c'; // 32 bytes
    expect(loadOrCreateTokenSecret(dir, { env: {}, log: quiet, generate: () => secret })).toBe(secret);
    expect(short.calls.map((c) => c.wrote)).toEqual([5, 7, 20]);
    expect(readFileSync(join(dir, 'token.secret'), 'utf8')).toBe(secret);
    expect(readdirSync(dir)).toEqual(['token.secret']);
    // The next start reads the same secret back — nothing was truncated.
    expect(loadOrCreateTokenSecret(dir, { env: {}, log: quiet })).toBe(secret);
    rmSync(dir, { recursive: true, force: true });
  });

  it('a write that stops making progress (disk full) removes the temp file and throws; nothing is renamed', () => {
    const dir = tmp();
    short.plan = [4, 0, 0, 0, 0]; // 4 bytes land, then the disk is full
    const secret = 'another-secret-of-thirty-two-chr';
    expect(() => loadOrCreateTokenSecret(dir, { env: {}, log: quiet, generate: () => secret })).toThrow(/short write.*4 of 32 bytes/);
    expect(short.calls.length).toBe(2); // one truncated write, one zero-progress write — no spin
    expect(readdirSync(dir)).toEqual([]); // no token.secret, no leftover .tmp
    // Once the disk is fixed the next start publishes a complete secret.
    short.plan = null;
    const next = loadOrCreateTokenSecret(dir, { env: {}, log: quiet });
    expect(next.length).toBeGreaterThanOrEqual(16);
    expect(readFileSync(join(dir, 'token.secret'), 'utf8')).toBe(next);
    rmSync(dir, { recursive: true, force: true });
  });
});
