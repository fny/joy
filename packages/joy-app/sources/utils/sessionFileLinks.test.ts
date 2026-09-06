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
        expect(performance.now() - t0).toBeLessThan(100);
        expect(segments).toEqual([{ text, link: null }]);
    });

    it('1000 repeated path-like tokens are still fast and lossless', () => {
        const text = 'src/ '.repeat(1000);
        const t0 = performance.now();
        const segments = splitSessionFileText(text, '/repo');
        expect(performance.now() - t0).toBeLessThan(100);
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
