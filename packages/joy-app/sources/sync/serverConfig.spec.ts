import { beforeEach, describe, expect, it, vi } from 'vitest';

// In-memory MMKV: one Map per store id, string values only (as in the app).
// Hoisted: serverConfig constructs its MMKV instance at import time.
const { stores } = vi.hoisted(() => ({ stores: new Map<string, Map<string, string>>() }));
vi.mock('react-native-mmkv', () => ({
    MMKV: class {
        private map: Map<string, string>;
        constructor(opts: { id: string }) {
            if (!stores.has(opts.id)) stores.set(opts.id, new Map());
            this.map = stores.get(opts.id)!;
        }
        getString(k: string) { return this.map.get(k); }
        set(k: string, v: string) { this.map.set(k, String(v)); }
        delete(k: string) { this.map.delete(k); }
        getAllKeys() { return Array.from(this.map.keys()); }
        contains(k: string) { return this.map.has(k); }
        clearAll() { this.map.clear(); }
    },
}));

import { getStoredRelayAccessKey, relayScopedMMKV, setRelayAccessKey, setServerUrl } from './serverConfig';

const HTTPS = 'https://relay.example';
const HTTP = 'http://relay.example';
const keys = (id: string) => Array.from(stores.get(id)?.keys() ?? []);

describe('relay-scoped stores and access keys migrate only with established ownership (#398 regression)', () => {
    beforeEach(() => {
        for (const m of stores.values()) m.clear();
        vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    it('the https store is never copied into an empty http store on the same host', () => {
        // Reviewer: serverConfig copied the HTTPS MMKV store into an empty
        // HTTP store, without any migration marker.
        setServerUrl(HTTPS);
        relayScopedMMKV().set('registered-push-token-v1', 'HTTPS_TOKEN');
        setServerUrl(HTTP);
        const http = relayScopedMMKV();
        expect(http.getString('registered-push-token-v1')).toBeUndefined();
        expect(keys('relay.http_relay.example')).toEqual([]);
        expect(stores.get('relay.relay.example')?.get('registered-push-token-v1')).toBe('HTTPS_TOKEN');
    });

    it('a pre-#398 store of the relay the app was using migrates once and is not deleted', () => {
        // The legacy store exists, no origin has claimed it, http is active.
        stores.set('relay.relay.example', new Map([['new-session-draft-v1', '{"input":"hi"}']]));
        setServerUrl(HTTP);
        expect(relayScopedMMKV().getString('new-session-draft-v1')).toBe('{"input":"hi"}');
        expect(stores.get('relay.relay.example')?.size).toBe(1); // legacy store untouched
        // A later https login on the same host gets its own (still populated) store back.
        setServerUrl(HTTPS);
        expect(relayScopedMMKV().getString('new-session-draft-v1')).toBe('{"input":"hi"}');
    });

    it('a manual access key saved under the legacy identifier migrates with ownership, and never across origins', () => {
        // Pre-#398: http's key lived under the shared identifier. The module
        // holds the 'server-config' map from import time, so mutate that one.
        const config = stores.get('server-config')!;
        config.clear();
        config.set('relay-access-key:relay.example', 'legacy-secret');
        setServerUrl(HTTPS);
        // https owns that identifier now: http may not read it.
        expect(getStoredRelayAccessKey(HTTP)).toBeNull();
        expect(config.get('relay-access-key:relay.example')).toBe('legacy-secret');

        // Fresh config where http was the active relay: the key moves across.
        config.clear();
        config.set('relay-access-key:relay.example', 'legacy-secret');
        setServerUrl(HTTP);
        expect(getStoredRelayAccessKey(HTTP)).toBe('legacy-secret');
        expect(config.get('relay-access-key:http_relay.example')).toBe('legacy-secret');
        expect(config.has('relay-access-key:relay.example')).toBe(false);
    });

    it('an https key set by this build is claimed, so http cannot inherit it even once http is active', () => {
        setServerUrl(HTTPS);
        setRelayAccessKey('https-secret', HTTPS);
        setServerUrl(HTTP);
        expect(getStoredRelayAccessKey(HTTP)).toBeNull();
        expect(getStoredRelayAccessKey(HTTPS)).toBe('https-secret');
    });
});
