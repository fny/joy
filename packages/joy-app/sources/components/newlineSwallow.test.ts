import { describe, expect, it } from 'vitest';
import { isNewlineInsertedAtSelection } from './newlineSwallow';

const caret = (at: number) => ({ start: at, end: at });

describe('isNewlineInsertedAtSelection (#27)', () => {
    it('recognizes the native newline inserted at the caret of the handled return key', () => {
        expect(isNewlineInsertedAtSelection({ base: '/co', selection: caret(3) }, '/co\n')).toBe(true);
    });

    it('is keyed on the key press, not on elapsed time: the same change is swallowed whenever it arrives', () => {
        // Reviewer case: the handler applied "/complete " and the native
        // "/co\n" was delivered 350 ms later (busy JS render). The predicate
        // has no clock — identity is base text + caret only.
        const pending = { base: '/co', selection: caret(3) };
        expect(isNewlineInsertedAtSelection(pending, '/co\n')).toBe(true);
        expect(isNewlineInsertedAtSelection(pending, '/co\n')).toBe(true);
    });

    it('recognizes a newline inserted mid-text at the recorded caret', () => {
        expect(isNewlineInsertedAtSelection({ base: 'ab', selection: caret(1) }, 'a\nb')).toBe(true);
        expect(isNewlineInsertedAtSelection({ base: 'a\nb', selection: caret(3) }, 'a\nb\n')).toBe(true);
        expect(isNewlineInsertedAtSelection({ base: 'a\nb', selection: caret(2) }, 'a\n\nb')).toBe(true);
    });

    it('rejects a newline at a position other than the recorded caret (that is a different edit)', () => {
        expect(isNewlineInsertedAtSelection({ base: 'ab', selection: caret(1) }, 'ab\n')).toBe(false);
        expect(isNewlineInsertedAtSelection({ base: 'ab', selection: caret(2) }, 'a\nb')).toBe(false);
        expect(isNewlineInsertedAtSelection({ base: '/co /co', selection: caret(3) }, '/co /co\n')).toBe(false);
    });

    it('treats a selected range as replaced by the newline', () => {
        expect(isNewlineInsertedAtSelection({ base: 'abc', selection: { start: 1, end: 2 } }, 'a\nc')).toBe(true);
        expect(isNewlineInsertedAtSelection({ base: 'abc', selection: { start: 2, end: 1 } }, 'a\nc')).toBe(true);
        expect(isNewlineInsertedAtSelection({ base: 'abc', selection: { start: 1, end: 2 } }, 'ab\nc')).toBe(false);
    });

    it('clamps a stale selection to the text bounds', () => {
        expect(isNewlineInsertedAtSelection({ base: '/co', selection: caret(9) }, '/co\n')).toBe(true);
        expect(isNewlineInsertedAtSelection({ base: '/co', selection: caret(-1) }, '\n/co')).toBe(true);
    });

    it('rejects anything that is not exactly one added newline', () => {
        const pending = { base: '/co', selection: caret(3) };
        expect(isNewlineInsertedAtSelection(pending, '/co')).toBe(false);
        expect(isNewlineInsertedAtSelection(pending, '/cox')).toBe(false);
        expect(isNewlineInsertedAtSelection(pending, '/c\n')).toBe(false);
        expect(isNewlineInsertedAtSelection(pending, '/co\n\n')).toBe(false);
        expect(isNewlineInsertedAtSelection({ base: '/commit ', selection: caret(8) }, '/co\n')).toBe(false);
    });
});
