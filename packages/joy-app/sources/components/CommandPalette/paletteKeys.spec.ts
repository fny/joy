import { describe, it, expect } from 'vitest';
import { clampSelectedIndex, isComposingKeyEvent, shouldHandlePaletteKey } from './paletteKeys';

describe('paletteKeys', () => {
    it('#204: Enter/arrows during an IME composition are left to the IME', () => {
        expect(shouldHandlePaletteKey({ key: 'Enter', isComposing: true })).toBe(false);
        expect(shouldHandlePaletteKey({ key: 'Enter', keyCode: 229 })).toBe(false);
        expect(shouldHandlePaletteKey({ key: 'ArrowDown', isComposing: true })).toBe(false);
        expect(isComposingKeyEvent({ key: 'Process', keyCode: 229 })).toBe(true);
    });

    it('handles navigation keys once composition has finished, and nothing else', () => {
        expect(shouldHandlePaletteKey({ key: 'Enter', isComposing: false })).toBe(true);
        expect(shouldHandlePaletteKey({ key: 'ArrowUp' })).toBe(true);
        expect(shouldHandlePaletteKey({ key: 'Escape' })).toBe(true);
        expect(shouldHandlePaletteKey({ key: 'a' })).toBe(false);
        expect(shouldHandlePaletteKey(undefined)).toBe(false);
        expect(shouldHandlePaletteKey({})).toBe(false);
    });

    it('#208: the cursor is clamped into the result list and parked at 0 when it is empty', () => {
        expect(clampSelectedIndex(2, 1)).toBe(0);
        expect(clampSelectedIndex(2, 3)).toBe(2);
        expect(clampSelectedIndex(5, 3)).toBe(2);
        expect(clampSelectedIndex(2, 0)).toBe(0);
        expect(clampSelectedIndex(-1, 3)).toBe(0);
    });
});
