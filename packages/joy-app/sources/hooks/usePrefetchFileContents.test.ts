import { describe, it, expect, vi } from 'vitest';

// The cache the gate reads by default; tests below drive it directly.
type Entry = { content: string | null; cachedAt: number };
const cache: Record<string, Record<string, Entry>> = {};
const store = {
    sessionFileCache: cache,
    sessions: {},
    applyFileCache(sessionId: string, filePath: string, content: string | null) {
        cache[sessionId] = { ...(cache[sessionId] ?? {}), [filePath]: { content, cachedAt: Date.now() } };
    },
};
vi.mock('@/sync/storage', () => ({ storage: { getState: () => store } }));
vi.mock('@/sync/ops', () => ({ sessionReadFile: vi.fn(), sessionGitDiff: vi.fn() }));

import { fileCacheWriteKey, noteForegroundFileWrite, prefetchCommitGate } from './usePrefetchFileContents';

let n = 0;
const session = () => `s${++n}`;
const PATH = '/repo/a.txt';

describe('prefetch commit gate — the foreground wins over a prefetch that began earlier (#325)', () => {
    it('with nothing happening in between, the prefetch may commit', () => {
        const sid = session();
        const mayCommit = prefetchCommitGate(sid, PATH);
        expect(mayCommit()).toBe(true);
    });

    it('a save noted after the prefetch began closes the gate; the saved content survives', () => {
        const sid = session();
        const mayCommit = prefetchCommitGate(sid, PATH);

        // The file screen saves: 'saved-new' is on disk, the cache reflects it.
        store.applyFileCache(sid, PATH, 'saved-new');
        noteForegroundFileWrite(sid, PATH);

        // The prefetch's read (from before the save) lands.
        if (mayCommit()) store.applyFileCache(sid, PATH, 'old-prefetch');
        expect(cache[sid][PATH].content).toBe('saved-new');
    });

    it('a save that only bumps the write generation (no cache write) still closes the gate', () => {
        const sid = session();
        const mayCommit = prefetchCommitGate(sid, PATH);
        noteForegroundFileWrite(sid, PATH);
        expect(mayCommit()).toBe(false);
    });

    it('a foreground read landing in the cache closes the gate even without a generation bump', () => {
        const sid = session();
        const mayCommit = prefetchCommitGate(sid, PATH);
        store.applyFileCache(sid, PATH, 'foreground-read');
        expect(mayCommit()).toBe(false);
        expect(cache[sid][PATH].content).toBe('foreground-read');
    });

    it('writes from BEFORE the prefetch began do not close it', () => {
        const sid = session();
        store.applyFileCache(sid, PATH, 'earlier');
        noteForegroundFileWrite(sid, PATH);
        const mayCommit = prefetchCommitGate(sid, PATH);
        expect(mayCommit()).toBe(true);
    });

    it('gates are per session and per path', () => {
        const sid = session();
        const other = session();
        const a = prefetchCommitGate(sid, PATH);
        const b = prefetchCommitGate(sid, '/repo/b.txt');
        const c = prefetchCommitGate(other, PATH);
        noteForegroundFileWrite(sid, PATH);
        expect(a()).toBe(false);
        expect(b()).toBe(true);
        expect(c()).toBe(true);
        expect(fileCacheWriteKey(sid, PATH)).not.toBe(fileCacheWriteKey(other, PATH));
    });

    it('accepts an injected entry reader', () => {
        const sid = session();
        let entry: unknown = undefined;
        const mayCommit = prefetchCommitGate(sid, PATH, () => entry);
        expect(mayCommit()).toBe(true);
        entry = { content: 'x' };
        expect(mayCommit()).toBe(false);
    });
});
