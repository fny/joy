import { describe, it, expect } from 'vitest';
import { parseChangelogContent } from './changelogParse';

describe('parseChangelogContent (#350)', () => {
    it('does not treat a `# comment` inside a fenced block as a release heading', () => {
        const md = [
            '# Sep 7',
            'Config docs.',
            '- Added a setup snippet:',
            '',
            '```sh',
            '# Configure the client',
            'joy config set relay https://example',
            '```',
            '',
            '# Sep 6',
            '- Older release',
        ].join('\n');
        const { entries, latestTitle } = parseChangelogContent(md);
        expect(entries.map(e => e.title)).toEqual(['Sep 7', 'Sep 6']);
        expect(latestTitle).toBe('Sep 7');
        expect(entries[0].summary).toBe('Config docs.');
        expect(entries[0].markdown).toContain('# Configure the client');
        expect(entries[0].markdown).toContain('joy config set relay');
        expect(entries[0].markdown.endsWith('```')).toBe(true);
    });

    it('closes a fence only with the same character and at least the same length', () => {
        const md = [
            '# A',
            '````md',
            '```',
            '# not a heading (inner fence did not close the 4-tick block)',
            '```',
            '````',
            '# B',
            '- b',
        ].join('\n');
        expect(parseChangelogContent(md).entries.map(e => e.title)).toEqual(['A', 'B']);
        const tilde = ['# A', '~~~', '# still code', '```', '# still code', '~~~', '# B', '- b'].join('\n');
        expect(parseChangelogContent(tilde).entries.map(e => e.title)).toEqual(['A', 'B']);
    });

    it('keeps the legacy summary/bullets split and skips empty releases', () => {
        const md = ['# One', '', '- first bullet', '- second', '', '# Empty', '', '# Three', 'Summary line', '- x'].join('\n');
        const { entries } = parseChangelogContent(md);
        expect(entries).toEqual([
            { title: 'One', summary: '', markdown: '- first bullet\n- second' },
            { title: 'Three', summary: 'Summary line', markdown: '- x' },
        ]);
    });
});
