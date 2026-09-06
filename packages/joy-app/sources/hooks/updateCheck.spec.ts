import { describe, expect, it, vi } from 'vitest';
import { createUpdateChecker, performUpdateCheck, type UpdateCheckApi } from './updateCheck';

function api(over: Partial<UpdateCheckApi> = {}): UpdateCheckApi {
    return {
        checkForUpdateAsync: vi.fn().mockResolvedValue({ isAvailable: false, isRollBackToEmbedded: false }),
        fetchUpdateAsync: vi.fn().mockResolvedValue({ isNew: false, isRollBackToEmbedded: false }),
        ...over,
    };
}

describe('performUpdateCheck', () => {
    it('no update and no rollback → none, nothing fetched', async () => {
        const a = api();
        expect(await performUpdateCheck(a)).toEqual({ kind: 'none' });
        expect(a.fetchUpdateAsync).not.toHaveBeenCalled();
    });

    it('a rollback-to-embedded directive is fetched and offered for reload (#328)', async () => {
        const a = api({
            checkForUpdateAsync: vi.fn().mockResolvedValue({ isAvailable: false, isRollBackToEmbedded: true, manifest: undefined }),
            fetchUpdateAsync: vi.fn().mockResolvedValue({ isNew: false, isRollBackToEmbedded: true, manifest: undefined }),
        });
        expect(await performUpdateCheck(a)).toEqual({ kind: 'ready', rollback: true, pending: null });
        expect(a.fetchUpdateAsync).toHaveBeenCalledTimes(1);
    });

    it('an available update whose fetch returns isNew:false is NOT reported ready (#329)', async () => {
        const a = api({
            checkForUpdateAsync: vi.fn().mockResolvedValue({ isAvailable: true, isRollBackToEmbedded: false, manifest: { id: 'm1' } }),
            fetchUpdateAsync: vi.fn().mockResolvedValue({ isNew: false, isRollBackToEmbedded: false }),
        });
        expect(await performUpdateCheck(a)).toEqual({ kind: 'none' });
    });

    it('a fetched new update is ready with metadata from the FETCHED manifest', async () => {
        const a = api({
            checkForUpdateAsync: vi.fn().mockResolvedValue({ isAvailable: true, isRollBackToEmbedded: false, manifest: { id: 'checked' } }),
            fetchUpdateAsync: vi.fn().mockResolvedValue({ isNew: true, isRollBackToEmbedded: false, manifest: { id: 'fetched', runtimeVersion: '7' } }),
        });
        expect(await performUpdateCheck(a)).toEqual({
            kind: 'ready',
            rollback: false,
            pending: { ota_version: 'fetched', ota_runtime_version: '7' },
        });
    });
});

describe('createUpdateChecker (#327)', () => {
    it('a second check while one is in flight starts nothing and resolves null', async () => {
        let resolveCheck!: (v: { isAvailable: boolean; isRollBackToEmbedded: boolean }) => void;
        const a = api({
            checkForUpdateAsync: vi.fn(() => new Promise<{ isAvailable: boolean; isRollBackToEmbedded: boolean }>((r) => { resolveCheck = r; })),
        });
        const checker = createUpdateChecker(a);
        const first = checker.check();          // initial check
        expect(checker.busy).toBe(true);
        const second = await checker.check();   // app foregrounded mid-check
        expect(second).toBeNull();
        expect(a.checkForUpdateAsync).toHaveBeenCalledTimes(1);
        expect(checker.busy).toBe(true);        // the first is still running
        resolveCheck({ isAvailable: false, isRollBackToEmbedded: false });
        expect(await first).toEqual({ kind: 'none' });
        expect(checker.busy).toBe(false);
    });

    it('a rejected check releases the guard', async () => {
        const a = api({ checkForUpdateAsync: vi.fn().mockRejectedValue(new Error('offline')) });
        const checker = createUpdateChecker(a);
        await expect(checker.check()).rejects.toThrow('offline');
        expect(checker.busy).toBe(false);
        await expect(checker.check()).rejects.toThrow('offline');
        expect(a.checkForUpdateAsync).toHaveBeenCalledTimes(2);
    });
});
