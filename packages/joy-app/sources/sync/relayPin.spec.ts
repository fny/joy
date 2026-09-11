import { describe, it, expect, vi } from 'vitest';

vi.mock('./serverConfig', () => ({ hasServerUrl: () => false, setServerUrl: vi.fn() }));
vi.mock('@/auth/tokenStorage', () => ({ TokenStorage: { getCredentials: vi.fn() } }));

import { pinRetiredBuiltinRelay, RETIRED_BUILTIN_RELAY, type RelayPinDeps } from './relayPin';

function deps(o: { saved?: boolean; creds?: boolean }) {
    const set = vi.fn();
    const asked: string[] = [];
    const d: RelayPinDeps = {
        hasServerUrl: () => !!o.saved,
        setServerUrl: set,
        getCredentials: async (url) => { asked.push(url); return o.creds ? { token: 't', secret: 's' } : null; },
    };
    return { d, set, asked };
}

describe('pinRetiredBuiltinRelay', () => {
    it('a signed-in install on the old fallback gets that relay saved, and stays signed in', async () => {
        const { d, set, asked } = deps({ creds: true });
        expect(await pinRetiredBuiltinRelay(d)).toBe(true);
        expect(asked).toEqual([RETIRED_BUILTIN_RELAY]);
        expect(set).toHaveBeenCalledWith(RETIRED_BUILTIN_RELAY);
    });

    it('an install that already saved a relay is left alone — the credential store is not even asked', async () => {
        const { d, set, asked } = deps({ saved: true, creds: true });
        expect(await pinRetiredBuiltinRelay(d)).toBe(false);
        expect(asked).toEqual([]);
        expect(set).not.toHaveBeenCalled();
    });

    it('a fresh or signed-out install saves nothing, so the welcome screen asks', async () => {
        const { d, set } = deps({ creds: false });
        expect(await pinRetiredBuiltinRelay(d)).toBe(false);
        expect(set).not.toHaveBeenCalled();
    });
});
