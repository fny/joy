import { describe, it, expect } from 'vitest';
import { hasOwn, safeGet } from './safeGet';

describe('safeGet — prototype-safe plain-object lookups', () => {
    const map: Record<string, string> = { png: 'image/png', darwin: 'macOS' };

    it('returns own values', () => {
        expect(safeGet(map, 'png')).toBe('image/png');
        expect(hasOwn(map, 'darwin')).toBe(true);
    });

    it('returns undefined for missing keys', () => {
        expect(safeGet(map, 'nope')).toBeUndefined();
        expect(hasOwn(map, 'nope')).toBe(false);
    });

    it.each(['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf'])(
        'treats the inherited key %s as absent',
        (key) => {
            expect(safeGet(map, key)).toBeUndefined();
            expect(hasOwn(map, key)).toBe(false);
        },
    );

    it('tolerates null and undefined records', () => {
        expect(safeGet(undefined, 'png')).toBeUndefined();
        expect(safeGet(null, '__proto__')).toBeUndefined();
        expect(hasOwn(null, 'x')).toBe(false);
    });

    it('still works for objects whose own hasOwnProperty is shadowed', () => {
        const hostile: Record<string, unknown> = { hasOwnProperty: 'shadowed', real: 1 };
        expect(safeGet(hostile, 'real')).toBe(1);
        expect(safeGet(hostile, 'hasOwnProperty')).toBe('shadowed'); // own, so legitimately present
        expect(safeGet(hostile, 'constructor')).toBeUndefined();
    });
});
