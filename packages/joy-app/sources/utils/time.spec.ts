import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBackoff, exponentialBackoffDelay } from './time';

describe('exponentialBackoffDelay (#109)', () => {
    afterEach(() => vi.restoreAllMocks());

    it('never goes below minDelay', () => {
        vi.spyOn(Math, 'random').mockReturnValue(0);
        expect(exponentialBackoffDelay(1, 250, 1000, 50)).toBe(250);
        expect(exponentialBackoffDelay(50, 250, 1000, 50)).toBe(250);
    });

    it('ramps its ceiling with the failure count instead of jumping to maxDelay', () => {
        vi.spyOn(Math, 'random').mockReturnValue(1);
        expect(exponentialBackoffDelay(1, 0, 1000, 10)).toBe(100);
        expect(exponentialBackoffDelay(5, 0, 1000, 10)).toBe(500);
        expect(exponentialBackoffDelay(10, 0, 1000, 10)).toBe(1000);
    });

    it('caps the ceiling at maxDelay once the failure count exceeds maxFailureCount', () => {
        vi.spyOn(Math, 'random').mockReturnValue(1);
        expect(exponentialBackoffDelay(500, 250, 1000, 50)).toBe(1000);
    });
});

describe('createBackoff bounds (#9)', () => {
    it('rethrows after maxAttempts instead of retrying forever', async () => {
        const op = vi.fn().mockRejectedValue(new Error('offline'));
        const run = createBackoff({ maxAttempts: 3, minDelay: 0, maxDelay: 0 });
        await expect(run(op)).rejects.toThrow('offline');
        expect(op).toHaveBeenCalledTimes(3);
    });

    it('stops at once when shouldRetry says no', async () => {
        const op = vi.fn().mockRejectedValue(Object.assign(new Error('401'), { status: 401 }));
        const run = createBackoff({ maxAttempts: 5, minDelay: 0, maxDelay: 0, shouldRetry: (e) => e.status !== 401 });
        await expect(run(op)).rejects.toThrow('401');
        expect(op).toHaveBeenCalledTimes(1);
    });

    it('returns the first successful result', async () => {
        const op = vi.fn().mockRejectedValueOnce(new Error('blip')).mockResolvedValue('ok');
        const run = createBackoff({ maxAttempts: 3, minDelay: 0, maxDelay: 0 });
        await expect(run(op)).resolves.toBe('ok');
        expect(op).toHaveBeenCalledTimes(2);
    });
});
