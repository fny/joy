import { describe, it, expect } from 'vitest';
import { computeMenuLayout, computeSheetMaxHeight } from './sessionActionsMenuLayout';

const base = { itemHeight: 48, menuWidth: 232, margin: 12, windowWidth: 1200 };

describe('sessionActionsMenuLayout', () => {
    it('#237: eight rows in a 320px window get a height budget inside the viewport instead of overflowing it', () => {
        const layout = computeMenuLayout({
            ...base,
            anchor: { type: 'point', x: 100, y: 40 },
            itemCount: 8,
            windowHeight: 320,
        });
        expect(layout.maxHeight).toBe(320 - 24);
        expect(layout.top).toBe(12);
        // The bottom edge of the budgeted menu stays on screen.
        expect(layout.top + layout.maxHeight).toBeLessThanOrEqual(320 - 12);
    });

    it('keeps the natural position when the menu fits below the anchor', () => {
        const layout = computeMenuLayout({
            ...base,
            anchor: { type: 'rect', x: 300, y: 100, width: 40, height: 20 },
            itemCount: 3,
            windowHeight: 900,
        });
        expect(layout.top).toBe(128);
        expect(layout.left).toBe(300 + 40 - 232);
        expect(layout.maxHeight).toBe(900 - 24);
    });

    it('flips above a rect anchor near the bottom edge when that fits', () => {
        const layout = computeMenuLayout({
            ...base,
            anchor: { type: 'rect', x: 300, y: 800, width: 40, height: 20 },
            itemCount: 3,
            windowHeight: 900,
        });
        expect(layout.top).toBe(800 - 144 - 8);
    });

    it('clamps the horizontal position into the window', () => {
        const layout = computeMenuLayout({
            ...base,
            anchor: { type: 'point', x: 1190, y: 10 },
            itemCount: 2,
            windowHeight: 900,
        });
        expect(layout.left).toBe(1200 - 232 - 12);
    });

    it('#237: the native sheet budget excludes the safe-area top', () => {
        expect(computeSheetMaxHeight(800, 47, 24)).toBe(729);
        expect(computeSheetMaxHeight(10, 47, 24)).toBe(0);
    });
});
