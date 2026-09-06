import { describe, it, expect, vi, beforeEach } from 'vitest';

const get = vi.fn();
const post = vi.fn();
vi.mock('axios', () => ({
    default: {
        get: (...args: unknown[]) => get(...args),
        post: (...args: unknown[]) => post(...args),
    },
}));
vi.mock('@/sync/serverConfig', () => ({
    getServerUrl: () => 'https://relay.test:4997',
    relayAccessKeyHeaders: () => ({ 'X-Joy-Relay-Key': 'gate-key' }),
}));
vi.mock('@/sync/clientId', () => ({ getJoyClientId: () => 'test-client' }));
vi.mock('@/text', () => ({ t: (key: string) => key }));

import { authApprove, AuthRequestNotFoundError, PairingCodeExpiredError } from './authApprove';
import { authAccountApprove } from './authAccountApprove';

const publicKey = new Uint8Array(32).fill(1);
const answer = new Uint8Array(33).fill(2);

describe('authApprove (terminal pairing)', () => {
    beforeEach(() => {
        get.mockReset();
        post.mockReset();
        vi.spyOn(console, 'log').mockImplementation(() => {});
    });

    it('rejects a link with no pending request instead of reporting success (#187)', async () => {
        get.mockResolvedValueOnce({ data: { status: 'not_found' } });
        await expect(authApprove('tok', publicKey, answer)).rejects.toBeInstanceOf(AuthRequestNotFoundError);
        expect(post).not.toHaveBeenCalled();
    });

    it('resolves without re-posting when the request is already authorized', async () => {
        get.mockResolvedValueOnce({ data: { status: 'authorized' } });
        await expect(authApprove('tok', publicKey, answer)).resolves.toBeUndefined();
        expect(post).not.toHaveBeenCalled();
    });

    it('posts the answer for a pending request, carrying the relay key on both calls (#186)', async () => {
        get.mockResolvedValueOnce({ data: { status: 'pending' } });
        post.mockResolvedValueOnce({ data: {} });
        await authApprove('tok', publicKey, answer);

        expect(post).toHaveBeenCalledTimes(1);
        const [url, , postConfig] = post.mock.calls[0] as [string, unknown, { headers: Record<string, string> }];
        expect(url).toBe('https://relay.test:4997/joy/v2/auth/response');
        expect(postConfig.headers['X-Joy-Relay-Key']).toBe('gate-key');
        expect(postConfig.headers.Authorization).toBe('Bearer tok');
        const [, getConfig] = get.mock.calls[0] as [string, { headers: Record<string, string> }];
        expect(getConfig.headers['X-Joy-Relay-Key']).toBe('gate-key');
    });

    it('a 410 request_expired answer is the typed expired-code error carrying the user-facing line (#610)', async () => {
        get.mockResolvedValueOnce({ data: { status: 'pending' } });
        post.mockRejectedValueOnce({ response: { status: 410, data: { error: 'request_expired' } } });
        const failure = authApprove('tok', publicKey, answer);
        await expect(failure).rejects.toBeInstanceOf(PairingCodeExpiredError);
        await expect(failure).rejects.toThrow('errors.pairingCodeExpired');
    });

    it('any other approval failure is rethrown untouched', async () => {
        get.mockResolvedValueOnce({ data: { status: 'pending' } });
        post.mockRejectedValueOnce({ response: { status: 500, data: { error: 'boom' } } });
        await expect(authApprove('tok', publicKey, answer)).rejects.toEqual({ response: { status: 500, data: { error: 'boom' } } });
    });

    it('rejects an unknown status rather than treating it as approved', async () => {
        get.mockResolvedValueOnce({ data: { status: 'weird' } });
        await expect(authApprove('tok', publicKey, answer)).rejects.toThrow(/Unexpected/);
    });
});

describe('authAccountApprove (device linking)', () => {
    beforeEach(() => {
        post.mockReset();
    });

    it('carries the relay perimeter key that the fetch interceptor cannot add to axios (#186)', async () => {
        post.mockResolvedValueOnce({ data: {} });
        await authAccountApprove('tok', publicKey, answer);
        const [url, , config] = post.mock.calls[0] as [string, unknown, { headers: Record<string, string> }];
        expect(url).toBe('https://relay.test:4997/joy/v2/auth/account/response');
        expect(config.headers['X-Joy-Relay-Key']).toBe('gate-key');
        expect(config.headers.Authorization).toBe('Bearer tok');
        expect(config.headers['X-Joy-Client']).toBe('test-client');
    });
});
