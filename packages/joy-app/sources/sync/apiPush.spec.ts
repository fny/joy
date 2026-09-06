import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./serverConfig', () => ({ getServerUrl: () => 'https://relay.test' }));
vi.mock('./clientId', () => ({ getJoyClientId: () => 'client-1' }));

import { PUSH_API_MAX_ATTEMPTS, PUSH_API_TIMEOUT_MS, PushApiAbortedError, PushApiTimeoutError, fetchPushTokens, registerPushToken, unregisterPushToken } from './apiPush';

const creds = { token: 'tok', secret: 'sec' };

// Drive the bounded retry loop to its end: each attempt lasts one deadline,
// then a jittered delay (<= 4s) before the next.
async function runToCompletion(p: Promise<unknown>): Promise<unknown> {
    let outcome: unknown = 'pending';
    p.then(() => { outcome = 'resolved'; }, (e) => { outcome = e; });
    for (let i = 0; i < PUSH_API_MAX_ATTEMPTS; i++) {
        await vi.advanceTimersByTimeAsync(PUSH_API_TIMEOUT_MS + 5_000);
    }
    return outcome;
}

describe('push API deadlines (#9 residual)', () => {
    const signals: AbortSignal[] = [];
    beforeEach(() => {
        vi.useFakeTimers();
        signals.length = 0;
        vi.spyOn(console, 'warn').mockImplementation(() => {});
    });
    afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

    it('a DELETE the relay accepts but never answers settles after the deadline on every attempt', async () => {
        // Reviewer: attempt count alone is not an I/O bound — the first fetch
        // stayed pending forever, so removePushToken never returned.
        const fetchMock = vi.fn((_url: string, init: { signal: AbortSignal }) => {
            signals.push(init.signal);
            return new Promise<Response>(() => {}); // never resolves, ignores abort
        });
        vi.stubGlobal('fetch', fetchMock);
        const outcome = await runToCompletion(unregisterPushToken(creds, 'T'));
        expect(outcome).toBeInstanceOf(PushApiTimeoutError);
        expect(fetchMock).toHaveBeenCalledTimes(PUSH_API_MAX_ATTEMPTS);
        expect(signals.every((s) => s.aborted)).toBe(true);
    });

    it('a response whose BODY never arrives is bounded by the same deadline', async () => {
        const fetchMock = vi.fn(() => Promise.resolve({
            ok: true,
            status: 200,
            json: () => new Promise<never>(() => {}),
        } as unknown as Response));
        vi.stubGlobal('fetch', fetchMock);
        const outcome = await runToCompletion(unregisterPushToken(creds, 'T'));
        expect(outcome).toBeInstanceOf(PushApiTimeoutError);
        expect(fetchMock).toHaveBeenCalledTimes(PUSH_API_MAX_ATTEMPTS);
    });

    it('a prompt answer still resolves and a 404 counts as already unregistered', async () => {
        vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: false, status: 404 } as Response)));
        await expect(unregisterPushToken(creds, 'T')).resolves.toBeUndefined();
    });

    it('a caller that passes no signal is still bounded: the helper owns the deadline', async () => {
        // Reviewer: the bound must not depend on the caller supplying a
        // signal — the deadline is created inside the helper.
        const fetchMock = vi.fn((_url: string, init: { signal: AbortSignal }) => {
            signals.push(init.signal);
            return new Promise<Response>(() => {});
        });
        vi.stubGlobal('fetch', fetchMock);
        let outcome: unknown = 'pending';
        const p = registerPushToken(creds, 'T');
        p.then(() => { outcome = 'resolved'; }, (e) => { outcome = e; });
        await vi.advanceTimersByTimeAsync(PUSH_API_TIMEOUT_MS - 1);
        expect(signals[0].aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(signals[0].aborted).toBe(true);
        expect(outcome).toBe('pending'); // retried, not given up yet
        for (let i = 0; i < PUSH_API_MAX_ATTEMPTS; i++) {
            await vi.advanceTimersByTimeAsync(PUSH_API_TIMEOUT_MS + 5_000);
        }
        expect(outcome).toBeInstanceOf(PushApiTimeoutError);
        expect(fetchMock).toHaveBeenCalledTimes(PUSH_API_MAX_ATTEMPTS);
    });

    it('a caller signal aborts early, cancels the request and is never retried', async () => {
        const fetchMock = vi.fn((_url: string, init: { signal: AbortSignal }) => {
            signals.push(init.signal);
            return new Promise<Response>((_, reject) => {
                init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
            });
        });
        vi.stubGlobal('fetch', fetchMock);
        const caller = new AbortController();
        let outcome: unknown = 'pending';
        const p = fetchPushTokens(creds, { signal: caller.signal });
        p.then(() => { outcome = 'resolved'; }, (e) => { outcome = e; });
        await vi.advanceTimersByTimeAsync(1_000);
        expect(outcome).toBe('pending');
        caller.abort();
        await vi.advanceTimersByTimeAsync(0);
        expect(outcome).toBeInstanceOf(PushApiAbortedError);
        expect(signals[0].aborted).toBe(true);
        // Well past every backoff delay: no further attempt is started.
        await vi.advanceTimersByTimeAsync(PUSH_API_MAX_ATTEMPTS * (PUSH_API_TIMEOUT_MS + 5_000));
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('an already-aborted caller signal rejects before any request is sent', async () => {
        const fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
        const caller = new AbortController();
        caller.abort();
        await expect(unregisterPushToken(creds, 'T', { signal: caller.signal })).rejects.toBeInstanceOf(PushApiAbortedError);
        expect(fetchMock).not.toHaveBeenCalled();
    });
});
