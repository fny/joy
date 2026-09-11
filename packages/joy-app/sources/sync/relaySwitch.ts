import { Platform } from 'react-native';
import * as Updates from 'expo-updates';
import { setServerUrl } from './serverConfig';

/** Set (or, with null, forget) the relay and reload the app. The sync engine
 *  binds endpoint and token once at syncInit, and some modules open the
 *  relay's store at import, so a relay only takes effect through a full
 *  reload — the same pattern logout uses. There is one relay: the welcome
 *  screen sets it, and forgetting it (after signing out) returns there. */
export async function switchRelayAndReload(url: string | null): Promise<void> {
    setServerUrl(url);
    if (Platform.OS === 'web') {
        window.location.reload();
    } else {
        try {
            await Updates.reloadAsync();
        } catch (error) {
            // In dev mode, reloadAsync throws ERR_UPDATES_DISABLED
            console.log('Reload failed (expected in dev mode):', error);
        }
    }
}
