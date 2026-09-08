import { describe, it, expect } from 'vitest';
import { composerHeight, shouldCommitHeight } from './composerHeight';

const base = { minHeight: 40, maxHeight: 120 };

describe('composerHeight', () => {
    it('collapses to one line when empty — even with a tall stale measurement', () => {
        // This is the bug: a long message is sent, the field clears, and the
        // last intrinsic height (at the cap) never goes away.
        expect(composerHeight({ ...base, measured: 120, isEmpty: true })).toBe(40);
        expect(composerHeight({ ...base, measured: 300, isEmpty: true })).toBe(40);
    });

    it('grows with content up to the cap', () => {
        expect(composerHeight({ ...base, measured: 72, isEmpty: false })).toBe(72);
        expect(composerHeight({ ...base, measured: 500, isEmpty: false })).toBe(120);
    });

    it('never goes below one line', () => {
        expect(composerHeight({ ...base, measured: 12, isEmpty: false })).toBe(40);
        expect(composerHeight({ ...base, measured: 0, isEmpty: false })).toBe(40);
    });

    it('falls back to one line when nothing has been measured yet', () => {
        expect(composerHeight({ ...base, measured: null, isEmpty: false })).toBe(40);
        expect(composerHeight({ ...base, measured: NaN, isEmpty: false })).toBe(40);
    });

    it('rounds up so a fractional line is never clipped', () => {
        expect(composerHeight({ ...base, measured: 72.2, isEmpty: false })).toBe(73);
    });

    it('survives a max below the min without inverting', () => {
        expect(composerHeight({ minHeight: 40, maxHeight: 10, measured: 80, isEmpty: false })).toBe(40);
    });
});

describe('shouldCommitHeight', () => {
    it('always commits the first measurement', () => {
        expect(shouldCommitHeight(null, 40, 40)).toBe(true);
    });

    it('ignores sub-pixel jitter on the typing path', () => {
        expect(shouldCommitHeight(72, 72.4, 40)).toBe(false);
        expect(shouldCommitHeight(72, 71.7, 40)).toBe(false);
    });

    it('commits a real change', () => {
        expect(shouldCommitHeight(72, 96, 40)).toBe(true);
    });

    it('always commits a collapse back to the floor', () => {
        // The one change that must never be filtered out — dropping it is the
        // original bug wearing a different hat.
        expect(shouldCommitHeight(40.5, 40, 40)).toBe(true);
        expect(shouldCommitHeight(120, 40, 40)).toBe(true);
    });
});
