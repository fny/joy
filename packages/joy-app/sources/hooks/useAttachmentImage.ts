/**
 * Loads, opens and exposes a chat attachment as a data URI for inline
 * rendering in chat bubbles. The bytes come from the relay's attachment
 * store sealed under the session's v2 content key (sync.fetchAttachment
 * opens them). Opened images are kept in a module-level LRU (max 50
 * entries) so scrolling back through the chat does not re-fetch every
 * image. In-flight requests are de-duplicated per attachment id.
 */
import * as React from 'react';
import { sync } from '@/sync/sync';
import { encodeBase64 } from '@/encryption/base64';

// Bounded by BYTES, not entries: fifty 10MB pictures as base64 would pin
// ~670MB of strings on a phone. 48MB keeps a scroll-back of ordinary
// screenshots warm and lets a few large photos evict everything older.
const MAX_CACHE_BYTES = 48 * 1024 * 1024;
const cache = new Map<string, string>();
let cacheBytes = 0;
const inFlight = new Map<string, Promise<string>>();

function rememberInCache(id: string, dataUri: string) {
    const prev = cache.get(id);
    if (prev !== undefined) { cache.delete(id); cacheBytes -= prev.length; }
    cache.set(id, dataUri);
    cacheBytes += dataUri.length;
    while (cacheBytes > MAX_CACHE_BYTES && cache.size > 1) {
        const oldest = cache.keys().next().value;
        if (oldest === undefined) break;
        cacheBytes -= cache.get(oldest)!.length;
        cache.delete(oldest);
    }
}

/** The four formats every renderer on our platforms decodes AND the daemon
 *  sniffs (domain/attachments.ts) — anything else is shown as a file row,
 *  never mislabeled as image/png and handed to the image view. */
export const INLINE_IMAGE_MIMES: ReadonlySet<string> = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
export const INLINE_IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp)$/i;

function detectImageMime(bytes: Uint8Array): string | null {
    if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) {
        return 'image/png';
    }
    if (bytes.length >= 3 && bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) {
        return 'image/jpeg';
    }
    if (bytes.length >= 4 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
        return 'image/gif';
    }
    if (
        bytes.length >= 12 &&
        bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
        bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
    ) {
        return 'image/webp';
    }
    return null;
}

/** Throws with a human-readable reason; the view shows it under the file row
 *  so a failure on a phone (no console) is diagnosable. */
async function loadAttachmentDataUri(sessionId: string, id: string): Promise<string> {
    let bytes: Uint8Array;
    try {
        bytes = await sync.fetchAttachment(sessionId, id);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[attachment-image] load failed for ${id}: ${message}`);
        throw new Error(`fetch: ${message}`);
    }
    const mime = detectImageMime(bytes);
    if (!mime) {
        console.warn(`[attachment-image] ${id}: bytes are not a renderable image (${bytes.length} bytes, head ${Array.from(bytes.slice(0, 4)).join(',')})`);
        throw new Error(`not an image (${bytes.length} bytes)`);
    }
    let b64: string;
    try { b64 = encodeBase64(bytes); } catch (err) { throw new Error(`base64: ${err instanceof Error ? err.message : String(err)}`); }
    return `data:${mime};base64,${b64}`;
}

export type AttachmentImageState = {
    uri: string | null;
    loading: boolean;
    error: string | null;
};

export function useAttachmentImage(sessionId: string, id: string | undefined): AttachmentImageState {
    const [state, setState] = React.useState<AttachmentImageState>(() => {
        if (!id) return { uri: null, loading: false, error: null };
        const cached = cache.get(id);
        return cached
            ? { uri: cached, loading: false, error: null }
            : { uri: null, loading: true, error: null };
    });

    React.useEffect(() => {
        if (!id) {
            setState({ uri: null, loading: false, error: null });
            return;
        }
        const cached = cache.get(id);
        if (cached) {
            cache.delete(id);
            cache.set(id, cached);
            setState({ uri: cached, loading: false, error: null });
            return;
        }
        let cancelled = false;
        setState({ uri: null, loading: true, error: null });

        let promise = inFlight.get(id);
        if (!promise) {
            promise = loadAttachmentDataUri(sessionId, id)
                .finally(() => { inFlight.delete(id); });
            inFlight.set(id, promise);
        }

        promise.then((uri) => {
            if (cancelled) return;
            rememberInCache(id, uri);
            setState({ uri, loading: false, error: null });
        }).catch((err) => {
            if (cancelled) return;
            const message = err instanceof Error ? err.message : 'unknown';
            setState({ uri: null, loading: false, error: message });
        });

        return () => { cancelled = true; };
    }, [sessionId, id]);

    return state;
}
