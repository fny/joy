/**
 * The public key of a terminal pairing link (/terminal/connect#key=…) on web.
 *
 * The fragment is scrubbed from the URL on first render so it never lands in
 * browser history. It used to survive only in React state, so a reload —
 * accidental, or after a failed approval — showed "Invalid connection link"
 * for good and the user had to dig the original link out again (#183). The
 * key is now parked in tab-scoped sessionStorage until the request is
 * explicitly accepted or rejected, and restored from there on the next mount.
 */

export const PENDING_TERMINAL_KEY_STORAGE_KEY = 'joy.terminal.pendingKey';

export interface KeyValueStorage {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
}

/** The key carried by `hash` (`#key=<publicKey>`), or null. */
export function keyFromHash(hash: string): string | null {
    if (!hash.startsWith('#key=')) return null;
    const key = hash.slice('#key='.length);
    return key.length > 0 ? key : null;
}

function safeStorage(storage: KeyValueStorage | null | undefined): KeyValueStorage | null {
    // sessionStorage access throws in some privacy modes; treat as absent.
    try {
        if (storage && typeof storage.getItem === 'function') return storage;
    } catch {
        // fall through
    }
    return null;
}

/** Resolve the pending key for this tab: a key in the current fragment wins
 *  (and is parked); otherwise the parked key from a previous mount. */
export function resolvePendingTerminalKey(hash: string, storage: KeyValueStorage | null | undefined): string | null {
    const store = safeStorage(storage);
    const fromHash = keyFromHash(hash);
    if (fromHash) {
        try { store?.setItem(PENDING_TERMINAL_KEY_STORAGE_KEY, fromHash); } catch { /* best effort */ }
        return fromHash;
    }
    try {
        return store?.getItem(PENDING_TERMINAL_KEY_STORAGE_KEY) || null;
    } catch {
        return null;
    }
}

/** Forget the parked key: the request was approved or rejected. */
export function clearPendingTerminalKey(storage: KeyValueStorage | null | undefined): void {
    try { safeStorage(storage)?.removeItem(PENDING_TERMINAL_KEY_STORAGE_KEY); } catch { /* best effort */ }
}
