import { describe, expect, it } from 'vitest';
import { dismissalAt, isDismissalActive } from './dismissal';
import { findActiveWord } from './findActiveWord';

const caret = (at: number) => ({ start: at, end: at });

describe('autocomplete dismissal identity (#195)', () => {
    it('suppresses the query while text and caret are unchanged', () => {
        const d = dismissalAt('/co', caret(3));
        expect(isDismissalActive(d, '/co', caret(3))).toBe(true);
    });

    it('does not follow the same active-word string to a different word position', () => {
        // Reviewer case: "/co /co" dismissed at caret 3, caret then placed
        // directly at 7. Both positions yield the same active word, so a
        // string-keyed dismissal stayed suppressed at the second word.
        const text = '/co /co';
        expect(findActiveWord(text, caret(3))?.activeWord).toBe('/co');
        expect(findActiveWord(text, caret(7))?.activeWord).toBe('/co');
        const d = dismissalAt(text, caret(3));
        expect(isDismissalActive(d, text, caret(3))).toBe(true);
        expect(isDismissalActive(d, text, caret(7))).toBe(false);
    });

    it('re-arms on a text change elsewhere, even when the active word is unchanged', () => {
        const d = dismissalAt('/co /co', caret(3));
        // Typing at the end leaves the first word (and the caret it was
        // dismissed at) untouched, but the text is different.
        expect(findActiveWord('/co /cox', caret(3))?.activeWord).toBe('/co');
        expect(isDismissalActive(d, '/co /cox', caret(3))).toBe(false);
    });

    it('re-arms on a caret move within the same word and on a range selection', () => {
        const d = dismissalAt('/co', caret(3));
        expect(isDismissalActive(d, '/co', caret(2))).toBe(false);
        expect(isDismissalActive(d, '/co', { start: 1, end: 3 })).toBe(false);
    });

    it('is inert when nothing is dismissed', () => {
        expect(isDismissalActive(null, '/co', caret(3))).toBe(false);
    });
});
