import { Platform } from 'react-native';
import * as Updates from 'expo-updates';
import { setServerUrl, DEFAULT_SERVER_URL } from './serverConfig';

/** Switch the active relay and reload the app. apiSocket binds endpoint and
 *  token once at syncInit, so a relay change only takes effect through a full
 *  reload — the same pattern logout uses. After the reload, bootstrap picks up
 *  the new relay's own credentials (or none, landing on the pairing screen). */
export async function switchRelayAndReload(url: string | null): Promise<void> {
    // The default relay is stored as "unset" so env/config overrides keep working.
    setServerUrl(url === DEFAULT_SERVER_URL ? null : url);
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
