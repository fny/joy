import { describe, it, expect, vi, beforeEach } from 'vitest';

// The file and diff specs' declared retry fires for REAL transport failures:
// the ops layer keeps the failure's kind (no context / transport / daemon)
// instead of flattening everything into success:false, and the specs map it
// to unavailable / thrown (retried) / terminal error. Driven through the real
// ops functions with a mocked machine transport.

let ctx: unknown = { machineId: 'm', localSessionId: 'l', relayUrl: 'r', accountToken: 't', machineKey: new Uint8Array(32) };
const readFile = vi.fn<() => Promise<{ data: unknown }>>();
const gitDiff = vi.fn<() => Promise<{ data: unknown }>>();
vi.mock('@/sync/sync', () => ({ sync: { machineCtx: () => ctx, machineOnlyCtx: () => ctx } }));
vi.mock('@/sync/storage', () => ({ storage: { getState: () => ({ sessions: {} }) } }));
vi.mock('@/sync/v2/api', () => ({ v2: {}, v2ActiveTurn: vi.fn(), v2CancelTurn: vi.fn(), V2ApiError: class extends Error {} }));
vi.mock('@/sync/v2/tunnel', () => ({ tunnelJson: vi.fn() }));
vi.mock('@/sync/v2/machine', () => ({
    machineReadFile: () => readFile(), machineGitDiff: () => gitDiff(),
    machineWriteFile: vi.fn(), machineDeleteFile: vi.fn(), machineGrep: vi.fn(), machineHistory: vi.fn(),
    machineHistoryMessages: vi.fn(), machineKillSession: vi.fn(), machineAbort: vi.fn(),
}));

import { resources } from '@/sync/resource';
import { fileContentsSpec, gitDiffSpec } from '@/sync/fileContents';

let n = 0;
const session = () => `s${++n}`;
beforeEach(() => { readFile.mockReset(); gitDiff.mockReset(); ctx = { machineId: 'm', localSessionId: 'l', relayUrl: 'r', accountToken: 't', machineKey: new Uint8Array(32) }; });

describe('file/diff reads through ops keep the failure kind', () => {
    it('a transport failure is retried the declared number of times, then is an error', async () => {
        readFile.mockRejectedValue(new Error('tunnel temporarily down'));
        gitDiff.mockRejectedValue(new Error('tunnel temporarily down'));
        const sid = session();
        const file = await resources.refresh(fileContentsSpec(sid, '/file'));
        expect(readFile).toHaveBeenCalledTimes(2); // attempts: 1 → one retry
        expect(file).toMatchObject({ hasData: false, error: 'tunnel temporarily down', unavailable: null });
        const diff = await resources.refresh(gitDiffSpec(sid, 'file'));
        expect(gitDiff).toHaveBeenCalledTimes(2);
        expect(diff).toMatchObject({ hasData: false, error: 'tunnel temporarily down' });
    }, 5000);

    it('no machine context is unavailable: no retry, no error', async () => {
        ctx = null;
        const sid = session();
        const file = await resources.refresh(fileContentsSpec(sid, '/file'));
        expect(readFile).not.toHaveBeenCalled();
        expect(file).toMatchObject({ error: null, unavailable: 'read file: machine key not available yet' });
        const diff = await resources.refresh(gitDiffSpec(sid, 'file'));
        expect(gitDiff).not.toHaveBeenCalled();
        expect(diff).toMatchObject({ error: null, unavailable: 'git diff: machine key not available yet' });
    });

    it('a daemon refusal is a terminal error: one attempt', async () => {
        readFile.mockResolvedValue({ data: { success: false, error: 'ENOENT' } });
        gitDiff.mockResolvedValue({ data: { ok: false, error: 'not a git repository' } });
        const sid = session();
        expect(await resources.refresh(fileContentsSpec(sid, '/file'))).toMatchObject({ error: 'ENOENT' });
        expect(readFile).toHaveBeenCalledTimes(1);
        expect(await resources.refresh(gitDiffSpec(sid, 'file'))).toMatchObject({ error: 'not a git repository' });
        expect(gitDiff).toHaveBeenCalledTimes(1);
    });

    it('a successful read after a transport retry lands', async () => {
        readFile.mockRejectedValueOnce(new Error('dropped')).mockResolvedValueOnce({ data: { success: true, content: Buffer.from('hello').toString('base64') } });
        const sid = session();
        const file = await resources.refresh(fileContentsSpec(sid, '/file'));
        expect(readFile).toHaveBeenCalledTimes(2);
        expect(file.data).toMatchObject({ content: 'hello', isBinary: false });
        expect(file.error).toBeNull();
    }, 5000);
});
