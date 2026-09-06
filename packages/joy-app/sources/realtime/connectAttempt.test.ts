import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectAttempt, ConnectAttemptCancelled, ConnectAttemptTimeout } from './connectAttempt';

describe('ConnectAttempt (#339, #244)', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it('resolves on connect and ignores later signals', async () => {
        const a = new ConnectAttempt(1000);
        expect(a.pending).toBe(true);
        expect(a.connected()).toBe(true);
        expect(a.fail(new Error('late'))).toBe(false);
        expect(a.cancel()).toBe(false);
        expect(a.outcome).toBe('connected');
        await expect(a.promise).resolves.toBeUndefined();
    });

    it('rejects on a pre-connect failure with the SDK error', async () => {
        const a = new ConnectAttempt(1000);
        expect(a.fail('LiveKit: could not connect')).toBe(true);
        expect(a.connected()).toBe(false);
        expect(a.outcome).toBe('failed');
        await expect(a.promise).rejects.toThrow('LiveKit: could not connect');
    });

    it('rejects with ConnectAttemptCancelled when ended while pending', async () => {
        const a = new ConnectAttempt(1000);
        expect(a.cancel()).toBe(true);
        expect(a.outcome).toBe('cancelled');
        await expect(a.promise).rejects.toBeInstanceOf(ConnectAttemptCancelled);
    });

    it('times out when nothing settles it', async () => {
        const a = new ConnectAttempt(500);
        vi.advanceTimersByTime(499);
        expect(a.pending).toBe(true);
        vi.advanceTimersByTime(1);
        expect(a.outcome).toBe('timeout');
        await expect(a.promise).rejects.toBeInstanceOf(ConnectAttemptTimeout);
    });

    it('a settled attempt does not time out later', async () => {
        const a = new ConnectAttempt(500);
        a.connected();
        vi.advanceTimersByTime(1000);
        expect(a.outcome).toBe('connected');
        await expect(a.promise).resolves.toBeUndefined();
    });

    it('never times out with a non-positive timeout', () => {
        const a = new ConnectAttempt(0);
        vi.advanceTimersByTime(60_000);
        expect(a.pending).toBe(true);
        a.cancel();
    });

    it('a failure before anyone awaits is not an unhandled rejection', async () => {
        const a = new ConnectAttempt(1000);
        a.fail(new Error('early'));
        await vi.runAllTimersAsync();
        // Awaiting afterwards still sees the rejection.
        await expect(a.promise).rejects.toThrow('early');
    });
});
