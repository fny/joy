import { describe, it, expect } from 'vitest';
import { parseMarkdown } from './parseMarkdown';

const spans = (text: string) => text ? [{ styles: [], text, url: null }] : [];

describe('parseMarkdownBlock - table parsing', () => {

    it('parses a standard table without blank lines', () => {
        const md = [
            '| A | B |',
            '|---|---|',
            '| 1 | 2 |',
        ].join('\n');

        const blocks = parseMarkdown(md);
        expect(blocks).toHaveLength(1);
        expect(blocks[0]).toEqual({
            type: 'table',
            headers: [spans('A'), spans('B')],
            rows: [[spans('1'), spans('2')]],
        });
    });

    it('parses a table with blank lines between rows (LLM output)', () => {
        const md = [
            '| A | B |',
            '',
            '|---|---|',
            '',
            '| 1 | 2 |',
            '',
            '| 3 | 4 |',
        ].join('\n');

        const blocks = parseMarkdown(md);
        // Should be recognized as a single table, not 4 separate text blocks
        const tableBlocks = blocks.filter(b => b.type === 'table');
        expect(tableBlocks).toHaveLength(1);
        expect(tableBlocks[0]).toEqual({
            type: 'table',
            headers: [spans('A'), spans('B')],
            rows: [[spans('1'), spans('2')], [spans('3'), spans('4')]],
        });
    });

    it('preserves empty interior cells (e.g. row header column)', () => {
        const md = [
            '| | Header1 | Header2 |',
            '|---|---|---|',
            '| Row1 | a | b |',
        ].join('\n');

        const blocks = parseMarkdown(md);
        expect(blocks).toHaveLength(1);
        expect(blocks[0]).toEqual({
            type: 'table',
            headers: [spans(''), spans('Header1'), spans('Header2')],
            rows: [[spans('Row1'), spans('a'), spans('b')]],
        });
    });

    it('handles blank lines and empty first cell combined', () => {
        const md = [
            '### Comparison',
            '',
            '| | Plan A | Plan B |',
            '',
            '|--|----|----|',
            '',
            '| Price | $10/mo | $20/mo |',
            '',
            '| Storage | 5 GB | 50 GB |',
            '',
            '| Support | Email only | 24/7 chat |',
        ].join('\n');

        const blocks = parseMarkdown(md);
        const tableBlocks = blocks.filter(b => b.type === 'table');
        expect(tableBlocks).toHaveLength(1);

        const table = tableBlocks[0];
        if (table.type !== 'table') throw new Error('not a table');

        // Empty first cell should be preserved
        expect(table.headers).toHaveLength(3);
        expect(table.headers[0]).toEqual([]);

        expect(table.rows).toHaveLength(3);
        expect(table.rows[0][0]).toEqual(spans('Price'));
    });

    it('stops table collection at non-blank, non-pipe lines', () => {
        const md = [
            '| A | B |',
            '|---|---|',
            '| 1 | 2 |',
            '',
            'Some text after the table',
        ].join('\n');

        const blocks = parseMarkdown(md);
        const tableBlocks = blocks.filter(b => b.type === 'table');
        const textBlocks = blocks.filter(b => b.type === 'text');

        expect(tableBlocks).toHaveLength(1);
        expect(textBlocks).toHaveLength(1);
    });
});

describe('parseMarkdownBlock - joy tags', () => {

    it('parses an options block into tappable option items', () => {
        const md = [
            'Pick one.',
            '',
            '<joy-options>',
            '<joy-option>Alpha</joy-option>',
            '<joy-option>Beta</joy-option>',
            '</joy-options>',
        ].join('\n');

        const blocks = parseMarkdown(md);
        const options = blocks.filter(b => b.type === 'options');
        expect(options).toHaveLength(1);
        expect(options[0]).toEqual({ type: 'options', items: ['Alpha', 'Beta'] });
        // No raw tag text survives as a paragraph.
        expect(JSON.stringify(blocks)).not.toContain('joy-option>');
    });

    it('parses an options block that follows another joy control tag', () => {
        const md = [
            'Done.',
            '',
            '<joy-title value="Some work" />',
            '',
            '<joy-options>',
            '<joy-option>Ship it</joy-option>',
            '</joy-options>',
        ].join('\n');

        const blocks = parseMarkdown(md);
        expect(blocks.filter(b => b.type === 'options')).toEqual([
            { type: 'options', items: ['Ship it'] },
        ]);
    });

    it('still drops other joy control tags on their own line', () => {
        const md = 'Started.\n\n<joy-bg id="abc" long-running label="Dev server" />\n\nWatching.';
        const blocks = parseMarkdown(md);
        expect(JSON.stringify(blocks)).not.toContain('joy-bg');
    });
});

describe('parseMarkdownBlock - escaped pipes (#262)', () => {
    it('keeps an escaped pipe inside one cell, in headers and rows', () => {
        const blocks = parseMarkdown('| a\\|b | c |\n|---|---|\n| x\\|y | either |');
        expect(blocks).toEqual([{
            type: 'table',
            headers: [spans('a|b'), spans('c')],
            rows: [[spans('x|y'), spans('either')]],
        }]);
    });

    it('a lone backslash that does not precede a pipe is ordinary text', () => {
        const blocks = parseMarkdown('| a | b |\n|---|---|\n| C:\\dir | 2 |');
        expect(blocks[0]).toEqual({ type: 'table', headers: [spans('a'), spans('b')], rows: [[spans('C:\\dir'), spans('2')]] });
    });
});

describe('parseMarkdownBlock - fence lengths (#263)', () => {
    it('a four-backtick fence contains a triple-backtick example and closes on its own fence', () => {
        const md = ['````markdown', '```js', 'x()', '```', '````', 'after'].join('\n');
        expect(parseMarkdown(md)).toEqual([
            { type: 'code-block', language: 'markdown', content: '```js\nx()\n```' },
            { type: 'text', content: spans('after') },
        ]);
    });

    it('a longer closing fence still closes a shorter opener', () => {
        expect(parseMarkdown('```\ncode\n`````\ntail')).toEqual([
            { type: 'code-block', language: null, content: 'code' },
            { type: 'text', content: spans('tail') },
        ]);
    });

    it('an unterminated fence swallows the rest (streaming), as before', () => {
        expect(parseMarkdown('```ts\nlet a = 1;\nlet b = 2;')).toEqual([
            { type: 'code-block', language: 'ts', content: 'let a = 1;\nlet b = 2;' },
        ]);
    });
});

describe('parseMarkdownBlock - inline options blocks (#264)', () => {
    it('an inline block keeps the text after the closer', () => {
        const md = '<joy-options><joy-option>Yes</joy-option><joy-option>No</joy-option></joy-options>\nBecause reasons.';
        expect(parseMarkdown(md)).toEqual([
            { type: 'options', items: ['Yes', 'No'] },
            { type: 'text', content: spans('Because reasons.') },
        ]);
    });

    it('a closer sharing a line with the last option, followed by text on that line', () => {
        const md = '<joy-options>\n<joy-option>A</joy-option></joy-options> Pick one.\n\nMore.';
        expect(parseMarkdown(md)).toEqual([
            { type: 'options', items: ['A'] },
            { type: 'text', content: spans('Pick one.') },
            { type: 'text', content: spans('More.') },
        ]);
    });

    it('an unterminated block mid-stream yields the options seen so far', () => {
        expect(parseMarkdown('<joy-options>\n<joy-option>A</joy-option>\n<joy-option>B')).toEqual([
            { type: 'options', items: ['A'] },
        ]);
    });

    it('the one-tag-per-line form is unchanged', () => {
        const md = 'Q?\n\n<joy-options>\n<joy-option>Alpha</joy-option>\n<joy-option>Beta</joy-option>\n</joy-options>\n\nTail.';
        expect(parseMarkdown(md)).toEqual([
            { type: 'text', content: spans('Q?') },
            { type: 'options', items: ['Alpha', 'Beta'] },
            { type: 'text', content: spans('Tail.') },
        ]);
    });
});

describe('parseMarkdownBlock - blank-separated tables (#265)', () => {
    it('two tables separated by a blank line stay two tables', () => {
        const md = '| A | B |\n|---|---|\n| 1 | 2 |\n\n| C | D |\n|---|---|\n| 3 | 4 |';
        expect(parseMarkdown(md)).toEqual([
            { type: 'table', headers: [spans('A'), spans('B')], rows: [[spans('1'), spans('2')]] },
            { type: 'table', headers: [spans('C'), spans('D')], rows: [[spans('3'), spans('4')]] },
        ]);
    });

    it('blank lines between rows of one table still fold into it', () => {
        const md = '| A | B |\n|---|---|\n\n| 1 | 2 |\n\n| 3 | 4 |';
        expect(parseMarkdown(md)).toEqual([
            { type: 'table', headers: [spans('A'), spans('B')], rows: [[spans('1'), spans('2')], [spans('3'), spans('4')]] },
        ]);
    });
});
