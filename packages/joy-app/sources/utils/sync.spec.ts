import { describe, it, expect, vi } from 'vitest';

// Same shape as the real backoff (retry forever, sleep between attempts),
// with a 1ms sleep so the test can watch which value each attempt receives.
vi.mock('@/utils/time', () => ({
    backoff: async (fn: () => Promise<void>) => {
        for (;;) {
            try { return await fn(); } catch { await new Promise((r) => setTimeout(r, 1)); }
        }
    },
}));

import { ValueSync } from './sync';

const tick = (ms = 0) => new Promise<void>((r) => setTimeout(r, ms));

describe('ValueSync — a failing obsolete value does not block the corrected one (#454)', () => {
    it('retries stop receiving the rejected value once a newer value is queued, and the newer value lands', async () => {
        const seen: string[] = [];
        const sync = new ValueSync<string>(async (v) => {
            seen.push(v);
            if (v === 'bad') throw new Error('rejected forever');
        });
        sync.setValue('bad');
        await tick(15);
        const badAttemptsBeforeFix = seen.filter((v) => v === 'bad').length;
        expect(badAttemptsBeforeFix).toBeGreaterThan(1); // it IS retrying

        sync.setValue('good');
        await sync.awaitQueue();

        expect(seen[seen.length - 1]).toBe('good');
        // Before the fix the retry closure kept the captured 'bad' forever and
        // 'good' never ran; now at most one 'bad' attempt was mid-flight.
        const badAttemptsAfterFix = seen.filter((v) => v === 'bad').length - badAttemptsBeforeFix;
        expect(badAttemptsAfterFix).toBeLessThanOrEqual(1);
        await tick(15);
        expect(seen.filter((v) => v === 'bad').length - badAttemptsBeforeFix).toBeLessThanOrEqual(1); // and it stays stopped
    });

    it('a healthy value is retried and delivered as before', async () => {
        let failures = 2;
        const seen: number[] = [];
        const sync = new ValueSync<number>(async (v) => {
            seen.push(v);
            if (failures-- > 0) throw new Error('flaky');
        });
        await sync.setValueAndAwait(1);
        expect(seen).toEqual([1, 1, 1]);
    });

    it('only the latest of several rapid values is processed after the current one', async () => {
        const seen: number[] = [];
        const sync = new ValueSync<number>(async (v) => { seen.push(v); await tick(); });
        sync.setValue(1);
        sync.setValue(2);
        sync.setValue(3);
        await sync.awaitQueue();
        expect(seen).toEqual([1, 3]);
    });
});
