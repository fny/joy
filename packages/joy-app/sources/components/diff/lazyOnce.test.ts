import { describe, expect, it, vi } from 'vitest';
import { lazyOnce } from './lazyOnce';

describe('lazyOnce (#253)', () => {
    it('shares a single in-flight load and caches the fulfilled value', async () => {
        const load = vi.fn(async () => 'bundle');
        const get = lazyOnce(load);
        const [a, b] = await Promise.all([get(), get()]);
        expect(a).toBe('bundle');
        expect(b).toBe('bundle');
        expect(await get()).toBe('bundle');
        expect(load).toHaveBeenCalledTimes(1);
    });

    it('forgets a rejected load so the next call tries again', async () => {
        let attempt = 0;
        const load = vi.fn(async () => {
            attempt += 1;
            if (attempt === 1) throw new Error('chunk failed');
            return 'bundle';
        });
        const get = lazyOnce(load);
        await expect(get()).rejects.toThrow('chunk failed');
        expect(await get()).toBe('bundle'); // the old memo replayed the rejection here
        expect(load).toHaveBeenCalledTimes(2);
    });
});
