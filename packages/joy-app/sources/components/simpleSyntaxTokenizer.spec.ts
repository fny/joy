import { describe, it, expect } from 'vitest';
import { tokenizeCode, HIGHLIGHT_INPUT_CAP } from './simpleSyntaxTokenizer';

const joined = (code: string, lang: string | null) => tokenizeCode(code, lang).map(t => t.text).join('');

describe('simpleSyntaxTokenizer — bounded highlighting (#241)', () => {
    it('a quoted 64k-digit literal followed by a letter tokenizes in well under 100 ms', () => {
        const code = `const x = "${'1'.repeat(64_000)}a";`;
        const t0 = performance.now();
        const tokens = tokenizeCode(code, 'javascript');
        const ms = performance.now() - t0;
        expect(ms).toBeLessThan(100);
        expect(tokens.map(t => t.text).join('')).toBe(code); // nothing lost
    });

    it('a bare 64k-digit run ending in a letter is linear too', () => {
        const code = '9'.repeat(64_000) + 'x';
        const t0 = performance.now();
        expect(joined(code, 'python')).toBe(code);
        expect(performance.now() - t0).toBeLessThan(100);
    });

    it('still highlights ordinary numbers, floats and exponents', () => {
        const tokens = tokenizeCode('let a = 12 + 3.5 + 1e10 + 0xff;', 'typescript');
        const numbers = tokens.filter(t => t.type === 'number').map(t => t.text);
        expect(numbers).toEqual(['12', '3.5', '1e10', '0xff']);
    });

    it('past the input cap the block is returned as one plain token', () => {
        const code = 'let x = 1;\n'.repeat(Math.ceil((HIGHLIGHT_INPUT_CAP + 1) / 11));
        const tokens = tokenizeCode(code, 'javascript');
        expect(tokens).toEqual([{ text: code, type: 'default' }]);
    });

    it('no language means no tokenization', () => {
        expect(tokenizeCode('a = 1', null)).toEqual([{ text: 'a = 1', type: 'default' }]);
    });

    it('round-trips arbitrary code (tokens concatenate back to the input)', () => {
        const code = 'def f(x):\n    # comment\n    return "s" + str(x[0]) # t\n';
        expect(joined(code, 'python')).toBe(code);
    });
});
