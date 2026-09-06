import { describe, it, expect, vi } from 'vitest';
import { createAccountOnce, isCreatingAccount } from './createAccountFlow';

function deferred<T>() {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => { resolve = r; });
    return { promise, resolve };
}

describe('createAccountOnce (#149)', () => {
    it('refuses a second press while the first creation is in flight, so only one secret is ever logged in', async () => {
        const tokenGate = deferred<string>();
        let counter = 0;
        const login = vi.fn(async () => {});
        const deps = {
            randomBytes: vi.fn(async () => new Uint8Array(32).fill(++counter)),
            getToken: vi.fn(() => tokenGate.promise),
            login,
        };

        const first = createAccountOnce(deps);
        expect(isCreatingAccount()).toBe(true);
        // the "remounted button" press
        await expect(createAccountOnce(deps)).resolves.toBe('busy');
        expect(deps.randomBytes).toHaveBeenCalledTimes(1);

        tokenGate.resolve('tok');
        await expect(first).resolves.toBe('created');
        expect(login).toHaveBeenCalledTimes(1);
        expect(login).toHaveBeenCalledWith('tok', new Uint8Array(32).fill(1));
        expect(isCreatingAccount()).toBe(false);
    });

    it('releases the guard after a failure so the user can try again', async () => {
        const deps = {
            randomBytes: async () => new Uint8Array(32),
            getToken: vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce('tok'),
            login: vi.fn(async () => {}),
        };
        await expect(createAccountOnce(deps)).rejects.toThrow('offline');
        expect(isCreatingAccount()).toBe(false);
        await expect(createAccountOnce(deps)).resolves.toBe('created');
    });

    it('does not log in when the relay returns no token', async () => {
        const login = vi.fn(async () => {});
        await expect(createAccountOnce({
            randomBytes: async () => new Uint8Array(32),
            getToken: async () => null,
            login,
        })).resolves.toBe('no_token');
        expect(login).not.toHaveBeenCalled();
    });
});
