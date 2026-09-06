import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDb } from '../src/db.mjs';

// #615: two relay processes on one data directory each had their own PGlite
// cache; the second close silently dropped the first's committed rows. The
// directory is now owned exclusively for the life of the handle.
describe('data directory lock (#615)', () => {
  it('refuses a second opener while the first holds the directory, then admits it after close', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'joy-relay-lock-'));
    const a = await openDb(dir);
    await expect(openDb(dir)).rejects.toThrow(/owned by pid/);
    await a.close();
    const b = await openDb(dir);
    await b.close();
    rmSync(dir, { recursive: true, force: true }); rmSync(`${dir}.lock`, { force: true });
  }, 60_000);

  it('one lock per canonical directory: dir and dir/. contend for the same lock', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'joy-relay-lock-'));
    const a = await openDb(dir);
    await expect(openDb(`${dir}/.`)).rejects.toThrow(/owned by pid/);
    await a.close();
    rmSync(dir, { recursive: true, force: true }); rmSync(`${dir}.lock`, { force: true });
  }, 60_000);

  it('a stale or half-written pid record never blocks: the OS lock died with its process', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'joy-relay-lock-'));
    writeFileSync(`${dir}.lock`, JSON.stringify({ pid: 2 ** 22 - 1, at: 'x' })); // no such pid, no live lock
    const a = await openDb(dir);
    await a.close();
    writeFileSync(`${dir}.lock`, ''); // a torn record, no live lock
    const b = await openDb(dir);
    await b.close();
    rmSync(dir, { recursive: true, force: true }); rmSync(`${dir}.lock`, { force: true }); rmSync(`${dir}.lock.db`, { force: true });
  }, 60_000);
});
