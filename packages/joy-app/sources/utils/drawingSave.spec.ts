import { describe, it, expect } from 'vitest';
import { canSaveDrawing, chooseBackground, NO_BACKGROUND, reportBackgroundLoad } from './drawingSave';

describe('canSaveDrawing (#161)', () => {
    it('a chosen background does not enable Save until that exact source has loaded', () => {
        expect(canSaveDrawing({ strokeCount: 0, bgImage: 'data:a', loadedBgImage: null, saving: false })).toBe(false);
        expect(canSaveDrawing({ strokeCount: 3, bgImage: 'data:a', loadedBgImage: null, saving: false })).toBe(false);
        expect(canSaveDrawing({ strokeCount: 0, bgImage: 'data:a', loadedBgImage: 'data:a', saving: false })).toBe(true);
    });

    it('a stale load report for the previous background does not count', () => {
        expect(canSaveDrawing({ strokeCount: 0, bgImage: 'data:b', loadedBgImage: 'data:a', saving: false })).toBe(false);
    });

    it('ink alone still saves; an empty pad and an in-flight save do not', () => {
        expect(canSaveDrawing({ strokeCount: 1, bgImage: null, loadedBgImage: null, saving: false })).toBe(true);
        expect(canSaveDrawing({ strokeCount: 0, bgImage: null, loadedBgImage: null, saving: false })).toBe(false);
        expect(canSaveDrawing({ strokeCount: 1, bgImage: null, loadedBgImage: null, saving: true })).toBe(false);
    });
});

describe('background readiness is per load attempt (#161)', () => {
    const save = (s: { bgImage: string | null; loadedBgImage: string | null }) =>
        canSaveDrawing({ strokeCount: 0, saving: false, ...s });

    it('load A, remove it, choose A again: Save waits for the second load', () => {
        let s = chooseBackground(NO_BACKGROUND, 'data:a');
        s = reportBackgroundLoad(s, 'data:a', true);
        expect(save(s)).toBe(true);
        s = chooseBackground(s, null);
        expect(save(s)).toBe(false);
        // The surface cleared its image and is loading A again — the old
        // readiness must not be accepted.
        s = chooseBackground(s, 'data:a');
        expect(save(s)).toBe(false);
        s = reportBackgroundLoad(s, 'data:a', true);
        expect(save(s)).toBe(true);
    });

    it('re-choosing the source already in place keeps its readiness (the surface does not reload it)', () => {
        let s = reportBackgroundLoad(chooseBackground(NO_BACKGROUND, 'data:a'), 'data:a', true);
        const again = chooseBackground(s, 'data:a');
        expect(again).toBe(s);
        expect(save(again)).toBe(true);
    });

    it('a report for a source that is no longer chosen is ignored; a failed load clears the choice', () => {
        let s = chooseBackground(NO_BACKGROUND, 'data:a');
        s = chooseBackground(s, 'data:b');
        expect(reportBackgroundLoad(s, 'data:a', true)).toBe(s);
        expect(reportBackgroundLoad(s, 'data:b', false)).toEqual(NO_BACKGROUND);
    });
});
