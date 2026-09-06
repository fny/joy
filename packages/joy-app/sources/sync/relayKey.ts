/**
 * Per-relay storage identifiers (credentials key suffix, relay-scoped MMKV
 * store id, perimeter-key slot). Pure — no native imports — so the derivation
 * is unit-testable.
 *
 * The legacy identifier was `host` or `host_port` (mirroring the daemon's
 * ~/.joy/relays/<host[_port]>/). That collided for `https://relay.example`
 * vs `http://relay.example` — both became `relay.example`, so the two relays
 * shared credentials, caches and the perimeter key (#398) — and it produced
 * `[fd00::1]_4997` for IPv6 literals, which Expo SecureStore rejects (keys
 * may only contain alphanumerics, ".", "-" and "_"), so native logins to an
 * IPv6 relay could never persist (#192).
 *
 * The canonical identifier keeps the legacy shape for the common case —
 * an https relay with an ordinary hostname — so existing users' keys are
 * untouched, and diverges only where the legacy key was ambiguous or
 * unusable:
 *   - a non-https scheme is prefixed: `http_relay.example_4997`
 *   - any host character outside [A-Za-z0-9.-] is escaped as `_xx` (two
 *     lowercase hex digits), `_` itself included, so `[fd00::1]` becomes
 *     `_5bfd00_3a_3a1_5d` and no escaped host can imitate another key.
 * The explicit port is kept as before; a default port (443 for https, 80 for
 * http) is dropped by the URL parser, exactly as it always was.
 */

const SAFE_HOST_CHAR = /^[A-Za-z0-9.-]$/;

function escapeHost(hostname: string): string {
    let out = '';
    for (const ch of hostname) {
        if (SAFE_HOST_CHAR.test(ch)) {
            out += ch;
            continue;
        }
        // Escape per UTF-16 code unit so the mapping is total and reversible.
        for (let i = 0; i < ch.length; i++) {
            out += '_' + ch.charCodeAt(i).toString(16).padStart(2, '0');
        }
    }
    return out;
}

/** Anything at all, squeezed into the SecureStore alphabet. Used only when
 *  the URL does not parse (the legacy behaviour did the same). */
function sanitizeUnparsable(url: string): string {
    return url.replace(/[^a-zA-Z0-9._-]/g, '_');
}

/** The pre-#398 identifier. Only used to find and migrate stored values. */
export function legacyRelayKeyForUrl(url: string): string {
    try {
        const u = new URL(url);
        return u.port ? `${u.hostname}_${u.port}` : u.hostname;
    } catch {
        return sanitizeUnparsable(url);
    }
}

/** Stable, collision-free, SecureStore-safe per-relay identifier. */
export function relayKeyForUrl(url: string): string {
    try {
        const u = new URL(url);
        const host = escapeHost(u.hostname);
        const base = u.port ? `${host}_${u.port}` : host;
        if (u.protocol === 'https:') return base;
        // `scheme_` cannot collide with an https key: an https key starts with
        // an escaped hostname, and a hostname containing `_` is escaped to
        // `_5f`, so `http_…` is never the head of an https key.
        return `${u.protocol.replace(/:$/, '')}_${base}`;
    } catch {
        return sanitizeUnparsable(url);
    }
}

/** True when the canonical and legacy identifiers differ for `url`, i.e. a
 *  value stored before #398 lives under a different key than we now read. */
export function relayKeyNeedsMigration(url: string): boolean {
    return relayKeyForUrl(url) !== legacyRelayKeyForUrl(url);
}
