import { MMKV } from 'react-native-mmkv';

// Separate MMKV instance for server config that persists across logouts
const serverConfigStorage = new MMKV({ id: 'server-config' });

const SERVER_KEY = 'custom-server-url';
const LOG_SERVER_KEY = 'log-server-url';
export const DEFAULT_SERVER_URL = 'https://api.cluster-fluster.com';

/** The known relays, in preference order. joy.voltai.party's :14997 (dev
 *  joy-relay) and :24997 (direct happy-server) doors still exist on the box
 *  but were dropped from the picker 2026-08-16 — they're the same universe as
 *  :4997 and only ever caused machine-list confusion. A custom URL can still
 *  reach them. */
export const KNOWN_RELAYS = [
    { key: 'happy', name: 'Happy Cloud', url: DEFAULT_SERVER_URL },
    { key: 'joy', name: 'Joy Relay', url: 'https://joy.voltai.party:4997' },
] as const;

/** Stable per-relay identifier: host, or host_port for non-default ports —
 *  mirrors the daemon's ~/.joy/relays/<host[_port]>/ naming so app and CLI
 *  agree on what counts as "the same relay". */
export function relayKeyForUrl(url: string): string {
    try {
        const u = new URL(url);
        return u.port ? `${u.hostname}_${u.port}` : u.hostname;
    } catch {
        return url.replace(/[^a-zA-Z0-9._-]/g, '_');
    }
}

/** MMKV store scoped to the active relay. The default relay keeps the legacy
 *  default instance (existing installs keep their data); every other relay
 *  gets its own store, so switching relays never bleeds one account's caches
 *  (sessions, machines, drafts, push registration) into another. */
export function relayScopedMMKV(): MMKV {
    const url = getServerUrl();
    if (url === DEFAULT_SERVER_URL) return new MMKV();
    return new MMKV({ id: `relay.${relayKeyForUrl(url)}` });
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
           (globalThis as any).__HAPPY_CONFIG__?.serverUrl ||
           process.env.EXPO_PUBLIC_HAPPY_SERVER_URL ||
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
// reaches happy-server (accounts can't even be created without it). Stored
// per relay (keyed by relayKeyForUrl) in the same logout-surviving MMKV.
// Sent as the X-Joy-Relay-Key header on all fetches to the relay origin (via
// installRelayKeyFetchInterceptor below) and as ?joyRelayKey= on the
// socket.io handshake (browsers can't set custom WebSocket headers).

const RELAY_ACCESS_KEY_PREFIX = 'relay-access-key:';

export function getRelayAccessKey(url: string = getServerUrl()): string | null {
    return serverConfigStorage.getString(RELAY_ACCESS_KEY_PREFIX + relayKeyForUrl(url)) || null;
}

export function setRelayAccessKey(key: string | null, url: string = getServerUrl()): void {
    const storageKey = RELAY_ACCESS_KEY_PREFIX + relayKeyForUrl(url);
    if (key && key.trim()) {
        serverConfigStorage.set(storageKey, key.trim());
    } else {
        serverConfigStorage.delete(storageKey);
    }
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
            if (url.startsWith(server)) {
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