/**
 * #610: POST /auth/response answers 410 request_expired when the QR aged out
 * before the approval landed. authApprove must say "the code expired — scan
 * again" (alert + typed error), not a generic connect failure.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const alert = vi.fn();
const post = vi.fn();
const get = vi.fn();
vi.mock('axios', () => ({
    default: {
        get: (...a: unknown[]) => get(...a),
        post: (...a: unknown[]) => post(...a),
        isAxiosError: (e: unknown) => !!(e as { isAxiosError?: boolean })?.isAxiosError,
    },
}));
vi.mock('@/modal', () => ({ Modal: { alert: (...a: unknown[]) => alert(...a) } }));
vi.mock('@/text', () => ({ t: (k: string) => k }));
vi.mock('@/sync/serverConfig', () => ({ getServerUrl: () => 'https://relay' }));
vi.mock('@/sync/clientId', () => ({ getJoyClientId: () => 'test' }));

describe('authApprove', () => {
    beforeEach(() => { alert.mockReset(); post.mockReset(); get.mockReset(); });

    it('410 request_expired → PairingCodeExpiredError carrying the translated line, shown once', async () => {
        const { authApprove, PairingCodeExpiredError } = await import('./authApprove');
        get.mockResolvedValue({ data: { status: 'pending' } });
        post.mockRejectedValue({ isAxiosError: true, response: { status: 410, data: { error: 'request_expired' } } });
        await expect(authApprove('tok', new Uint8Array(32), new Uint8Array(8))).rejects.toBeInstanceOf(PairingCodeExpiredError);
        await expect(authApprove('tok', new Uint8Array(32), new Uint8Array(8))).rejects.toMatchObject({ message: 'errors.pairingCodeExpired' });
        expect(alert).toHaveBeenCalledWith('common.error', 'errors.pairingCodeExpired', expect.anything());
    });

    it('other failures pass through untouched', async () => {
        const { authApprove } = await import('./authApprove');
        get.mockResolvedValue({ data: { status: 'pending' } });
        post.mockRejectedValue({ isAxiosError: true, response: { status: 404, data: { error: 'request_not_found' } } });
        await expect(authApprove('tok', new Uint8Array(32), new Uint8Array(8))).rejects.toMatchObject({ response: { status: 404 } });
        expect(alert).not.toHaveBeenCalled();
    });

    it('a pending request is answered with the sealed bundle', async () => {
        const { authApprove } = await import('./authApprove');
        get.mockResolvedValue({ data: { status: 'pending' } });
        post.mockResolvedValue({ data: { success: true } });
        await authApprove('tok', new Uint8Array(32), new Uint8Array([1, 2, 3]));
        expect(post).toHaveBeenCalledWith('https://relay/joy/v2/auth/response', expect.objectContaining({ response: 'AQID' }), expect.anything());
    });
});
