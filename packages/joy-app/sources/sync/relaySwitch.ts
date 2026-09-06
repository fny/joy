import { Platform } from 'react-native';
import * as Updates from 'expo-updates';
import { setServerUrl } from './serverConfig';
import { authGetToken } from '@/auth/authGetToken';
import { TokenStorage } from '@/auth/tokenStorage';
import { decodeBase64 } from '@/encryption/base64';

/** Log into a relay with a secret key and persist the credentials under that
 *  relay's own storage key, so a switch to it boots straight into a logged-in
 *  state. The relay auto-creates the account on first contact, so any valid
 *  32-byte key works — including the key of the currently active account.
 *  Does not touch the active relay's session. */
export async function loginToRelay(url: string, secretB64url: string): Promise<void> {
    const secret = decodeBase64(secretB64url, 'base64url');
    if (secret.length !== 32) {
        throw new Error('Invalid secret key');
    }
    const token = await authGetToken(secret, url);
    if (!token) {
        throw new Error('Failed to authenticate with relay');
    }
    const saved = await TokenStorage.setCredentials({ token, secret: secretB64url }, url);
    if (!saved) {
        throw new Error('Failed to save credentials');
    }
}

/** Switch the active relay and reload the app. The sync engine binds endpoint
 *  and token once at syncInit, so a relay change only takes effect through a full
 *  reload — the same pattern logout uses. After the reload, bootstrap picks up
 *  the new relay's own credentials (or none, landing on the pairing screen).
 *
 *  `null` means "restore the environment/config default" (the Reset button);
 *  an explicit URL is ALWAYS persisted — the built-in relay included. Storing
 *  the built-in URL as "unset" made getServerUrl fall through to
 *  EXPO_PUBLIC_JOY_SERVER_URL / __JOY_CONFIG__, so a build pointed at a custom
 *  relay could never select the built-in one (#397). */
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
