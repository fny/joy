import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { getServerUrl } from '@/sync/serverConfig';
import { relayKeyForUrl, legacyRelayKeyForUrl, relayKeyNeedsMigration } from '@/sync/relayKey';
import { decodeBase64 } from '@/encryption/base64';
import { parseToken } from '@/utils/parseToken';

const AUTH_KEY = 'auth_credentials';

/** Credentials are stored per relay: every relay (the default one included)
 *  gets its own key suffixed with the relay identifier (relayKey.ts — host
 *  or host_port for https, scheme-prefixed and escaped otherwise, so two
 *  relays never share a slot and the key is always SecureStore-safe; #398,
 *  #192). */
export function authKeyForUrl(serverUrl: string): string {
    return `${AUTH_KEY}.${relayKeyForUrl(serverUrl)}`;
}

/** The pre-#398 key, or null when it is the same as the canonical one. Read
 *  as a fallback and migrated so nobody is logged out by the key change.
 *  On native a legacy key outside SecureStore's alphabet (an IPv6 literal,
 *  #192) could never have been written, and asking SecureStore about it
 *  throws — so there is nothing to migrate there. */
const SECURE_STORE_KEY = /^[A-Za-z0-9._-]+$/;
export function legacyAuthKeyForUrl(serverUrl: string): string | null {
    if (!relayKeyNeedsMigration(serverUrl)) return null;
    const key = `${AUTH_KEY}.${legacyRelayKeyForUrl(serverUrl)}`;
    if (Platform.OS !== 'web' && !SECURE_STORE_KEY.test(key)) return null;
    return key;
}

export interface AuthCredentials {
    token: string;
    secret: string;
}

/** A stored blob is only credentials when it has both string fields. A
 *  corrupted localStorage/SecureStore value used to throw out of
 *  getCredentials on web and take the whole boot down with it (#88). */
export function parseStoredCredentials(stored: string | null | undefined): AuthCredentials | null {
    if (!stored) return null;
    try {
        const parsed = JSON.parse(stored) as Partial<AuthCredentials> | null;
        if (parsed && typeof parsed.token === 'string' && typeof parsed.secret === 'string') {
            return { token: parsed.token, secret: parsed.secret };
        }
    } catch {
        // fall through: unreadable is the same as absent
    }
    console.error('Stored credentials are not readable; ignoring them');
    return null;
}

/** True when the credentials can boot the sync engine: the secret decodes to
 *  the 32-byte master key and the token carries a subject. Anything else
 *  would make syncInit throw on every boot (#88). */
export function areCredentialsUsable(credentials: AuthCredentials): boolean {
    try {
        if (decodeBase64(credentials.secret, 'base64url').length !== 32) return false;
        parseToken(credentials.token);
        return true;
    } catch {
        return false;
    }
}

async function readRaw(key: string): Promise<string | null> {
    if (Platform.OS === 'web') {
        return localStorage.getItem(key);
    }
    try {
        return await SecureStore.getItemAsync(key);
    } catch (error) {
        console.error('Error getting credentials:', error);
        return null;
    }
}

async function writeRaw(key: string, value: string): Promise<boolean> {
    if (Platform.OS === 'web') {
        localStorage.setItem(key, value);
        return true;
    }
    try {
        await SecureStore.setItemAsync(key, value);
        return true;
    } catch (error) {
        console.error('Error setting credentials:', error);
        return false;
    }
}

async function deleteRaw(key: string): Promise<boolean> {
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
}

/** All operations default to the active relay; pass a URL to address another
 *  relay's account (e.g. the per-relay list on the account page). */
export const TokenStorage = {
    async getCredentials(serverUrl: string = getServerUrl()): Promise<AuthCredentials | null> {
        const key = authKeyForUrl(serverUrl);
        const current = parseStoredCredentials(await readRaw(key));
        if (current) return current;

        // #398 migration: a relay whose identifier changed still has its
        // credentials under the legacy key. Move them across once; the legacy
        // slot is removed only after the canonical write succeeded.
        const legacyKey = legacyAuthKeyForUrl(serverUrl);
        if (!legacyKey) return null;
        const legacyRaw = await readRaw(legacyKey);
        const legacy = parseStoredCredentials(legacyRaw);
        if (!legacy || !legacyRaw) return null;
        if (await writeRaw(key, legacyRaw)) {
            await deleteRaw(legacyKey);
        }
        return legacy;
    },

    async setCredentials(credentials: AuthCredentials, serverUrl: string = getServerUrl()): Promise<boolean> {
        return writeRaw(authKeyForUrl(serverUrl), JSON.stringify(credentials));
    },

    /** Resolves false when the store could not delete the value — the caller
     *  must NOT treat the account as logged out then (#188). */
    async removeCredentials(serverUrl: string = getServerUrl()): Promise<boolean> {
        const removed = await deleteRaw(authKeyForUrl(serverUrl));
        // Clear a not-yet-migrated legacy slot too, or a later boot would
        // "restore" the account we just logged out of via the fallback read.
        const legacyKey = legacyAuthKeyForUrl(serverUrl);
        const legacyRemoved = legacyKey ? await deleteRaw(legacyKey) : true;
        return removed && legacyRemoved;
    },
};
