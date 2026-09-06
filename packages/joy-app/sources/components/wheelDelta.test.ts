import { describe, expect, it } from 'vitest';
import { normalizeWheelDelta, WHEEL_DELTA_LINE, WHEEL_DELTA_PAGE, WHEEL_DELTA_PIXEL } from './wheelDelta';

describe('normalizeWheelDelta (#223)', () => {
    it('passes pixel deltas through unchanged', () => {
        expect(normalizeWheelDelta(12, -7, WHEEL_DELTA_PIXEL, 16, 400)).toEqual({ deltaX: 12, deltaY: -7 });
    });

    it('converts line deltas with the line size', () => {
        expect(normalizeWheelDelta(0, 3, WHEEL_DELTA_LINE, 16, 400)).toEqual({ deltaX: 0, deltaY: 48 });
        expect(normalizeWheelDelta(-1, 0, WHEEL_DELTA_LINE, 20, 400)).toEqual({ deltaX: -20, deltaY: 0 });
    });

    it('converts page deltas with the viewport size', () => {
        expect(normalizeWheelDelta(0, 1, WHEEL_DELTA_PAGE, 16, 400)).toEqual({ deltaX: 0, deltaY: 400 });
    });

    it('moves a different distance per mode for the same raw delta', () => {
        const px = normalizeWheelDelta(0, 3, WHEEL_DELTA_PIXEL, 16, 400).deltaY;
        const line = normalizeWheelDelta(0, 3, WHEEL_DELTA_LINE, 16, 400).deltaY;
        const page = normalizeWheelDelta(0, 3, WHEEL_DELTA_PAGE, 16, 400).deltaY;
        expect(px).toBeLessThan(line);
        expect(line).toBeLessThan(page);
    });
});
