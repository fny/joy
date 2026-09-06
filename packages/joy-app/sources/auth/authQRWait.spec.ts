import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const post = vi.fn();
vi.mock('axios', () => ({ default: { post: (...args: unknown[]) => post(...args) } }));
vi.mock('@/sync/serverConfig', () => ({
    getServerUrl: () => 'https://relay.test:4997',
    relayAccessKeyHeaders: () => ({ 'X-Joy-Relay-Key': 'gate-key' }),
}));
vi.mock('@/sync/clientId', () => ({ getJoyClientId: () => 'test-client' }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('@/encryption/libsodium', () => ({
    decryptBox: vi.fn(() => new Uint8Array(32).fill(7)),
}));

import { authQRWait } from './authQRWait';

const keypair = { publicKey: new Uint8Array(32).fill(1), secretKey: new Uint8Array(32).fill(2) };
const authorized = { data: { state: 'authorized', token: 'tok', response: 'AAAA' } };

describe('authQRWait', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        post.mockReset();
        vi.spyOn(console, 'log').mockImplementation(() => {});
    });
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('keeps polling after a transient failure instead of ending the flow (#89)', async () => {
        post
            .mockRejectedValueOnce(new Error('network down'))
            .mockResolvedValueOnce({ data: { state: 'pending' } })
            .mockResolvedValueOnce(authorized);

        const result = authQRWait(keypair);
        // failure → 2s retry wait → pending → 1s → authorized
        await vi.advanceTimersByTimeAsync(2_100);
        await vi.advanceTimersByTimeAsync(1_100);
        const credentials = await result;

        expect(post).toHaveBeenCalledTimes(3);
        expect(credentials).toEqual({ kind: 'authorized', credentials: { token: 'tok', secret: new Uint8Array(32).fill(7) } });
    });

    it('sends the relay perimeter key with every poll (#186)', async () => {
        post.mockResolvedValueOnce(authorized);
        await authQRWait(keypair);
        const config = post.mock.calls[0][2] as { headers: Record<string, string> };
        expect(config.headers['X-Joy-Relay-Key']).toBe('gate-key');
        expect(config.headers['X-Joy-Client']).toBe('test-client');
    });

    it('does not hand out credentials for an attempt cancelled while its poll was in flight (#191)', async () => {
        let resolvePoll!: (value: unknown) => void;
        let signal: AbortSignal | undefined;
        post.mockImplementationOnce((_url: string, _body: unknown, config: { signal?: AbortSignal }) => {
            signal = config.signal;
            return new Promise((resolve) => { resolvePoll = resolve; });
        });
        let cancelled = false;

        const result = authQRWait(keypair, undefined, () => cancelled);
        await vi.advanceTimersByTimeAsync(0);
        cancelled = true;
        // the watchdog aborts the outstanding request as soon as it notices
        await vi.advanceTimersByTimeAsync(300);
        expect(signal?.aborted).toBe(true);
        // …and even if the answer still arrives, it is not returned
        resolvePoll(authorized);
        await expect(result).resolves.toEqual({ kind: 'cancelled' });
        expect(post).toHaveBeenCalledTimes(1);
    });

    it('stops on a consumed or expired request without retrying (#70)', async () => {
        post.mockResolvedValueOnce({ data: { state: 'consumed' } });
        await expect(authQRWait(keypair)).resolves.toEqual({ kind: 'failed', message: 'errors.pairingCodeExpired' });
        expect(post).toHaveBeenCalledTimes(1);
    });

    it('hands the relay\'s own explanation for a consumed request to the screen — the one line the user sees', async () => {
        post.mockResolvedValueOnce({ data: { state: 'consumed', message: 'Already used on another device', consumedAt: 1_700_000_000_000 } });
        await expect(authQRWait(keypair)).resolves.toEqual({ kind: 'failed', message: 'Already used on another device' });
    });

    it('an expired request is reported as the expired code, never as a generic failure', async () => {
        post.mockResolvedValueOnce({ data: { state: 'expired' } });
        await expect(authQRWait(keypair)).resolves.toEqual({ kind: 'failed', message: 'errors.pairingCodeExpired' });
    });

    it('returns null immediately when cancelled before the first poll', async () => {
        await expect(authQRWait(keypair, undefined, () => true)).resolves.toEqual({ kind: 'cancelled' });
        expect(post).not.toHaveBeenCalled();
    });
});
