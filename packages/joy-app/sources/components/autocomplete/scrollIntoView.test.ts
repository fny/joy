import { describe, expect, it } from 'vitest';
import { scrollOffsetToReveal } from './scrollIntoView';

describe('scrollOffsetToReveal (#194)', () => {
    it('leaves a fully visible row alone', () => {
        expect(scrollOffsetToReveal(40, 40, 0, 320)).toBeNull();
        expect(scrollOffsetToReveal(280, 40, 0, 320)).toBeNull();
    });

    it('scrolls down just enough to reveal a row below the window', () => {
        expect(scrollOffsetToReveal(320, 40, 0, 320)).toBe(40);
        expect(scrollOffsetToReveal(800, 40, 0, 320)).toBe(520);
    });

    it('scrolls up to a row above the window', () => {
        expect(scrollOffsetToReveal(0, 40, 200, 320)).toBe(0);
        expect(scrollOffsetToReveal(160, 40, 200, 320)).toBe(160);
    });

    it('does nothing before the viewport has a measured height', () => {
        expect(scrollOffsetToReveal(800, 40, 0, 0)).toBeNull();
    });
});
