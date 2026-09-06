import { describe, it, expect } from 'vitest';
import { relayKeyForUrl, legacyRelayKeyForUrl, relayKeyNeedsMigration, resolveLegacySlotOwnership } from './relayKey';

const SECURE_STORE_KEY = /^[A-Za-z0-9._-]+$/;

describe('relayKeyForUrl (#398, #192)', () => {
    it('keeps the legacy shape for https relays so existing users keep their keys', () => {
        expect(relayKeyForUrl('https://joy.voltai.party:4997')).toBe('joy.voltai.party_4997');
        expect(relayKeyForUrl('https://relay.example')).toBe('relay.example');
        expect(relayKeyForUrl('https://relay.example:443')).toBe('relay.example');
        expect(relayKeyNeedsMigration('https://joy.voltai.party:4997')).toBe(false);
    });

    it('separates http and https relays on the same host (#398)', () => {
        const https = relayKeyForUrl('https://relay.example');
        const http = relayKeyForUrl('http://relay.example');
        expect(http).not.toBe(https);
        expect(http).toBe('http_relay.example');
        expect(relayKeyForUrl('http://relay.example:4997')).toBe('http_relay.example_4997');
        // default port for http is dropped by the URL parser, like https/443
        expect(relayKeyForUrl('http://relay.example:80')).toBe('http_relay.example');
        // …but a NON-default port that happens to be the other scheme's default is kept
        expect(relayKeyForUrl('http://relay.example:443')).toBe('http_relay.example_443');
        expect(relayKeyForUrl('https://relay.example:80')).toBe('relay.example_80');
    });

    it('produces a SecureStore-safe key for IPv6 literals (#192)', () => {
        const key = relayKeyForUrl('http://[fd00::1]:4997');
        expect(key).toMatch(SECURE_STORE_KEY);
        expect(key).toBe('http__5bfd00_3a_3a1_5d_4997');
        expect(relayKeyForUrl('https://[::1]')).toMatch(SECURE_STORE_KEY);
        // the legacy key was unusable for SecureStore
        expect(legacyRelayKeyForUrl('http://[fd00::1]:4997')).toBe('[fd00::1]_4997');
        expect(relayKeyNeedsMigration('http://[fd00::1]:4997')).toBe(true);
    });

    it('is collision-free: distinct origins never share a key', () => {
        const urls = [
            'https://relay.example',
            'http://relay.example',
            'https://relay.example:4997',
            'http://relay.example:4997',
            'https://relay.example:80',
            'http://relay.example:443',
            'http://[fd00::1]:4997',
            'https://[fd00::1]:4997',
            'http://[fd00::2]:4997',
            'https://http_relay.example', // underscore in a hostname is escaped, so no clash with http_relay.example
            'https://http:80',
            'http://10.0.0.80',
        ];
        const keys = urls.map(relayKeyForUrl);
        expect(new Set(keys).size).toBe(urls.length);
        for (const k of keys) expect(k).toMatch(SECURE_STORE_KEY);
    });

    it('is stable for the same origin written differently', () => {
        expect(relayKeyForUrl('https://Relay.Example:4997/')).toBe(relayKeyForUrl('https://relay.example:4997'));
        expect(relayKeyForUrl('http://[FD00::1]:4997/path')).toBe(relayKeyForUrl('http://[fd00::1]:4997'));
    });

    it('still yields a safe key for an unparsable URL', () => {
        expect(relayKeyForUrl('not a url')).toMatch(SECURE_STORE_KEY);
    });
});

describe('resolveLegacySlotOwnership (#398 regression)', () => {
    const http = 'http://relay.example';
    const https = 'https://relay.example';

    it('a slot the https origin claimed is never handed to http', () => {
        expect(resolveLegacySlotOwnership(http, 'relay.example', http)).toBe('other');
    });

    it('an unmarked legacy slot belongs to http only when http is the persisted active relay', () => {
        expect(resolveLegacySlotOwnership(http, null, http)).toBe('mine');
        expect(resolveLegacySlotOwnership(http, null, https)).toBe('unknown');
        expect(resolveLegacySlotOwnership(http, null, 'https://joy.voltai.party:4997')).toBe('unknown');
    });

    it('a marker naming this origin (a completed migration) keeps ownership whatever is active', () => {
        expect(resolveLegacySlotOwnership(http, 'http_relay.example', https)).toBe('mine');
    });

    it('origins whose identifier never changed own their slot outright', () => {
        expect(resolveLegacySlotOwnership(https, null, http)).toBe('mine');
        expect(resolveLegacySlotOwnership('https://joy.voltai.party:4997', null, http)).toBe('mine');
    });
});
