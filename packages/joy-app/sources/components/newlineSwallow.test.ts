import { describe, expect, it } from 'vitest';
import { isTextPlusOneNewline } from './newlineSwallow';

describe('isTextPlusOneNewline (#27)', () => {
    it('recognizes the native newline appended after a handled return key', () => {
        expect(isTextPlusOneNewline('/co', '/co\n')).toBe(true);
    });

    it('recognizes a newline inserted mid-text (caret not at the end)', () => {
        expect(isTextPlusOneNewline('ab', 'a\nb')).toBe(true);
        expect(isTextPlusOneNewline('a\nb', 'a\nb\n')).toBe(true);
        expect(isTextPlusOneNewline('a\nb', 'a\n\nb')).toBe(true);
    });

    it('rejects anything that is not exactly one added newline', () => {
        expect(isTextPlusOneNewline('/co', '/co')).toBe(false);
        expect(isTextPlusOneNewline('/co', '/cox')).toBe(false);
        expect(isTextPlusOneNewline('/co', '/c\n')).toBe(false);
        expect(isTextPlusOneNewline('/co', '/co\n\n')).toBe(false);
        expect(isTextPlusOneNewline('/commit ', '/co\n')).toBe(false);
    });
});
