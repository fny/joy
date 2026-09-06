import { describe, it, expect, vi, beforeEach } from 'vitest';

const setServerUrl = vi.fn();
const reloadAsync = vi.fn(async () => {});
vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
vi.mock('expo-updates', () => ({ reloadAsync: () => reloadAsync() }));
vi.mock('./serverConfig', () => ({
    setServerUrl: (...args: unknown[]) => setServerUrl(...args),
    DEFAULT_SERVER_URL: 'https://joy.voltai.party:4997',
}));
vi.mock('@/auth/authGetToken', () => ({ authGetToken: vi.fn() }));
vi.mock('@/auth/tokenStorage', () => ({ TokenStorage: { setCredentials: vi.fn() } }));

import { switchRelayAndReload } from './relaySwitch';

describe('switchRelayAndReload', () => {
    beforeEach(() => {
        setServerUrl.mockReset();
        reloadAsync.mockClear();
    });

    it('persists an explicitly selected built-in relay instead of clearing it (#397)', async () => {
        await switchRelayAndReload('https://joy.voltai.party:4997');
        expect(setServerUrl).toHaveBeenCalledWith('https://joy.voltai.party:4997');
        expect(reloadAsync).toHaveBeenCalledTimes(1);
    });

    it('persists a custom relay', async () => {
        await switchRelayAndReload('https://custom.example');
        expect(setServerUrl).toHaveBeenCalledWith('https://custom.example');
    });

    it('reserves null for restoring the environment/config default', async () => {
        await switchRelayAndReload(null);
        expect(setServerUrl).toHaveBeenCalledWith(null);
    });

    it('still reloads when the dev runtime refuses (ERR_UPDATES_DISABLED)', async () => {
        reloadAsync.mockRejectedValueOnce(new Error('ERR_UPDATES_DISABLED'));
        vi.spyOn(console, 'log').mockImplementation(() => {});
        await expect(switchRelayAndReload('https://custom.example')).resolves.toBeUndefined();
    });
});
