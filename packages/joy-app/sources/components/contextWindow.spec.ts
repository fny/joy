import { describe, it, expect } from 'vitest';

// #646: the "% left" segment divided every model's context by one hardcoded
// 190,000. These pin the behaviour the fix depends on; the map itself is
// deliberately empty until a real window is known for a family.
import { CONTEXT_WINDOWS, contextWindowFor, formatTokens } from './contextWindow';

describe('context window resolution', () => {
    it('returns null for a model whose window is not known', () => {
        expect(contextWindowFor('claude-fable-5-1')).toBeNull();
        expect(contextWindowFor('claude-opus-5')).toBeNull();
        expect(contextWindowFor(undefined)).toBeNull();
        expect(contextWindowFor(null)).toBeNull();
    });

    it('resolves by model FAMILY, so a version bump does not silently lose the window', () => {
        CONTEXT_WINDOWS.testfam = 123_456;
        try {
            expect(contextWindowFor('claude-testfam-9-9')).toBe(123_456);
            expect(contextWindowFor('claude-testfam')).toBe(123_456);
        } finally {
            delete CONTEXT_WINDOWS.testfam;
        }
    });

    it('never invents a window for an unknown family', () => {
        // The bug was a default that applied everywhere. There must be no default.
        expect(contextWindowFor('something-entirely-new')).toBeNull();
    });

    it('formats token counts compactly', () => {
        expect(formatTokens(950)).toBe('950');
        expect(formatTokens(12_400)).toBe('12k');
        expect(formatTokens(312_000)).toBe('312k');
        expect(formatTokens(1_250_000)).toBe('1.3M');
    });
});
