import { describe, it, expect } from 'vitest';
import { InkPointers, containFit, strokePath, toDoc, toView, traceStroke } from './drawingModel';

describe('strokePath / traceStroke (#210)', () => {
    it('a single point is a dot', () => {
        expect(strokePath([{ x: 10, y: 10 }])).toBe('M 10 10 L 10.1 10.1');
    });

    it('two points are the line between them, not a dot at the first', () => {
        // A quick flick: grant at (10,10), one move at (100,100), release.
        expect(strokePath([{ x: 10, y: 10 }, { x: 100, y: 100 }])).toBe('M 10 10 L 100 100');
        const ops: string[] = [];
        traceStroke({
            moveTo: (x, y) => ops.push(`M${x},${y}`),
            lineTo: (x, y) => ops.push(`L${x},${y}`),
            quadraticCurveTo: (cx, cy, x, y) => ops.push(`Q${cx},${cy},${x},${y}`),
        }, [{ x: 10, y: 10 }, { x: 100, y: 100 }]);
        expect(ops).toEqual(['M10,10', 'L100,100']);
    });

    it('three or more points keep the midpoint-quadratic smoothing', () => {
        expect(strokePath([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }])).toBe('M 0 0 Q 10 0 10 5 L 10 10');
        expect(strokePath([])).toBe('');
    });
});

describe('InkPointers (#212)', () => {
    const style = { color: '#000', width: 3 };

    it('a second pointer cannot take over, feed, or end the active stroke', () => {
        const ink = new InkPointers();
        expect(ink.begin(1, { x: 0, y: 0 }, style)).toBe(true);
        expect(ink.extend(1, { x: 10, y: 10 })).toBe(true);

        expect(ink.begin(2, { x: 500, y: 500 }, style)).toBe(false);
        expect(ink.extend(2, { x: 510, y: 510 })).toBe(false);
        expect(ink.end(2)).toBeNull();

        // Pointer 1 still draws, and its stroke holds only its own points.
        expect(ink.extend(1, { x: 20, y: 20 })).toBe(true);
        const stroke = ink.end(1);
        expect(stroke?.points).toEqual([{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 20, y: 20 }]);
        expect(ink.current()).toBeNull();
    });

    it('after the owning pointer lifts, another pointer may start a new stroke', () => {
        const ink = new InkPointers();
        ink.begin(1, { x: 0, y: 0 }, style);
        ink.end(1);
        expect(ink.begin(2, { x: 5, y: 5 }, style)).toBe(true);
        expect(ink.current()?.points).toEqual([{ x: 5, y: 5 }]);
    });

    it('sub-pixel moves are dropped without ending the stroke', () => {
        const ink = new InkPointers();
        ink.begin(1, { x: 0, y: 0 }, style);
        expect(ink.extend(1, { x: 0.5, y: 0.5 })).toBe(false);
        expect(ink.end(1)?.points).toHaveLength(1);
    });
});

describe('containFit (#213)', () => {
    it('image and ink move through the same transform when the pad is resized', () => {
        // A 400×400 screenshot annotated at (100,100) in a 400×400 pad, then
        // the pad becomes 600×300: the image contain-fits to 300×300 at
        // x=150, and so does the annotation — they stay together.
        const fit = containFit(400, 400, 600, 300);
        expect(fit).toEqual({ scale: 0.75, ox: 150, oy: 0 });
        expect(toView(fit, { x: 100, y: 100 })).toEqual({ x: 225, y: 75 });
        // A pointer landing on that feature maps back to the same drawing coordinate.
        expect(toDoc(fit, { x: 225, y: 75 })).toEqual({ x: 100, y: 100 });
    });

    it('an unchanged size is the identity, and a degenerate size never divides by zero', () => {
        expect(containFit(400, 400, 400, 400)).toEqual({ scale: 1, ox: 0, oy: 0 });
        expect(containFit(0, 0, 400, 400)).toEqual({ scale: 1, ox: 0, oy: 0 });
        expect(containFit(400, 400, 0, 300)).toEqual({ scale: 1, ox: 0, oy: 0 });
    });
});
