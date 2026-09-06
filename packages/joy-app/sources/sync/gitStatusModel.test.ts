import { describe, it, expect } from 'vitest';
import { filesFromStructured, gitStatusFromStructured, mergeChangeRows, knownLines, sumLines, classifyGitStatusResponse, createRefreshScope, gitPathIdentity, type GitFileStatus } from './gitStatusModel';
import type { GitStatusEntryV2, GitStatusRepoV2, GitPathV2 } from './v2/machine';

const path = (cwd: string, over: Partial<GitPathV2> = {}): GitPathV2 => ({ repo: cwd, cwd, display: cwd, utf8: true, ...over });
const entry = (over: Partial<GitStatusEntryV2> & { path: GitPathV2 }): GitStatusEntryV2 => ({
    index: '.', worktree: '.', untracked: false, conflict: null, rename: null, submodule: false, binary: false,
    lines: { staged: { added: 0, removed: 0 }, unstaged: { added: 0, removed: 0 } },
    ...over,
});
const repo = (over: Partial<GitStatusRepoV2> = {}): GitStatusRepoV2 => ({
    v: 2, ok: true, relation: 'root', cwd: '/r',
    repository: { root: '/r', gitDir: '/r/.git', commonDir: '/r/.git', linkedWorktree: false, prefix: '' },
    head: { kind: 'branch', name: 'main', oid: 'abc' },
    upstream: null, operation: null, stashCount: 0, branches: [],
    entries: [],
    totals: { staged: { added: 0, removed: 0 }, unstaged: { added: 0, removed: 0 }, counts: { staged: 0, unstaged: 0, untracked: 0, conflicted: 0, entries: 0 } },
    clean: true,
    ...over,
});

describe('filesFromStructured', () => {
    it('splits one entry into its staged and unstaged rows with per-side counts', () => {
        const d = repo({
            entries: [entry({ path: path('src/a.ts'), index: 'M', worktree: 'M', lines: { staged: { added: 3, removed: 1 }, unstaged: { added: 2, removed: 0 } } })],
        });
        const f = filesFromStructured(d);
        expect(f.stagedFiles).toHaveLength(1);
        expect(f.unstagedFiles).toHaveLength(1);
        expect(f.stagedFiles[0]).toMatchObject({ fullPath: 'src/a.ts', displayPath: 'src/a.ts', fileName: 'a.ts', filePath: 'src', status: 'modified', isStaged: true, lines: { added: 3, removed: 1 } });
        expect(f.unstagedFiles[0]).toMatchObject({ isStaged: false, lines: { added: 2, removed: 0 } });
        expect(f.branch).toBe('main');
        expect(f.head).toBe('branch');
    });

    it('keeps identity and display apart: the row is opened by cwd, shown by display', () => {
        const d = repo({
            entries: [entry({ path: path('new\nline.txt', { display: 'new␊line.txt' }), untracked: true, index: '?', worktree: '?', binary: null, lines: { staged: { added: 0, removed: 0 }, unstaged: 'unavailable' } })],
        });
        const [f] = filesFromStructured(d).unstagedFiles;
        expect(f.fullPath).toBe('new\nline.txt');
        expect(f.displayPath).toBe('new␊line.txt');
        expect(f.fileName).toBe('new␊line.txt');
        expect(f.status).toBe('untracked');
        expect(f.lines).toBe('unavailable');
        expect(knownLines(f.lines)).toBeNull();
    });

    it('renames: destination is the row, source is carried (identity + display)', () => {
        const d = repo({
            entries: [entry({ path: path('new name.txt'), index: 'R', rename: { from: path('old name.txt'), score: 100, copy: false }, lines: { staged: { added: 1, removed: 0 }, unstaged: { added: 0, removed: 0 } } })],
        });
        const [f] = filesFromStructured(d).stagedFiles;
        expect(f).toMatchObject({ fullPath: 'new name.txt', status: 'renamed', oldPath: 'old name.txt', oldDisplayPath: 'old name.txt', lines: { added: 1, removed: 0 } });
        expect(filesFromStructured(d).unstagedFiles).toHaveLength(0);
    });

    it('AA / DD conflicts are conflicted rows in the worktree list, never staged rows', () => {
        const d = repo({
            entries: [
                entry({ path: path('both.txt'), index: 'A', worktree: 'A', conflict: { xy: 'AA' }, lines: { staged: 'unavailable', unstaged: 'unavailable' } }),
                entry({ path: path('gone.txt'), index: 'D', worktree: 'D', conflict: { xy: 'DD' }, lines: { staged: 'unavailable', unstaged: 'unavailable' } }),
            ],
            clean: false,
        });
        const f = filesFromStructured(d);
        expect(f.stagedFiles).toHaveLength(0);
        expect(f.unstagedFiles.map(x => [x.status, x.conflict])).toEqual([['conflicted', 'AA'], ['conflicted', 'DD']]);
    });

    it('binary flag rides along; detached and unborn heads', () => {
        const d = repo({ head: { kind: 'detached', oid: 'abc' }, entries: [entry({ path: path('img.png'), worktree: 'M', binary: true, lines: { staged: { added: 0, removed: 0 }, unstaged: 'unavailable' } })] });
        const f = filesFromStructured(d);
        expect(f.branch).toBeNull();
        expect(f.head).toBe('detached');
        expect(f.unstagedFiles[0].binary).toBe(true);
        const unborn = filesFromStructured(repo({ head: { kind: 'unborn', name: 'main' } }));
        expect(unborn.branch).toBe('main');
        expect(unborn.head).toBe('unborn');
    });

    it('two different non-UTF-8 names never collapse into one row; each is unaddressable (fd07ad20 residual #3)', () => {
        // Both byte strings decode lossily to the same "\uFFFD\uFFFD.bin", and
        // keying by that text merged two real files into one nonexistent one.
        const lossy = '\uFFFD\uFFFD.bin';
        const a = path(lossy, { utf8: false, rawBase64: Buffer.from([0xff, 0xfe, 0x2e, 0x62, 0x69, 0x6e]).toString('base64') });
        const b = path(lossy, { utf8: false, rawBase64: Buffer.from([0xfe, 0xff, 0x2e, 0x62, 0x69, 0x6e]).toString('base64') });
        const d = repo({
            entries: [
                entry({ path: a, index: 'M', worktree: 'M' }),
                entry({ path: b, untracked: true, index: '?', worktree: '?', binary: null, lines: { staged: { added: 0, removed: 0 }, unstaged: 'unavailable' } }),
            ],
            clean: false,
        });
        const f = filesFromStructured(d);
        const rows = mergeChangeRows(f.stagedFiles, f.unstagedFiles);
        expect(rows).toHaveLength(2);
        expect(new Set(rows.map(r => r.fullPath)).size).toBe(2);
        expect(rows.every(r => r.unaddressable && !r.utf8 && r.displayPath === lossy)).toBe(true);
        expect(rows.map(r => r.rawBase64)).toEqual([a.rawBase64, b.rawBase64]);
        // the SAME bytes on both sides are still one file
        expect(f.stagedFiles[0].fullPath).toBe(f.unstagedFiles[0].fullPath);
        expect(rows[0].status).toBe('modified');
        expect(rows[1].status).toBe('untracked');
        // a valid name is its own identity and is addressable
        expect(gitPathIdentity(path('src/a.ts'))).toBe('src/a.ts');
        expect(filesFromStructured(repo({ entries: [entry({ path: path('src/a.ts'), worktree: 'M' })] })).unstagedFiles[0]).toMatchObject({ utf8: true, unaddressable: false });
        // a non-UTF-8 identity can never equal a real path: it contains NUL
        expect(gitPathIdentity(a)).toContain('\u0000');
        expect(gitPathIdentity(a)).not.toBe(gitPathIdentity(b));
    });
});

describe('gitStatusFromStructured', () => {
    it('projects counts and totals; unavailable propagates to the total', () => {
        const d = repo({
            upstream: { name: 'origin/main', ahead: 2, behind: 0 },
            stashCount: 1,
            totals: { staged: { added: 5, removed: 1 }, unstaged: 'unavailable', counts: { staged: 1, unstaged: 2, untracked: 3, conflicted: 1, entries: 7 } },
            clean: false,
        });
        const s = gitStatusFromStructured(d, 42);
        expect(s).toEqual({
            branch: 'main', head: 'branch', isDirty: true,
            modifiedCount: 2, untrackedCount: 3, stagedCount: 1, conflictedCount: 1,
            stagedLines: { added: 5, removed: 1 }, unstagedLines: 'unavailable', totalLines: 'unavailable',
            lastUpdatedAt: 42,
            upstreamBranch: 'origin/main', aheadCount: 2, behindCount: 0, stashCount: 1,
        });
        expect(sumLines({ added: 1, removed: 2 }, { added: 3, removed: 4 })).toEqual({ added: 4, removed: 6 });
    });

    it('a conflict-only tree is dirty', () => {
        const s = gitStatusFromStructured(repo({ clean: false, totals: { staged: { added: 0, removed: 0 }, unstaged: { added: 0, removed: 0 }, counts: { staged: 0, unstaged: 0, untracked: 0, conflicted: 1, entries: 1 } } }));
        expect(s.isDirty).toBe(true);
        expect(s.conflictedCount).toBe(1);
    });
});

describe('mergeChangeRows', () => {
    const row = (over: Partial<GitFileStatus>): GitFileStatus => ({
        fileName: 'config.json', filePath: '', fullPath: 'config.json', displayPath: 'config.json', utf8: true, unaddressable: false,
        status: 'modified', isStaged: false, lines: 'unavailable', binary: false, ...over,
    });

    it('a staged deletion plus an untracked re-creation opens as the recreated file (#216)', () => {
        const rows = mergeChangeRows([row({ status: 'deleted', isStaged: true })], [row({ status: 'untracked' })]);
        expect(rows).toHaveLength(1);
        expect(rows[0].status).toBe('untracked');
    });

    it('a staged edit plus unstaged edits keeps the worktree row; distinct paths are all kept', () => {
        const rows = mergeChangeRows(
            [row({ status: 'modified', isStaged: true }), row({ fullPath: 'other.ts', status: 'added', isStaged: true })],
            [row({ status: 'modified' })],
        );
        expect(rows.map(r => [r.fullPath, r.isStaged])).toEqual([['config.json', false], ['other.ts', true]]);
    });

    it('a deletion that is the only record stays a deletion', () => {
        const rows = mergeChangeRows([row({ status: 'deleted', isStaged: true })], []);
        expect(rows[0].status).toBe('deleted');
    });

    it('a staged edit followed by a worktree deletion shows as deleted, not as an openable modified file (#216, fd07ad20 residual #4)', () => {
        const rows = mergeChangeRows(
            [row({ status: 'modified', isStaged: true, lines: { added: 3, removed: 0 } })],
            [row({ status: 'deleted', isStaged: false })],
        );
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ status: 'deleted', isStaged: false });
    });
});

describe('classifyGitStatusResponse', () => {
    it('an explicit relation:none is "not a repository" (authoritative: clears the list)', () => {
        expect(classifyGitStatusResponse({ status: 200, data: { v: 2, ok: true, relation: 'none', cwd: '/x' } })).toEqual({ kind: 'not-repo' });
    });

    it('a failed git command is unavailable, never "not a repository"', () => {
        const r = classifyGitStatusResponse({ status: 200, data: { v: 2, ok: false, code: 'git_failed', error: 'fatal: unable to mmap pack' } });
        expect(r.kind).toBe('unavailable');
        expect((r as { error: string }).error).toContain('unable to mmap pack');
    });

    it('no body or a non-200 answer is unavailable', () => {
        expect(classifyGitStatusResponse({ status: 200, data: null }).kind).toBe('unavailable');
        expect(classifyGitStatusResponse({ status: 502, data: null }).kind).toBe('unavailable');
        expect(classifyGitStatusResponse({ status: 500, data: repo() }).kind).toBe('unavailable');
    });

    it('a repository answer is a file list', () => {
        const r = classifyGitStatusResponse({ status: 200, data: repo({ entries: [entry({ path: path('a.ts'), worktree: 'M' })], clean: false }) });
        expect(r.kind).toBe('ok');
        expect((r as { files: { unstagedFiles: unknown[] } }).files.unstagedFiles).toHaveLength(1);
    });
});

describe('createRefreshScope', () => {
    it('latest wins: an older refresh for the same project may not publish', () => {
        const scope = createRefreshScope();
        const a = scope.begin('p');
        const b = scope.begin('p');
        expect(scope.isCurrent('p', a)).toBe(false);
        expect(scope.isCurrent('p', b)).toBe(true);
    });

    it('retire on blur/unmount: a refresh that completes afterwards writes nothing; the next focus starts fresh', () => {
        const scope = createRefreshScope();
        const g = scope.begin('p');
        scope.retire('p', g);
        expect(scope.isCurrent('p', g)).toBe(false);
        const again = scope.begin('p');
        expect(scope.isCurrent('p', again)).toBe(true);
    });

    it('retire is owner-specific: disposing screen A leaves screen B\'s newer refresh current (#316, fd07ad20 residual #5)', () => {
        // A starts, B starts, A is disposed: B must still publish when it
        // resolves — an unconditional retire left B unable to publish and
        // stuck on isFetching.
        const scope = createRefreshScope();
        const a = scope.begin('p');
        const b = scope.begin('p');
        scope.retire('p', a);
        expect(scope.isCurrent('p', b)).toBe(true);
        expect(scope.isCurrent('p', a)).toBe(false);
        // disposing B retires B; nothing older is resurrected
        scope.retire('p', b);
        expect(scope.isCurrent('p', b)).toBe(false);
        expect(scope.isCurrent('p', a)).toBe(false);
    });

    it('projects are independent', () => {
        const scope = createRefreshScope();
        const a = scope.begin('a');
        const b = scope.begin('b');
        scope.retire('b', b);
        expect(scope.isCurrent('a', a)).toBe(true);
    });
});
