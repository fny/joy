import { describe, it, expect } from 'vitest';
import { parseAnsiLines, stripAnsi } from './ansi';

const ESC = '\x1b';

describe('stripAnsi — colon-form CSI parameters (#421)', () => {
    it('removes colon-form truecolor and underline-style SGR entirely', () => {
        expect(stripAnsi(`${ESC}[38:2::255:0:0mError${ESC}[0m`)).toBe('Error');
        expect(stripAnsi(`${ESC}[4:3munderlined${ESC}[0m`)).toBe('underlined');
    });

    it('still removes semicolon SGR, private-mode and other CSI sequences', () => {
        expect(stripAnsi(`${ESC}[1;31mbold red${ESC}[0m ${ESC}[?25l${ESC}[2J${ESC}[10;20Hx`)).toBe('bold red x');
    });

    it('keeps tabs and newlines, drops other control characters', () => {
        expect(stripAnsi('a\tb\nc\x07d')).toBe('a\tb\ncd');
    });
});

describe('parseAnsiLines — colon-form SGR (#421)', () => {
    it('interprets 38:2::r:g:b (with the colour-space slot) as truecolor', () => {
        const [line] = parseAnsiLines(`${ESC}[38:2::255:0:0mError${ESC}[0m plain`);
        expect(line).toEqual([
            { text: 'Error', fg: '#ff0000', bg: undefined, bold: undefined, dim: undefined, italic: undefined, underline: undefined, reverse: undefined },
            { text: ' plain', fg: undefined, bg: undefined, bold: undefined, dim: undefined, italic: undefined, underline: undefined, reverse: undefined },
        ]);
    });

    it('interprets 38:2:r:g:b (no colour-space slot), 48:5:n and 4:3', () => {
        const [line] = parseAnsiLines(`${ESC}[38:2:0:255:0;48:5:16;4:3mx`);
        expect(line[0]).toMatchObject({ text: 'x', fg: '#00ff00', bg: '#000000', underline: true });
    });

    it('4:0 turns underline off, and unsupported colon parameters are dropped without leaking text', () => {
        const [line] = parseAnsiLines(`${ESC}[4mu${ESC}[4:0;58:2::1:2:3mn`);
        expect(line.map(s => s.text)).toEqual(['u', 'n']);
        expect(line[0].underline).toBe(true);
        expect(line[1].underline).toBeUndefined();
    });

    it('semicolon truecolor keeps working alongside', () => {
        const [line] = parseAnsiLines(`${ESC}[38;2;1;2;3mx${ESC}[39my`);
        expect(line[0].fg).toBe('#010203');
        expect(line[1].fg).toBeUndefined();
    });

    it('a non-SGR CSI with intermediate bytes is removed, not shown', () => {
        const [line] = parseAnsiLines(`a${ESC}[?25l${ESC}[0 qb`);
        expect(line.map(s => s.text).join('')).toBe('ab');
    });
});
