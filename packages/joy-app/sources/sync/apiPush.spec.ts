import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./serverConfig', () => ({ getServerUrl: () => 'https://relay.test' }));
vi.mock('./clientId', () => ({ getJoyClientId: () => 'test-client' }));

import { PUSH_API_MAX_ATTEMPTS, unregisterPushToken, registerPushToken } from './apiPush';

const creds = { token: 'tok', secret: 'sec' } as any;

async function settle<T>(p: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
    // Drain every retry delay (bounded, so this terminates).
    const outcome = p.then((value) => ({ ok: true as const, value }), (error) => ({ ok: false as const, error }));
    await vi.runAllTimersAsync();
    return outcome;
}

describe('push-token API retries are bounded (#9)', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.spyOn(console, 'warn').mockImplementation(() => {});
    });
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it('unregister settles (rejects) after a bounded number of network failures', async () => {
        const fetchMock = vi.fn().mockRejectedValue(new TypeError('Network request failed'));
        vi.stubGlobal('fetch', fetchMock);
        const result = await settle(unregisterPushToken(creds, 'ExponentPushToken[abc]'));
        expect(result.ok).toBe(false);
        expect(fetchMock).toHaveBeenCalledTimes(PUSH_API_MAX_ATTEMPTS);
    });

    it('does not retry a definitive 401', async () => {
        const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({}) });
        vi.stubGlobal('fetch', fetchMock);
        const result = await settle(registerPushToken(creds, 'ExponentPushToken[abc]'));
        expect(result.ok).toBe(false);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('treats a 404 on delete as already unregistered', async () => {
        const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({}) });
        vi.stubGlobal('fetch', fetchMock);
        const result = await settle(unregisterPushToken(creds, 'ExponentPushToken[abc]'));
        expect(result.ok).toBe(true);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('retries a 5xx and returns once the relay answers', async () => {
        const fetchMock = vi.fn()
            .mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) })
            .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ success: true }) });
        vi.stubGlobal('fetch', fetchMock);
        const result = await settle(registerPushToken(creds, 'ExponentPushToken[abc]'));
        expect(result.ok).toBe(true);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });
});
