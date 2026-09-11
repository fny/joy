import { describe, it, expect, vi, beforeEach } from 'vitest';

const setServerUrl = vi.fn();
const reloadAsync = vi.fn(async () => {});
vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
vi.mock('expo-updates', () => ({ reloadAsync: () => reloadAsync() }));
vi.mock('./serverConfig', () => ({
    setServerUrl: (...args: unknown[]) => setServerUrl(...args),
}));

import { switchRelayAndReload } from './relaySwitch';

describe('switchRelayAndReload', () => {
    beforeEach(() => {
        setServerUrl.mockReset();
        reloadAsync.mockClear();
    });

    it('saves the chosen relay and reloads', async () => {
        await switchRelayAndReload('https://relay.example.test:4997');
        expect(setServerUrl).toHaveBeenCalledWith('https://relay.example.test:4997');
        expect(reloadAsync).toHaveBeenCalledTimes(1);
    });

    it('null forgets the relay, so the welcome screen asks again', async () => {
        await switchRelayAndReload(null);
        expect(setServerUrl).toHaveBeenCalledWith(null);
    });

    it('still reloads when the dev runtime refuses (ERR_UPDATES_DISABLED)', async () => {
        reloadAsync.mockRejectedValueOnce(new Error('ERR_UPDATES_DISABLED'));
        vi.spyOn(console, 'log').mockImplementation(() => {});
        await expect(switchRelayAndReload('https://relay.example.test')).resolves.toBeUndefined();
    });
});
