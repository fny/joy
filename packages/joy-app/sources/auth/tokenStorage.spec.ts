import { describe, it, expect, vi, beforeEach } from 'vitest';
import { encodeBase64 } from '@/encryption/base64';
import { encodeUTF8 } from '@/encryption/text';

// In-memory SecureStore that enforces the real key alphabet: keys may only
// contain alphanumerics, ".", "-" and "_" (expo-secure-store throws otherwise).
const store = new Map<string, string>();
const VALID_KEY = /^[A-Za-z0-9._-]+$/;
let failDelete = false;
function assertKey(key: string) {
    if (!VALID_KEY.test(key)) {
        throw new Error('Invalid key provided to SecureStore');
    }
}
vi.mock('expo-secure-store', () => ({
    getItemAsync: async (key: string) => { assertKey(key); return store.get(key) ?? null; },
    setItemAsync: async (key: string, value: string) => { assertKey(key); store.set(key, value); },
    deleteItemAsync: async (key: string) => {
        assertKey(key);
        if (failDelete) throw new Error('keychain busy');
        store.delete(key);
    },
}));
vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
let activeUrl = 'https://joy.voltai.party:4997';
vi.mock('@/sync/serverConfig', () => ({ getServerUrl: () => activeUrl }));

import { TokenStorage, authKeyForUrl, legacyAuthKeyForUrl, parseStoredCredentials, areCredentialsUsable } from './tokenStorage';

const creds = { token: 'tok', secret: encodeBase64(new Uint8Array(32).fill(3), 'base64url') };

describe('TokenStorage', () => {
    beforeEach(() => {
        store.clear();
        failDelete = false;
        activeUrl = 'https://joy.voltai.party:4997';
        vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    it('keeps the legacy key for the built-in relay', () => {
        expect(authKeyForUrl('https://joy.voltai.party:4997')).toBe('auth_credentials.joy.voltai.party_4997');
        expect(legacyAuthKeyForUrl('https://joy.voltai.party:4997')).toBeNull();
    });

    it('has no legacy slot to migrate for a key SecureStore never accepted (#192)', () => {
        expect(legacyAuthKeyForUrl('http://[fd00::1]:4997')).toBeNull();
        expect(legacyAuthKeyForUrl('http://relay.example:4997')).toBe('auth_credentials.relay.example_4997');
    });

    it('persists and reads credentials for an IPv6 relay on native (#192)', async () => {
        const url = 'http://[fd00::1]:4997';
        expect(await TokenStorage.setCredentials(creds, url)).toBe(true);
        expect(await TokenStorage.getCredentials(url)).toEqual(creds);
        expect(await TokenStorage.removeCredentials(url)).toBe(true);
        expect(await TokenStorage.getCredentials(url)).toBeNull();
    });

    it('keeps http and https relays on the same host apart (#398)', async () => {
        await TokenStorage.setCredentials({ token: 'https-tok', secret: creds.secret }, 'https://relay.example');
        await TokenStorage.setCredentials({ token: 'http-tok', secret: creds.secret }, 'http://relay.example');
        expect((await TokenStorage.getCredentials('https://relay.example'))?.token).toBe('https-tok');
        expect((await TokenStorage.getCredentials('http://relay.example'))?.token).toBe('http-tok');
    });

    it('migrates credentials stored under the legacy key so nobody is logged out (#398)', async () => {
        const url = 'http://relay.example:4997';
        const legacyKey = legacyAuthKeyForUrl(url)!;
        expect(legacyKey).toBe('auth_credentials.relay.example_4997');
        store.set(legacyKey, JSON.stringify(creds));

        expect(await TokenStorage.getCredentials(url)).toEqual(creds);
        expect(store.get(authKeyForUrl(url))).toBe(JSON.stringify(creds));
        expect(store.has(legacyKey)).toBe(false);
    });

    it('removes a lingering legacy slot on logout so the fallback cannot restore the account', async () => {
        const url = 'http://relay.example:4997';
        store.set(legacyAuthKeyForUrl(url)!, JSON.stringify(creds));
        await TokenStorage.setCredentials(creds, url);
        expect(await TokenStorage.removeCredentials(url)).toBe(true);
        expect(await TokenStorage.getCredentials(url)).toBeNull();
    });

    it('reports a failed deletion instead of pretending the account is gone (#188)', async () => {
        await TokenStorage.setCredentials(creds);
        failDelete = true;
        expect(await TokenStorage.removeCredentials()).toBe(false);
        expect(await TokenStorage.getCredentials()).toEqual(creds);
    });

    it('treats an unreadable stored blob as absent instead of throwing (#88)', async () => {
        store.set(authKeyForUrl(activeUrl), '{not json');
        expect(await TokenStorage.getCredentials()).toBeNull();
        expect(parseStoredCredentials('{"token":1}')).toBeNull();
        expect(parseStoredCredentials(null)).toBeNull();
        expect(parseStoredCredentials(JSON.stringify(creds))).toEqual(creds);
    });
});

describe('areCredentialsUsable (#88)', () => {
    const jwt = (sub: unknown) => `h.${encodeBase64(encodeUTF8(JSON.stringify({ sub })), 'base64url')}.s`;

    it('accepts a 32-byte secret with a subject-bearing token', () => {
        expect(areCredentialsUsable({ token: jwt('user'), secret: creds.secret })).toBe(true);
    });

    it('rejects a secret that no longer decodes to 32 bytes', () => {
        expect(areCredentialsUsable({ token: jwt('user'), secret: encodeBase64(new Uint8Array(16), 'base64url') })).toBe(false);
        expect(areCredentialsUsable({ token: jwt('user'), secret: '%%%' })).toBe(false);
    });

    it('rejects a token without a subject', () => {
        expect(areCredentialsUsable({ token: 'garbage', secret: creds.secret })).toBe(false);
        expect(areCredentialsUsable({ token: jwt(5), secret: creds.secret })).toBe(false);
    });
});
