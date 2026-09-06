import { describe, expect, it } from 'vitest';
import { limitFromPromptValue } from './limitPrompt';

describe('limitFromPromptValue (#176)', () => {
    it('keeps the current limit when the prompt was cancelled', () => {
        expect(limitFromPromptValue(null)).toEqual({ change: false });
    });

    it('disables the limit when the field was cleared and confirmed', () => {
        expect(limitFromPromptValue('')).toEqual({ change: true, limit: null });
        expect(limitFromPromptValue('   ')).toEqual({ change: true, limit: null });
    });

    it('accepts a positive integer', () => {
        expect(limitFromPromptValue(' 100 ')).toEqual({ change: true, limit: 100 });
    });

    it('ignores zero, negatives and garbage', () => {
        expect(limitFromPromptValue('0')).toEqual({ change: false });
        expect(limitFromPromptValue('-5')).toEqual({ change: false });
        expect(limitFromPromptValue('ten')).toEqual({ change: false });
        expect(limitFromPromptValue('12abc')).toEqual({ change: false });
    });
});
