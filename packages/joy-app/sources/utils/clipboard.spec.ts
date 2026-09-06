import { describe, it, expect, vi, beforeEach } from 'vitest';

const setStringAsync = vi.fn<(text: string) => Promise<boolean>>();
const alert = vi.fn();
vi.mock('expo-clipboard', () => ({ setStringAsync: (text: string) => setStringAsync(text) }));
vi.mock('@/modal', () => ({ Modal: { alert: (...a: unknown[]) => alert(...a) } }));
vi.mock('@/log', () => ({ log: { log: vi.fn() } }));
vi.mock('@/text', () => ({ t: (key: string) => key }));

import { copyToClipboard } from './clipboard';

describe('copyToClipboard — success feedback only when the write landed', () => {
    beforeEach(() => {
        setStringAsync.mockReset();
        alert.mockReset();
        vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    it('a successful write returns true and shows nothing', async () => {
        setStringAsync.mockResolvedValue(true);
        expect(await copyToClipboard('abc')).toBe(true);
        expect(setStringAsync).toHaveBeenCalledWith('abc');
        expect(alert).not.toHaveBeenCalled();
    });

    it('a refused write (expo resolves false) returns false and shows the copy-failed error', async () => {
        setStringAsync.mockResolvedValue(false);
        expect(await copyToClipboard('abc')).toBe(false);
        expect(alert).toHaveBeenCalledWith('common.error', 'common.copyFailed');
    });

    it('a rejected write is caught, returns false and shows the error', async () => {
        setStringAsync.mockRejectedValue(new Error('denied'));
        expect(await copyToClipboard('abc')).toBe(false);
        expect(alert).toHaveBeenCalledTimes(1);
    });

    it('a non-boolean resolution is not mistaken for success', async () => {
        setStringAsync.mockResolvedValue(undefined as unknown as boolean);
        expect(await copyToClipboard('abc')).toBe(false);
    });

    it('failureMessage replaces the generic text; silent suppresses the alert', async () => {
        setStringAsync.mockResolvedValue(false);
        await copyToClipboard('abc', { failureMessage: 'sessionInfo.failedToCopyMetadata' });
        expect(alert).toHaveBeenCalledWith('common.error', 'sessionInfo.failedToCopyMetadata');
        alert.mockReset();
        expect(await copyToClipboard('abc', { silent: true })).toBe(false);
        expect(alert).not.toHaveBeenCalled();
    });
});
