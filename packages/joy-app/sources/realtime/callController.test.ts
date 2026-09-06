import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CallController, raceStart } from './callController';
import { ConnectAttemptCancelled, ConnectAttemptTimeout } from './connectAttempt';

function deferred<T = void>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}
const flush = () => vi.advanceTimersByTimeAsync(0);

describe('raceStart bounds both connect stages (#244, #339)', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it('endSession while the SDK start is still pending settles the attempt at once and closes the late room', async () => {
        const c = new CallController();
        const attempt = c.begin(1, 20_000);
        const sdk = deferred();
        const close = vi.fn(async () => {});
        const race = raceStart(attempt, () => sdk.promise, close);
        // The strip is closed: nothing waits for the SDK any more.
        expect(c.end()).toEqual([1]);
        await expect(race).rejects.toBeInstanceOf(ConnectAttemptCancelled);
        expect(close).not.toHaveBeenCalled();
        // The SDK finishes later: its instance is closed, nothing is published.
        sdk.resolve();
        await flush();
        expect(close).toHaveBeenCalledTimes(1);
        expect(c.onConnect(1)).toBe('orphan');
        expect(c.live).toBeNull();
    });

    it('the deadline covers an SDK start that never resolves', async () => {
        const c = new CallController();
        const attempt = c.begin(1, 20_000);
        const close = vi.fn(async () => {});
        const race = raceStart(attempt, () => new Promise(() => {}), close);
        vi.advanceTimersByTime(19_999);
        expect(attempt.pending).toBe(true);
        vi.advanceTimersByTime(1);
        await expect(race).rejects.toBeInstanceOf(ConnectAttemptTimeout);
    });

    it('the deadline covers a resolved SDK start whose room never comes up (#339)', async () => {
        const c = new CallController();
        const attempt = c.begin(1, 20_000);
        const race = raceStart(attempt, async () => {}, async () => {});
        await flush();
        expect(attempt.pending).toBe(true); // resolved SDK call is not a connect
        vi.advanceTimersByTime(20_000);
        await expect(race).rejects.toBeInstanceOf(ConnectAttemptTimeout);
    });

    it('a pre-connect LiveKit error after SDK setup fails the attempt so the retry chain continues (#339)', async () => {
        const c = new CallController();
        const attempt = c.begin(1, 20_000);
        const race = raceStart(attempt, async () => {}, async () => {});
        await flush();
        expect(c.onError(1, 'LiveKit: could not connect')).toBe('attempt-failed');
        await expect(race).rejects.toThrow('LiveKit: could not connect');
        // The late disconnect for the same failure owns nothing any more.
        expect(c.onDisconnect(1, new Error('closed'))).toBe('stale');
    });

    it('an SDK start that rejects fails the attempt without closing anything', async () => {
        const c = new CallController();
        const attempt = c.begin(1, 20_000);
        const close = vi.fn(async () => {});
        const race = raceStart(attempt, async () => { throw new Error('bad token'); }, close);
        await expect(race).rejects.toThrow('bad token');
        expect(close).not.toHaveBeenCalled();
    });

    it('a start that throws synchronously is a failed attempt, not an unhandled throw', async () => {
        const c = new CallController();
        const attempt = c.begin(1, 20_000);
        const race = raceStart(attempt, () => { throw new Error('not mounted'); }, async () => {});
        await expect(race).rejects.toThrow('not mounted');
    });

    it('onConnect on the owning instance resolves the attempt', async () => {
        const c = new CallController();
        const attempt = c.begin(1, 20_000);
        const close = vi.fn(async () => {});
        const race = raceStart(attempt, async () => {}, close);
        await flush();
        expect(c.onConnect(1)).toBe('connected');
        await expect(race).resolves.toBeUndefined();
        expect(c.live).toBe(1);
        expect(close).not.toHaveBeenCalled();
        expect(c.onConnect(1)).toBe('duplicate');
    });
});

describe('CallController fences callbacks to their instance', () => {
    it('a late onConnect after cancellation is an orphan, never a connected call (#244)', () => {
        const c = new CallController();
        c.begin(1, 0);
        c.end();
        expect(c.onConnect(1)).toBe('orphan');
        expect(c.live).toBeNull();
        expect(c.pending).toBeNull();
    });

    it('a connect from another instance than the attempt owner is an orphan', () => {
        const c = new CallController();
        const attempt = c.begin(2, 0);
        expect(c.onConnect(1)).toBe('orphan');
        expect(attempt.pending).toBe(true);
        expect(c.onConnect(2)).toBe('connected');
    });

    it('a new attempt cancels the previous one; each instance closes only itself', () => {
        const c = new CallController();
        const first = c.begin(1, 0);
        const second = c.begin(2, 0);
        expect(first.outcome).toBe('cancelled');
        expect(second.pending).toBe(true);
        expect(c.pendingOwner).toBe(2);
        // The old instance's late callbacks own nothing.
        expect(c.onConnect(1)).toBe('orphan');
        expect(c.onDisconnect(1, new Error('x'))).toBe('stale');
        expect(second.pending).toBe(true);
    });

    it('unmounting an old instance does not cancel the attempt of the one that replaced it', () => {
        const c = new CallController();
        c.begin(1, 0);
        const attempt = c.begin(2, 0);
        expect(c.release(1)).toBe(false);
        expect(attempt.pending).toBe(true);
        expect(c.release(2)).toBe(true);
        expect(attempt.outcome).toBe('cancelled');
    });

    it('a stale onDisconnect cannot tear down a newer live call', () => {
        const c = new CallController();
        c.begin(1, 0);
        c.onConnect(1);
        c.onDisconnect(1, new Error('dropped'));
        c.begin(2, 0);
        c.onConnect(2);
        expect(c.onDisconnect(1, new Error('late'))).toBe('stale');
        expect(c.live).toBe(2);
        expect(c.onDisconnect(2, new Error('real'))).toBe('live-dropped');
        expect(c.live).toBeNull();
    });

    it('errors on a live call are recoverable; before connect they fail the attempt', () => {
        const c = new CallController();
        const attempt = c.begin(1, 0);
        c.onConnect(1);
        expect(c.onError(1, 'tool missing')).toBe('live-error');
        expect(c.live).toBe(1);
        expect(attempt.outcome).toBe('connected');
        expect(c.onError(7, 'whatever')).toBe('stale');
    });

    it('end() names the pending and live instances to close, then owns nothing', () => {
        const c = new CallController();
        c.begin(1, 0);
        c.onConnect(1);
        expect(c.end()).toEqual([1]);
        expect(c.live).toBeNull();
        expect(c.end()).toEqual([]);
        expect(c.owns(1)).toBe(false);
    });
});
