/**
 * #607: a poll of an already-collected pairing answer comes back
 * `{state:'consumed', error, consumedAt, message}`. authQRWait shows the
 * relay's `message` (it says what happened and what to do) instead of a
 * generic line, and stops polling. An `expired` poll says the code expired.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const alert = vi.fn();
const post = vi.fn();
vi.mock('axios', () => ({ default: { post: (...a: unknown[]) => post(...a) } }));
vi.mock('@/modal', () => ({ Modal: { alert: (...a: unknown[]) => alert(...a) } }));
vi.mock('@/text', () => ({ t: (k: string) => k }));
vi.mock('@/sync/serverConfig', () => ({ getServerUrl: () => 'https://relay' }));
vi.mock('@/sync/clientId', () => ({ getJoyClientId: () => 'test' }));
vi.mock('@/encryption/libsodium', () => ({ decryptBox: () => null }));

const keypair = { publicKey: new Uint8Array(32), secretKey: new Uint8Array(32) } as never;

describe('authQRWait', () => {
    beforeEach(() => { alert.mockReset(); post.mockReset(); });

    it('consumed → shows the relay message, returns null, polls no further', async () => {
        const { authQRWait } = await import('./authQRWait');
        const message = 'This pairing answer was already collected — start a new pairing.';
        post.mockResolvedValue({ data: { state: 'consumed', error: 'pairing_answer_already_collected', consumedAt: 1_800_000_000_000, message } });
        const r = await authQRWait(keypair);
        expect(r).toBeNull();
        expect(post).toHaveBeenCalledTimes(1);
        expect(alert).toHaveBeenCalledWith('common.error', message, expect.anything());
    });

    it('expired → "the code expired" line', async () => {
        const { authQRWait } = await import('./authQRWait');
        post.mockResolvedValue({ data: { state: 'expired' } });
        expect(await authQRWait(keypair)).toBeNull();
        expect(alert).toHaveBeenCalledWith('common.error', 'errors.pairingCodeExpired', expect.anything());
    });
});
