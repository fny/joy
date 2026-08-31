import { describe, it, expect } from 'vitest';
import { paneSizeFor, paneSizeChanged, PANE_LINE_HEIGHT, CHAR_WIDTH, PANE_H_PADDING } from './paneSize';

describe('paneSizeFor', () => {
    // REGRESSION: an unmeasured layout used to fall through the clamps into a
    // real 20×10 resize, which stuck after the screen closed. The agent was
    // left on a 20-column terminal — unreadable in the view, and narrow enough
    // that the daemon's pane parser goes blind and dispatch dies silently.
    it('returns null for an unmeasured layout instead of a 20x10 window', () => {
        expect(paneSizeFor(0, 0)).toBeNull();
        expect(paneSizeFor(0, 800)).toBeNull();
        expect(paneSizeFor(1200, 0)).toBeNull();
    });

    it('returns null for negative or NaN dimensions', () => {
        expect(paneSizeFor(-10, 800)).toBeNull();
        expect(paneSizeFor(NaN, 800)).toBeNull();
        expect(paneSizeFor(1200, NaN)).toBeNull();
    });

    // REGRESSION: rows used to be 2× the viewport to buy scrollback. Claude
    // pins its input box to the window's bottom and the view auto-scrolls to
    // the end, so a doubled window opened on the input box with a screenful of
    // blank above it — reported as "the terminal is black above the prompt".
    it('sizes rows to the viewport, not double it', () => {
        const heightPx = 600; // 40 lines at 15px
        const size = paneSizeFor(1200, heightPx)!;
        expect(size.rows).toBe(40);
        expect(size.rows).not.toBe(80);
    });

    it('derives columns from the padding-adjusted width, rounding down', () => {
        const widthPx = 1200;
        const expected = Math.floor((widthPx - PANE_H_PADDING) / CHAR_WIDTH);
        expect(paneSizeFor(widthPx, 600)!.cols).toBe(expected);
        // never wider than the content box
        expect(expected * CHAR_WIDTH).toBeLessThanOrEqual(widthPx - PANE_H_PADDING);
    });

    it('applies floors only to genuinely tiny measured layouts', () => {
        const size = paneSizeFor(30, 20)!;
        expect(size.cols).toBe(20);
        expect(size.rows).toBe(10);
    });

    it('scales rows with the line height', () => {
        expect(paneSizeFor(1200, PANE_LINE_HEIGHT * 25)!.rows).toBe(25);
    });
});

describe('paneSizeChanged', () => {
    it('is true when nothing has been sent yet', () => {
        expect(paneSizeChanged({ cols: 100, rows: 40 }, null)).toBe(true);
    });

    it('is false when neither axis moved', () => {
        expect(paneSizeChanged({ cols: 100, rows: 40 }, { cols: 100, rows: 40 })).toBe(false);
    });

    // REGRESSION: the guard compared columns only. That was survivable when
    // rows were derived from cols, but now that rows track the viewport a
    // height-only change (rotation, keyboard opening) would keep a stale window
    // height and reintroduce the dead space above the prompt.
    it('is true when only the height changed', () => {
        expect(paneSizeChanged({ cols: 100, rows: 56 }, { cols: 100, rows: 40 })).toBe(true);
    });

    it('is true when only the width changed', () => {
        expect(paneSizeChanged({ cols: 120, rows: 40 }, { cols: 100, rows: 40 })).toBe(true);
    });
});
