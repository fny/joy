import { describe, expect, it } from 'vitest';
import { thumbCanvasSize } from './thumbhash.web';

describe('thumbCanvasSize (#455)', () => {
    it('scales the longest edge to the maximum', () => {
        expect(thumbCanvasSize(1000, 500)).toEqual({ w: 100, h: 50 });
        expect(thumbCanvasSize(50, 50)).toEqual({ w: 100, h: 100 });
        expect(thumbCanvasSize(1, 100)).toEqual({ w: 1, h: 100 });
    });

    // A 1x1000 image scaled to 0.1px rounded to a zero-width canvas and
    // getImageData threw — the thin image lost its placeholder (#455).
    it('never rounds an edge down to zero', () => {
        expect(thumbCanvasSize(1, 1000)).toEqual({ w: 1, h: 100 });
        expect(thumbCanvasSize(1000, 1)).toEqual({ w: 100, h: 1 });
        expect(thumbCanvasSize(3, 100000)).toEqual({ w: 1, h: 100 });
    });
});
