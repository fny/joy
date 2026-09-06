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
// The proof derivation has its own vector test (encryption/pairingProof.spec.ts);
// here it is a legible function of the handshake so the POLL is what is asserted.
// (expo-crypto, which the real derivation digests with, drags react-native in.)
vi.mock('expo-crypto', () => ({}));
vi.mock('@/encryption/pairingProof', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/encryption/pairingProof')>()),
    pairingProof: vi.fn(async (_kp: unknown, hs: { challenge: string }) => `proof(${hs.challenge})`),
}));

import { authQRWait } from './authQRWait';

const keypair = { publicKey: new Uint8Array(32).fill(1), secretKey: new Uint8Array(32).fill(2) };
const authorized = { data: { state: 'authorized', token: 'tok', response: 'AAAA' } };
const requested = (challenge: string) => ({ data: { state: 'requested', challenge, relayPublicKey: 'relay-pub' } });
const bodies = () => post.mock.calls.map((c) => c[1] as Record<string, unknown>);
const drain = async (polls: number) => { for (let i = 0; i < polls; i++) await vi.advanceTimersByTimeAsync(1_100); };

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

    // #127: the bearer goes only to the holder of the private key.
    describe('proof of possession (#127)', () => {
        it('proves over the handshake of the LATEST reply once one was handed out', async () => {
            post
                .mockResolvedValueOnce(requested('c1'))
                .mockResolvedValueOnce(requested('c2'))
                .mockResolvedValueOnce(authorized);
            const result = authQRWait(keypair);
            await drain(2);
            await expect(result).resolves.toMatchObject({ kind: 'authorized' });
            expect(bodies().map((b) => b.proof)).toEqual([undefined, 'proof(c1)', 'proof(c2)']);
            expect(bodies().every((b) => typeof b.publicKey === 'string')).toBe(true);
        });

        it('a proof_required answer is polled again WITH the proof', async () => {
            post
                .mockResolvedValueOnce({ data: { state: 'proof_required', error: 'proof_required', challenge: 'c9', relayPublicKey: 'relay-pub' } })
                .mockResolvedValueOnce(authorized);
            const result = authQRWait(keypair);
            await drain(1);
            await expect(result).resolves.toMatchObject({ kind: 'authorized' });
            expect(bodies().map((b) => b.proof)).toEqual([undefined, 'proof(c9)']);
        });

        it('still pairs against a relay that issues no handshake, without ever sending a proof', async () => {
            post
                .mockResolvedValueOnce({ data: { state: 'pending' } })
                .mockResolvedValueOnce({ data: { state: 'requested' } })
                .mockResolvedValueOnce(authorized);
            const result = authQRWait(keypair);
            await drain(2);
            await expect(result).resolves.toMatchObject({ kind: 'authorized' });
            expect(bodies().every((b) => !('proof' in b))).toBe(true);
        });

        it('after a rejected poll the next one goes proof-less and re-learns the handshake instead of repeating a stale proof', async () => {
            post
                .mockResolvedValueOnce(requested('c1'))
                .mockRejectedValueOnce(Object.assign(new Error('401'), { response: { status: 401, data: { error: 'invalid_proof' } } }))
                .mockResolvedValueOnce(requested('c2'))
                .mockResolvedValueOnce(authorized);
            const result = authQRWait(keypair);
            await drain(1);
            await vi.advanceTimersByTimeAsync(2_100); // the retry wait after a failure
            await drain(1);
            await expect(result).resolves.toMatchObject({ kind: 'authorized' });
            expect(bodies().map((b) => b.proof)).toEqual([undefined, 'proof(c1)', undefined, 'proof(c2)']);
        });
    });
});
