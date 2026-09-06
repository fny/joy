import { describe, expect, it, vi } from 'vitest';
import { withTempExport } from './shareTempFile';

describe('withTempExport (#225, #430)', () => {
    it('removes the temporary file after a successful share and returns the share result', async () => {
        const order: string[] = [];
        const result = await withTempExport({
            write: async () => { order.push('write'); },
            share: async () => { order.push('share'); return 'shared'; },
            remove: async () => { order.push('remove'); },
        });
        expect(result).toBe('shared');
        expect(order).toEqual(['write', 'share', 'remove']);
    });

    it('removes the temporary file when the share sheet rejects, then rethrows the share error', async () => {
        const remove = vi.fn(async () => {});
        await expect(withTempExport({
            write: async () => {},
            share: async () => { throw new Error('dismissed'); },
            remove,
        })).rejects.toThrow('dismissed');
        expect(remove).toHaveBeenCalledTimes(1);
    });

    it('reports a cleanup failure without rejecting or hiding the share result', async () => {
        const onCleanupError = vi.fn();
        const result = await withTempExport({
            write: async () => {},
            share: async () => 42,
            remove: async () => { throw new Error('eperm'); },
            onCleanupError,
        });
        expect(result).toBe(42);
        expect(onCleanupError).toHaveBeenCalledWith(expect.objectContaining({ message: 'eperm' }));
    });

    it('still attempts removal when the write itself fails', async () => {
        const remove = vi.fn(async () => {});
        await expect(withTempExport({
            write: async () => { throw new Error('enospc'); },
            share: async () => 'never',
            remove,
        })).rejects.toThrow('enospc');
        expect(remove).toHaveBeenCalledTimes(1);
    });
});
