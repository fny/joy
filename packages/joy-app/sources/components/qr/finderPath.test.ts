import { describe, expect, it } from 'vitest';
import { finderPath, finderSquares, type Square } from './finderPath';

const inside = (p: { x: number; y: number }, s: Square) =>
    p.x >= s.x && p.x < s.x + s.size && p.y >= s.y && p.y < s.y + s.size;
/** Even-odd fill: a point is painted when it lies inside an odd number of subpaths. */
const painted = (p: { x: number; y: number }, squares: Square[]) =>
    squares.filter((s) => inside(p, s)).length % 2 === 1;

describe('QR finder geometry (#272, #273)', () => {
    const m = 10;
    const squares = finderSquares(100, 200, m);

    it('is three nested SQUARES in the standard 7/5/3 ratio', () => {
        expect(squares).toEqual([
            { x: 100, y: 200, size: 70 },
            { x: 110, y: 210, size: 50 },
            { x: 120, y: 220, size: 30 },
        ]);
    });

    it('paints the ring and the centre but leaves the hole transparent under even-odd', () => {
        expect(painted({ x: 105, y: 205 }, squares)).toBe(true);  // outer ring
        expect(painted({ x: 115, y: 215 }, squares)).toBe(false); // the 1-module hole
        expect(painted({ x: 135, y: 235 }, squares)).toBe(true);  // 3x3 centre
        expect(painted({ x: 165, y: 265 }, squares)).toBe(true);  // far ring corner
        expect(painted({ x: 155, y: 255 }, squares)).toBe(false); // far side of the hole
    });

    it('emits one closed subpath per square with straight edges only', () => {
        const d = finderPath(100, 200, m);
        expect(d.match(/Z/g)).toHaveLength(3);
        expect(d).not.toMatch(/[AaCcQq]/); // no arcs or curves: square corners
        expect(d).toBe('M 100 200 h 70 v 70 h -70 Z M 110 210 h 50 v 50 h -50 Z M 120 220 h 30 v 30 h -30 Z');
    });
});
