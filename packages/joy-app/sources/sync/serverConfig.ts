import { MMKV } from 'react-native-mmkv';
import { relayKeyForUrl, legacyRelayKeyForUrl, relayKeyNeedsMigration, resolveLegacySlotOwnership, type LegacySlotOwnership } from './relayKey';

// Separate MMKV instance for server config that persists across logouts
const serverConfigStorage = new MMKV({ id: 'server-config' });

const SERVER_KEY = 'custom-server-url';
const LOG_SERVER_KEY = 'log-server-url';
export const DEFAULT_SERVER_URL = 'https://joy.voltai.party:4997';

/** The known relays, in preference order. joy.voltai.party's :14997 (dev
 *  joy-relay) door still exists on the box but was dropped from the picker
 *  2026-08-16 — it's the same universe as :4997 and only ever caused
 *  machine-list confusion. A custom URL can still reach it. */
export const KNOWN_RELAYS = [
    { key: 'joy', name: 'Joy Relay', url: DEFAULT_SERVER_URL },
] as const;

/** Stable per-relay identifier — see relayKey.ts. For an https relay with an
 *  ordinary hostname it is `host` / `host_port`, mirroring the daemon's
 *  ~/.joy/relays/<host[_port]>/; other schemes and IPv6 literals get a
 *  collision-free, SecureStore-safe form (#398, #192). */
export { relayKeyForUrl } from './relayKey';

// ── per-relay slot ownership ─────────────────────────────────────────────────
// Every per-relay value (credentials key, relay-scoped MMKV store, manual
// access key) lives under the relay's canonical identifier. For a non-https
// relay that identifier changed in #398, and its LEGACY identifier is the
// canonical identifier of the https relay on the same host — so a migration
// must know who wrote the legacy slot before taking it over. The owner marker
// is written on every canonical write; see relayKey.resolveLegacySlotOwnership.
const RELAY_SLOT_OWNER_PREFIX = 'relay-slot-owner:';

/** `url` wrote to the slots named by its canonical identifier: record it. */
export function claimRelaySlot(url: string): void {
    const id = relayKeyForUrl(url);
    if (serverConfigStorage.getString(RELAY_SLOT_OWNER_PREFIX + id) !== id) {
        serverConfigStorage.set(RELAY_SLOT_OWNER_PREFIX + id, id);
    }
}

/** A completed migration: the legacy slot was `url`'s; say so, so the other
 *  per-relay values migrate consistently even if the active relay changes. */
export function claimLegacySlot(url: string): void {
    serverConfigStorage.set(RELAY_SLOT_OWNER_PREFIX + legacyRelayKeyForUrl(url), relayKeyForUrl(url));
}

/** May `url` take over the values stored under its legacy identifier? */
export function legacySlotOwnership(url: string): LegacySlotOwnership {
    const marker = serverConfigStorage.getString(RELAY_SLOT_OWNER_PREFIX + legacyRelayKeyForUrl(url)) ?? null;
    return resolveLegacySlotOwnership(url, marker, getServerUrl());
}

/** MMKV store scoped to the active relay. Every relay (the default one
 *  included) gets its own store, so switching relays never bleeds one
 *  account's caches (sessions, machines, drafts, push registration) into
 *  another. */
export function relayScopedMMKV(): MMKV {
    const url = getServerUrl();
    const store = new MMKV({ id: `relay.${relayKeyForUrl(url)}` });
    migrateLegacyRelayStore(store, url);
    claimRelaySlot(url);
    return store;
}

/** #398 changed the store id for non-https relays. Carry a legacy store's
 *  contents over ONCE (only into an empty canonical store, only when the
 *  legacy id differs, and ONLY with established ownership — the legacy store
 *  of http://relay.example is the live store of https://relay.example, and
 *  copying it blindly bled one account into another) so drafts, settings and
 *  the push registration of an http relay survive the upgrade. Every value
 *  in these stores is a string (JSON or a raw token), so a string copy is
 *  exact. The legacy store is never deleted here: it may still be another
 *  origin's live store. */
function migrateLegacyRelayStore(store: MMKV, url: string): void {
    if (!relayKeyNeedsMigration(url)) return;
    try {
        if (store.getAllKeys().length > 0) return;
        if (legacySlotOwnership(url) !== 'mine') return;
        const legacy = new MMKV({ id: `relay.${legacyRelayKeyForUrl(url)}` });
        for (const key of legacy.getAllKeys()) {
            const value = legacy.getString(key);
            if (value !== undefined) store.set(key, value);
        }
        claimLegacySlot(url);
    } catch (error) {
        console.warn('Relay store migration skipped:', error);
    }
}

/** Display name for a relay URL: the known-relay name, else the hostname. */
export function relayNameForUrl(url: string): string {
    const known = KNOWN_RELAYS.find(r => r.url === url);
    if (known) return known.name;
    try {
        return new URL(url).hostname;
    } catch {
        return url;
    }
}

export function getServerUrl(): string {
    return serverConfigStorage.getString(SERVER_KEY) ||
           (globalThis as any).__JOY_CONFIG__?.serverUrl ||
           process.env.EXPO_PUBLIC_JOY_SERVER_URL ||
           DEFAULT_SERVER_URL;
}

export function setServerUrl(url: string | null): void {
    if (url && url.trim()) {
        serverConfigStorage.set(SERVER_KEY, url.trim());
    } else {
        serverConfigStorage.delete(SERVER_KEY);
    }
}

// ── relay perimeter key ──────────────────────────────────────────────────────
// joy-relay's gate requires a shared key on EVERY request before anything
// reaches the relay's routes (accounts can't even be created without it).
// Stored per relay (keyed by relayKeyForUrl) in the same logout-surviving
// MMKV. Sent as the X-Joy-Relay-Key header on all fetches to the relay origin
// (via installRelayKeyFetchInterceptor below).

const RELAY_ACCESS_KEY_PREFIX = 'relay-access-key:';

// Derived-from-account-secret perimeter key (see encryption.ts) — set once
// after login. The manual per-relay value, when present, OVERRIDES it (for
// relays gated on something other than this account's derivation).
let derivedPerimeterKey: string | null = null;
export function setDerivedRelayPerimeterKey(key: string | null): void {
    derivedPerimeterKey = key;
}
export function getDerivedRelayPerimeterKey(): string | null {
    return derivedPerimeterKey;
}

export function getRelayAccessKey(url: string = getServerUrl()): string | null {
    return getStoredRelayAccessKey(url) || derivedPerimeterKey;
}

/** The MANUALLY set key for a relay, with no fall back to the derived one.
 *  UI that reports whether a password is configured must use this — every
 *  logged-in client has a derived key, so getRelayAccessKey() would answer
 *  "yes" for every relay and the answer would be meaningless. */
export function getStoredRelayAccessKey(url: string = getServerUrl()): string | null {
    return serverConfigStorage.getString(RELAY_ACCESS_KEY_PREFIX + relayKeyForUrl(url)) || migrateLegacyAccessKey(url);
}

/** A manual key saved before #398 under the legacy identifier moves to the
 *  canonical one — with established ownership only, like the other slots. */
function migrateLegacyAccessKey(url: string): string | null {
    if (!relayKeyNeedsMigration(url)) return null;
    if (legacySlotOwnership(url) !== 'mine') return null;
    const legacyKey = RELAY_ACCESS_KEY_PREFIX + legacyRelayKeyForUrl(url);
    const value = serverConfigStorage.getString(legacyKey);
    if (!value) return null;
    serverConfigStorage.set(RELAY_ACCESS_KEY_PREFIX + relayKeyForUrl(url), value);
    serverConfigStorage.delete(legacyKey);
    claimLegacySlot(url);
    return value;
}

/** The perimeter-key header for a request to `url`, as a headers fragment —
 *  `{}` when the relay has no key. The global fetch interceptor below only
 *  covers fetch() to the ACTIVE origin; axios (XMLHttpRequest on web and
 *  native) never passes through it, so every axios call to a relay must
 *  spread this in explicitly (#186), and a probe of a DIFFERENT relay must
 *  carry that relay's saved key rather than the active one's (#160). */
export function relayAccessKeyHeaders(url: string = getServerUrl()): Record<string, string> {
    const key = getRelayAccessKey(url);
    return key ? { 'X-Joy-Relay-Key': key } : {};
}

export function setRelayAccessKey(key: string | null, url: string = getServerUrl()): void {
    const storageKey = RELAY_ACCESS_KEY_PREFIX + relayKeyForUrl(url);
    if (key && key.trim()) {
        serverConfigStorage.set(storageKey, key.trim());
        claimRelaySlot(url);
    } else {
        serverConfigStorage.delete(storageKey);
    }
}

/** True only when both URLs share scheme+host+port. Prefix matching would
 *  leak the perimeter key to a look-alike origin (relay.example vs
 *  relay.example.evil.test). */
function sameOrigin(a: string, b: string): boolean {
    try { return new URL(a).origin === new URL(b).origin; } catch { return false; }
}
let fetchInterceptorInstalled = false;
/** Wrap global fetch ONCE: any request to the active relay origin gains the
 *  X-Joy-Relay-Key header (when a key is configured). One interception point
 *  instead of touching every api* module; S3/presigned/external URLs are
 *  untouched because they don't share the relay origin. */
export function installRelayKeyFetchInterceptor(): void {
    if (fetchInterceptorInstalled) return;
    fetchInterceptorInstalled = true;
    const original = globalThis.fetch.bind(globalThis);
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
        try {
            const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
            const server = getServerUrl();
            if (sameOrigin(url, server)) {
                const key = getRelayAccessKey(server);
                if (key) {
                    const headers = new Headers(init?.headers ?? (typeof input === 'object' && 'headers' in input ? (input as Request).headers : undefined));
                    if (!headers.has('X-Joy-Relay-Key')) headers.set('X-Joy-Relay-Key', key);
                    return original(input, { ...init, headers });
                }
            }
        } catch { /* fall through to untouched fetch */ }
        return original(input, init);
    }) as typeof fetch;
}

export function getLogServerUrl(): string | null {
    return serverConfigStorage.getString(LOG_SERVER_KEY) ||
           process.env.EXPO_PUBLIC_LOG_SERVER_URL ||
           null;
}

export function setLogServerUrl(url: string | null): void {
    if (url && url.trim()) {
        serverConfigStorage.set(LOG_SERVER_KEY, url.trim());
    } else {
        serverConfigStorage.delete(LOG_SERVER_KEY);
    }
}

export function isUsingCustomServer(): boolean {
    return getServerUrl() !== DEFAULT_SERVER_URL;
}

export function getServerInfo(): { hostname: string; port?: number; isCustom: boolean } {
    const url = getServerUrl();
    const isCustom = isUsingCustomServer();
    
    try {
        const parsed = new URL(url);
        const port = parsed.port ? parseInt(parsed.port) : undefined;
        return {
            hostname: parsed.hostname,
            port,
            isCustom
        };
    } catch {
        // Fallback if URL parsing fails
        return {
            hostname: url,
            port: undefined,
            isCustom
        };
    }
}

export function validateServerUrl(url: string): { valid: boolean; error?: string } {
    if (!url || !url.trim()) {
        return { valid: false, error: 'Server URL cannot be empty' };
    }
    
    try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            return { valid: false, error: 'Server URL must use HTTP or HTTPS protocol' };
        }
        return { valid: true };
    } catch {
        return { valid: false, error: 'Invalid URL format' };
    }
}