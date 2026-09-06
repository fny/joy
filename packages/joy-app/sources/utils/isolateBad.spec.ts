import { describe, it, expect, vi } from 'vitest';
import * as z from 'zod';
import { attempt, attemptAsync, recoverFields } from './isolateBad';

describe('isolateBad — per-item boundaries and per-field recovery', () => {
    it('attempt returns the value, or null + a report on throw', () => {
        const report = vi.fn();
        expect(attempt(() => 42, report)).toBe(42);
        expect(attempt(() => { throw new Error('boom'); }, report)).toBeNull();
        expect(report).toHaveBeenCalledTimes(1);
        expect((report.mock.calls[0][0] as Error).message).toBe('boom');
    });

    it('attemptAsync catches rejections', async () => {
        expect(await attemptAsync(async () => 'ok')).toBe('ok');
        expect(await attemptAsync(async () => { throw new Error('x'); })).toBeNull();
    });

    it('a batch mapped through attempt keeps the good items in their positions', () => {
        const out = ['{"a":1}', 'not json', '{"b":2}'].map(s => attempt(() => JSON.parse(s) as unknown));
        expect(out).toEqual([{ a: 1 }, null, { b: 2 }]);
    });

    const shape = { lock: z.boolean(), theme: z.enum(['light', 'dark']), size: z.number() };
    const defaults = { lock: false, theme: 'light' as const, size: 14 };

    it('recoverFields keeps every valid field when one is malformed', () => {
        const { value, invalidKeys } = recoverFields(shape, { lock: true, theme: 'dark', size: '5' }, defaults);
        expect(value).toEqual({ lock: true, theme: 'dark', size: 14 });
        expect(invalidKeys).toEqual(['size']);
    });

    it('missing fields take defaults without being reported; unknown fields are ignored', () => {
        const { value, invalidKeys } = recoverFields(shape, { theme: 'dark', extra: 1 }, defaults);
        expect(value).toEqual({ lock: false, theme: 'dark', size: 14 });
        expect(invalidKeys).toEqual([]);
    });

    it('does not read inherited keys from the input', () => {
        const input = Object.create({ lock: true }) as Record<string, unknown>;
        expect(recoverFields(shape, input, defaults).value.lock).toBe(false);
    });

    it('does not mutate the defaults object', () => {
        recoverFields(shape, { lock: true }, defaults);
        expect(defaults.lock).toBe(false);
    });
});
