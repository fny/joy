import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { getServerUrl, relayKeyForUrl } from '@/sync/serverConfig';

const AUTH_KEY = 'auth_credentials';

/** Credentials are stored per relay: every relay (the default one included)
 *  gets its own key suffixed with host[_port] — mirroring the daemon's
 *  ~/.joy/relays/<host[_port]>/. */
function authKeyForUrl(serverUrl: string): string {
    return `${AUTH_KEY}.${relayKeyForUrl(serverUrl)}`;
}

export interface AuthCredentials {
    token: string;
    secret: string;
}

/** All operations default to the active relay; pass a URL to address another
 *  relay's account (e.g. the per-relay list on the account page). */
export const TokenStorage = {
    async getCredentials(serverUrl: string = getServerUrl()): Promise<AuthCredentials | null> {
        const key = authKeyForUrl(serverUrl);
        if (Platform.OS === 'web') {
            const stored = localStorage.getItem(key);
            return stored ? JSON.parse(stored) as AuthCredentials : null;
        }
        try {
            const stored = await SecureStore.getItemAsync(key);
            if (!stored) return null;
            return JSON.parse(stored) as AuthCredentials;
        } catch (error) {
            console.error('Error getting credentials:', error);
            return null;
        }
    },

    async setCredentials(credentials: AuthCredentials, serverUrl: string = getServerUrl()): Promise<boolean> {
        const key = authKeyForUrl(serverUrl);
        if (Platform.OS === 'web') {
            localStorage.setItem(key, JSON.stringify(credentials));
            return true;
        }
        try {
            await SecureStore.setItemAsync(key, JSON.stringify(credentials));
            return true;
        } catch (error) {
            console.error('Error setting credentials:', error);
            return false;
        }
    },

    async removeCredentials(serverUrl: string = getServerUrl()): Promise<boolean> {
        const key = authKeyForUrl(serverUrl);
        if (Platform.OS === 'web') {
            localStorage.removeItem(key);
            return true;
        }
        try {
            await SecureStore.deleteItemAsync(key);
            return true;
        } catch (error) {
            console.error('Error removing credentials:', error);
            return false;
        }
    },
};
