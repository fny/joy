import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./serverConfig', () => ({ getServerUrl: () => 'https://relay.test' }));
vi.mock('./clientId', () => ({ getJoyClientId: () => 'client-1' }));

import { PUSH_API_MAX_ATTEMPTS, PUSH_API_TIMEOUT_MS, PushApiTimeoutError, unregisterPushToken } from './apiPush';

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
});
