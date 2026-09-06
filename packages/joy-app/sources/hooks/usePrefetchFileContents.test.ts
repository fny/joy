import { describe, it, expect, vi, beforeEach } from 'vitest';

// The prefetch and the foreground (file panel / file screen) share ONE
// resource per file (sync/fileContents). These tests drive the real store
// with a controllable daemon read: the regression they guard is #325 — a
// prefetch that began before the user's read or save must not land its
// older contents over the newer version.

type ReadAnswer = { success: boolean; content?: string; error?: string };
const reads: Array<{ path: string; resolve: (a: ReadAnswer) => void }> = [];
const readFile = vi.fn((_sid: string, path: string) => new Promise<ReadAnswer>((resolve) => { reads.push({ path, resolve }); }));
const gitDiff = vi.fn(async () => ({ success: true, diff: '' }));
vi.mock('@/sync/ops', () => ({ sessionReadFile: (s: string, p: string) => readFile(s, p), sessionGitDiff: () => gitDiff() }));
vi.mock('@/sync/storage', () => ({ storage: { getState: () => ({ sessions: {} }) } }));

import { resources } from '@/sync/resource';
import { fileContentsKey, fileContentsSpec, type FileContents } from '@/sync/fileContents';
import { prefetchTargets, runPrefetch } from './usePrefetchFileContents';
import type { GitFileStatus } from '@/sync/gitStatusModel';

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
/** Answer the NEWEST pending read of `path` (the older one stays pending). */
const answer = (path: string, text: string) => {
    let i = -1;
    for (let k = reads.length - 1; k >= 0; k--) if (reads[k].path === path) { i = k; break; }
    if (i < 0) throw new Error(`no pending read for ${path}`);
    const [r] = reads.splice(i, 1);
    r.resolve({ success: true, content: b64(text) });
};
const asked = async (n: number) => { while (reads.length < n) await new Promise((r) => setTimeout(r, 0)); };
const contentOf = (sid: string, path: string) => resources.peek<FileContents>(fileContentsKey(sid, path)).data?.content;

let n = 0;
const session = () => `s${++n}`;
const ROOT = '/repo';
const row = (fullPath: string, extra: Partial<GitFileStatus> = {}): GitFileStatus => ({
    fileName: fullPath.split('/').pop()!, filePath: '', fullPath, displayPath: fullPath, utf8: true, unaddressable: false,
    status: 'modified', isStaged: false, lines: 'unavailable', binary: false, ...extra,
});

beforeEach(() => { reads.length = 0; });

describe('prefetch — the foreground wins over a prefetch that began earlier (#325)', () => {
    it('with nothing happening in between, the prefetch lands', async () => {
        const sid = session();
        const run = runPrefetch(sid, [{ absolutePath: `${ROOT}/a.txt`, diffPath: null }]);
        await asked(1);
        answer(`${ROOT}/a.txt`, 'from disk');
        await run;
        expect(contentOf(sid, `${ROOT}/a.txt`)).toBe('from disk');
    });

    it('a save after the prefetch began wins; the prefetch\'s older read is dropped', async () => {
        const sid = session();
        const run = runPrefetch(sid, [{ absolutePath: `${ROOT}/a.txt`, diffPath: null }]);
        await asked(1);
        // The file panel saves: the written version enters the resource.
        resources.setData<FileContents>(fileContentsKey(sid, `${ROOT}/a.txt`), { base64: b64('saved-new'), content: 'saved-new', isBinary: false });
        answer(`${ROOT}/a.txt`, 'old-prefetch');
        await run;
        expect(contentOf(sid, `${ROOT}/a.txt`)).toBe('saved-new');
    });

    it('a foreground read started after the prefetch supersedes it', async () => {
        const sid = session();
        const run = runPrefetch(sid, [{ absolutePath: `${ROOT}/a.txt`, diffPath: null }]);
        await asked(1);
        const foreground = resources.refresh(fileContentsSpec(sid, `${ROOT}/a.txt`));
        await asked(2);
        answer(`${ROOT}/a.txt`, 'foreground-read'); // the newer read lands first
        await foreground;
        expect(contentOf(sid, `${ROOT}/a.txt`)).toBe('foreground-read');
        answer(`${ROOT}/a.txt`, 'old-prefetch');    // then the older one
        await run;
        expect(contentOf(sid, `${ROOT}/a.txt`)).toBe('foreground-read');
    });

    it('a version written BEFORE the prefetch began is simply the cached value: no read at all', async () => {
        const sid = session();
        resources.setData<FileContents>(fileContentsKey(sid, `${ROOT}/a.txt`), { base64: b64('earlier'), content: 'earlier', isBinary: false });
        await runPrefetch(sid, [{ absolutePath: `${ROOT}/a.txt`, diffPath: null }]);
        expect(reads.length).toBe(0);
        expect(contentOf(sid, `${ROOT}/a.txt`)).toBe('earlier');
    });

    it('resources are per session and per path', async () => {
        const sid = session();
        const other = session();
        const run = runPrefetch(sid, [{ absolutePath: `${ROOT}/a.txt`, diffPath: null }, { absolutePath: `${ROOT}/b.txt`, diffPath: null }]);
        const runOther = runPrefetch(other, [{ absolutePath: `${ROOT}/a.txt`, diffPath: null }]);
        await asked(3);
        resources.setData<FileContents>(fileContentsKey(sid, `${ROOT}/a.txt`), { base64: b64('saved'), content: 'saved', isBinary: false });
        reads.slice().forEach((r) => answer(r.path, `disk:${r.path}`));
        await Promise.all([run, runOther]);
        expect(contentOf(sid, `${ROOT}/a.txt`)).toBe('saved');
        expect(contentOf(sid, `${ROOT}/b.txt`)).toBe(`disk:${ROOT}/b.txt`);
        expect(contentOf(other, `${ROOT}/a.txt`)).toBe(`disk:${ROOT}/a.txt`);
        expect(fileContentsKey(sid, `${ROOT}/a.txt`)).not.toBe(fileContentsKey(other, `${ROOT}/a.txt`));
    });

    it('an empty file is a file: content "" is cached, not treated as a failure', async () => {
        const sid = session();
        const run = runPrefetch(sid, [{ absolutePath: `${ROOT}/empty.txt`, diffPath: null }]);
        await asked(1);
        answer(`${ROOT}/empty.txt`, '');
        await run;
        expect(contentOf(sid, `${ROOT}/empty.txt`)).toBe('');
    });
});

describe('prefetch targets — only openable, text, addressable rows are read', () => {
    it('skips deleted, binary and unaddressable rows and lists a path once', () => {
        const targets = prefetchTargets([
            row('a.ts'),
            row('a.ts', { isStaged: true }),
            row('gone.ts', { status: 'deleted' }),
            row('logo.png'),
            row('��.bin\u0000raw:AAA=', { utf8: false, unaddressable: true }),
            row('sub/b.md', { status: 'untracked' }),
        ], ROOT);
        expect(targets).toEqual([
            { absolutePath: `${ROOT}/a.ts`, diffPath: 'a.ts' },
            { absolutePath: `${ROOT}/sub/b.md`, diffPath: 'sub/b.md' },
        ]);
    });
});
