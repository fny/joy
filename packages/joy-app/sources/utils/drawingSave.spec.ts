import { describe, it, expect } from 'vitest';
import { canSaveDrawing } from './drawingSave';

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
