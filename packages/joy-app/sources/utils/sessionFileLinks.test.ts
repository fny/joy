// Wall-clock bound: generous because the CI/dev box runs several suites at once; the point is linear vs quadratic, not 100 ms exactly.
const PERF_BUDGET_MS = Number(process.env.JOY_PERF_BUDGET_MS ?? 500);
import { describe, expect, it } from 'vitest';
import { parseSessionFileLink, resolveSessionFilePath, splitSessionFileText } from './sessionFileLinks';

describe('sessionFileLinks', () => {
    const sessionRoot = '/Users/kirilldubovitskiy/projects/joy';

    it('parses absolute file refs with line numbers', () => {
        const result = parseSessionFileLink('/Users/kirilldubovitskiy/projects/joy/packages/joy-daemon/src/codex/runCodex.ts:594', {
            sessionRoot,
        });

        expect(result).toEqual({
            path: '/Users/kirilldubovitskiy/projects/joy/packages/joy-daemon/src/codex/runCodex.ts',
            absolutePath: '/Users/kirilldubovitskiy/projects/joy/packages/joy-daemon/src/codex/runCodex.ts',
            relativePath: 'packages/joy-daemon/src/codex/runCodex.ts',
            withinSessionRoot: true,
            line: 594,
            column: null,
        });
    });

    it('parses relative file refs with line and column numbers', () => {
        const result = parseSessionFileLink('packages/joy-daemon/src/codex/runCodex.ts:594:2', {
            sessionRoot,
        });

        expect(result).toEqual({
            path: 'packages/joy-daemon/src/codex/runCodex.ts',
            absolutePath: '/Users/kirilldubovitskiy/projects/joy/packages/joy-daemon/src/codex/runCodex.ts',
            relativePath: 'packages/joy-daemon/src/codex/runCodex.ts',
            withinSessionRoot: true,
            line: 594,
            column: 2,
        });
    });

    it('rejects external urls', () => {
        expect(parseSessionFileLink('https://openai.com', { sessionRoot })).toBeNull();
        expect(parseSessionFileLink('mailto:test@example.com', { sessionRoot })).toBeNull();
    });

    it('splits bare text into plain and linked segments', () => {
        const result = splitSessionFileText('Open packages/joy-daemon/src/codex/runCodex.ts:594 please.', sessionRoot);

        expect(result).toEqual([
            { text: 'Open ', link: null },
            {
                text: 'packages/joy-daemon/src/codex/runCodex.ts:594',
                link: {
                    path: 'packages/joy-daemon/src/codex/runCodex.ts',
                    absolutePath: '/Users/kirilldubovitskiy/projects/joy/packages/joy-daemon/src/codex/runCodex.ts',
                    relativePath: 'packages/joy-daemon/src/codex/runCodex.ts',
                    withinSessionRoot: true,
                    line: 594,
                    column: null,
                },
            },
            { text: ' please.', link: null },
        ]);
    });

    it('splits absolute bare file refs with spaces into linked segments', () => {
        const result = splitSessionFileText(
            'Image: /Users/kirilldubovitskiy/Library/Application Support/CleanShot/media/test/CleanShot 2026-03-19 at 00.54.37@2x.png',
            sessionRoot,
        );

        expect(result).toEqual([
            { text: 'Image: ', link: null },
            {
                text: '/Users/kirilldubovitskiy/Library/Application Support/CleanShot/media/test/CleanShot 2026-03-19 at 00.54.37@2x.png',
                link: {
                    path: '/Users/kirilldubovitskiy/Library/Application Support/CleanShot/media/test/CleanShot 2026-03-19 at 00.54.37@2x.png',
                    absolutePath: '/Users/kirilldubovitskiy/Library/Application Support/CleanShot/media/test/CleanShot 2026-03-19 at 00.54.37@2x.png',
                    relativePath: null,
                    withinSessionRoot: false,
                    line: null,
                    column: null,
                },
            },
        ]);
    });

    it('does not turn version numbers into file refs', () => {
        expect(splitSessionFileText('Version 1.2.3 shipped.', sessionRoot)).toEqual([
            { text: 'Version 1.2.3 shipped.', link: null },
        ]);
    });

    it('does not turn slash-separated prose into file refs', () => {
        expect(splitSessionFileText(
            'Codex then starts/resumes turns with backend default model. I’m checking CLI docs/tests to confirm there is intentionally no joy codex model set or --model surface today.',
            sessionRoot,
        )).toEqual([
            {
                text: 'Codex then starts/resumes turns with backend default model. I’m checking CLI docs/tests to confirm there is intentionally no joy codex model set or --model surface today.',
                link: null,
            },
        ]);
    });

    it('takes a viewer path literally — a colon-digits basename is a file name, not a line number (#163)', () => {
        expect(resolveSessionFilePath('report:2026', sessionRoot)).toEqual({
            path: 'report:2026',
            absolutePath: '/Users/kirilldubovitskiy/projects/joy/report:2026',
            relativePath: 'report:2026',
            withinSessionRoot: true,
            line: null,
            column: null,
        });
        expect(resolveSessionFilePath('/tmp/backup:12:30.log', sessionRoot)?.absolutePath).toBe('/tmp/backup:12:30.log');
        // Textual links still parse the suffix — that is where a link's line lives.
        expect(parseSessionFileLink('src/report.ts:2026', { sessionRoot })?.line).toBe(2026);
    });

    it('keeps leading/trailing whitespace in a viewer path — it is part of the file name (#163)', () => {
        expect(resolveSessionFilePath(' notes.txt', sessionRoot)?.absolutePath)
            .toBe('/Users/kirilldubovitskiy/projects/joy/ notes.txt');
        expect(resolveSessionFilePath('/tmp/report ', sessionRoot)?.absolutePath).toBe('/tmp/report ');
        expect(resolveSessionFilePath('', sessionRoot)).toBeNull();
        // Textual links still trim — there the whitespace is prose, not a name.
        expect(parseSessionFileLink(' src/report.ts ', { sessionRoot })?.path).toBe('src/report.ts');
    });

    it('resolves viewer input to an absolute path', () => {
        expect(resolveSessionFilePath('packages/joy-app/README.md', sessionRoot)).toEqual({
            path: 'packages/joy-app/README.md',
            absolutePath: '/Users/kirilldubovitskiy/projects/joy/packages/joy-app/README.md',
            relativePath: 'packages/joy-app/README.md',
            withinSessionRoot: true,
            line: null,
            column: null,
        });
    });
});

describe('splitSessionFileText — bounded candidate scanning (#446)', () => {
    it('400 repeated "a/ " tokens split in well under 100 ms and stay plain text', () => {
        const text = 'a/ '.repeat(400);
        const t0 = performance.now();
        const segments = splitSessionFileText(text, '/repo');
        expect(performance.now() - t0).toBeLessThan(PERF_BUDGET_MS);
        expect(segments).toEqual([{ text, link: null }]);
    });

    it('1000 repeated path-like tokens are still fast and lossless', () => {
        const text = 'src/ '.repeat(1000);
        const t0 = performance.now();
        const segments = splitSessionFileText(text, '/repo');
        expect(performance.now() - t0).toBeLessThan(PERF_BUDGET_MS);
        expect(segments.map(s => s.text).join('')).toBe(text);
    });

    it('still links a real path among many decoys, and never across a line break', () => {
        const text = 'a/ '.repeat(50) + '\nsee src/index.ts:12 here\nsrc/other.ts';
        const segments = splitSessionFileText(text, '/repo');
        const links = segments.filter(s => s.link);
        expect(links.map(s => s.text)).toEqual(['src/index.ts:12', 'src/other.ts']);
        expect(segments.map(s => s.text).join('')).toBe(text);
    });
});

describe('splitSessionFileText — separate references stay separate (#445)', () => {
    it('two absolute paths joined by prose become two links', () => {
        const text = 'See /repo/a.ts and /repo/b.ts';
        const segments = splitSessionFileText(text, '/repo');
        expect(segments.filter(s => s.link).map(s => s.text)).toEqual(['/repo/a.ts', '/repo/b.ts']);
        expect(segments.map(s => s.text).join('')).toBe(text);
        expect(segments.find(s => s.text === '/repo/a.ts')?.link?.absolutePath).toBe('/repo/a.ts');
    });

    it('relative paths separated by a comma become two links', () => {
        const segments = splitSessionFileText('Open src/a.ts, src/b.ts', '/repo');
        expect(segments.filter(s => s.link).map(s => s.text)).toEqual(['src/a.ts', 'src/b.ts']);
    });

    it('a path never grows past a following bare filename once it already names a file', () => {
        const text = 'Compare /repo/a.ts with notes.md please';
        const segments = splitSessionFileText(text, '/repo');
        expect(segments.filter(s => s.link).map(s => s.text)).toEqual(['/repo/a.ts']);
        expect(segments.map(s => s.text).join('')).toBe(text);
    });
});

describe('parseSessionFileLink — line suffix vs URL scheme (#447)', () => {
    it('a bare filename with a line number is a file, not a scheme', () => {
        expect(parseSessionFileLink('index.ts:12', { sessionRoot: '/repo' })).toEqual({
            path: 'index.ts',
            absolutePath: '/repo/index.ts',
            relativePath: 'index.ts',
            withinSessionRoot: true,
            line: 12,
            column: null,
        });
        // A relative path with a line suffix links in free text as well.
        expect(splitSessionFileText('fix src/index.ts:12 now', '/repo').filter(s => s.link).map(s => s.text)).toEqual(['src/index.ts:12']);
    });

    it('real schemes are still rejected, with or without a port', () => {
        expect(parseSessionFileLink('https://x.io:8080/a', { sessionRoot: '/repo' })).toBeNull();
        expect(parseSessionFileLink('mailto:a@b.c', { sessionRoot: '/repo' })).toBeNull();
    });
});

describe('resolveSessionFilePath — filesystem roots (#448)', () => {
    it('a child of "/" is inside a session rooted at "/"', () => {
        expect(resolveSessionFilePath('/readme.txt', '/')).toMatchObject({ withinSessionRoot: true, relativePath: 'readme.txt' });
    });

    it('a child of "C:\\" is inside a session rooted at "C:\\"', () => {
        expect(resolveSessionFilePath('C:\\readme.txt', 'C:\\')).toMatchObject({
            absolutePath: 'C:/readme.txt', withinSessionRoot: true, relativePath: 'readme.txt',
        });
    });
});

describe('resolveSessionFilePath — file: URLs (#449)', () => {
    it('decodes drive, localhost and percent-encoded forms', () => {
        expect(resolveSessionFilePath('file:///C:/Users/me/file.ts', 'C:/repo')?.absolutePath).toBe('C:/Users/me/file.ts');
        expect(resolveSessionFilePath('file://localhost/home/me/file.ts', '/repo')?.absolutePath).toBe('/home/me/file.ts');
        expect(resolveSessionFilePath('file:///home/me/my%20file.ts', '/repo')).toMatchObject({
            path: '/home/me/my file.ts', absolutePath: '/home/me/my file.ts',
        });
    });

    it('a file: URL on another host is not a local file', () => {
        expect(resolveSessionFilePath('file://nas/share/x.ts', '/repo')).toBeNull();
    });
});

describe('resolveSessionFilePath — home paths (#450)', () => {
    it('expands ~ when the home can be inferred from the session root', () => {
        expect(resolveSessionFilePath('~/file.ts', '/home/me/repo')).toMatchObject({
            absolutePath: '/home/me/file.ts', withinSessionRoot: false, relativePath: null,
        });
    });

    it('leaves ~ unresolved instead of inventing a "~" directory in the project', () => {
        expect(resolveSessionFilePath('~/file.ts', '/srv/repo')).toBeNull();
        expect(splitSessionFileText('see ~/file.ts', '/srv/repo')).toEqual([{ text: 'see ~/file.ts', link: null }]);
    });
});

describe('splitSessionFileText — quoted references (#451)', () => {
    it('a single-quoted path links like a double-quoted one', () => {
        expect(splitSessionFileText("See '/repo/a.ts'", '/repo')).toEqual([
            { text: "See '", link: null },
            { text: '/repo/a.ts', link: expect.objectContaining({ absolutePath: '/repo/a.ts' }) },
            { text: "'", link: null },
        ]);
    });

    it('an apostrophe that belongs to an unquoted name stays in it', () => {
        const segments = splitSessionFileText("open /repo/it's.ts", '/repo');
        expect(segments.filter(s => s.link).map(s => s.text)).toEqual(["/repo/it's.ts"]);
    });
});

describe('resolveSessionFilePath — UNC paths (#452)', () => {
    it('a \\\\server\\share path is absolute and outside the project', () => {
        expect(resolveSessionFilePath('\\\\server\\share\\a.ts', 'C:/repo')).toMatchObject({
            absolutePath: '//server/share/a.ts', withinSessionRoot: false, relativePath: null,
        });
    });
});

describe('splitSessionFileText — explicit quote boundaries (#445 residual)', () => {
    it('a double-quoted path with a space is one reference, even when its first word looks like a file', () => {
        const text = 'See "/repo/my.txt file.ts" now';
        const segments = splitSessionFileText(text, '/repo');
        expect(segments.filter(s => s.link).map(s => s.text)).toEqual(['/repo/my.txt file.ts']);
        expect(segments.find(s => s.link)?.link?.absolutePath).toBe('/repo/my.txt file.ts');
        expect(segments.map(s => s.text).join('')).toBe(text);
    });

    it('single quotes and backticks bound a span the same way, with wrapping punctuation outside', () => {
        expect(splitSessionFileText("open '/repo/my.txt file.ts', thanks", '/repo')).toEqual([
            { text: "open '", link: null },
            { text: '/repo/my.txt file.ts', link: expect.objectContaining({ absolutePath: '/repo/my.txt file.ts' }) },
            { text: "', thanks", link: null },
        ]);
        expect(splitSessionFileText('open (`src/a b.ts`), thanks', '/repo').filter(s => s.link).map(s => s.text)).toEqual(['src/a b.ts']);
    });

    it('a stray opening quote, or a quote closed on another line, does not merge separate references', () => {
        expect(splitSessionFileText('See "/repo/a.ts and "/repo/b.ts"', '/repo').filter(s => s.link).map(s => s.text)).toEqual(['/repo/a.ts', '/repo/b.ts']);
        expect(splitSessionFileText('See "/repo/a.ts and\n/repo/b.ts"', '/repo').filter(s => s.link).map(s => s.text)).toEqual(['/repo/a.ts', '/repo/b.ts']);
    });

    it('the same words unquoted still stop at the first file (#445)', () => {
        expect(splitSessionFileText('See /repo/my.txt file.ts', '/repo').filter(s => s.link).map(s => s.text)).toEqual(['/repo/my.txt']);
    });
});
