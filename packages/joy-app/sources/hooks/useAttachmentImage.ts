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

const MAX_CACHE_ENTRIES = 50;
const cache = new Map<string, string>();
const inFlight = new Map<string, Promise<string | null>>();

function rememberInCache(id: string, dataUri: string) {
    if (cache.has(id)) cache.delete(id);
    cache.set(id, dataUri);
    while (cache.size > MAX_CACHE_ENTRIES) {
        const oldest = cache.keys().next().value;
        if (oldest === undefined) break;
        cache.delete(oldest);
    }
}

export function detectImageMime(bytes: Uint8Array): string {
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
    return 'image/png';
}

async function loadAttachmentDataUri(sessionId: string, id: string): Promise<string | null> {
    let bytes: Uint8Array;
    try {
        bytes = await sync.fetchAttachment(sessionId, id);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[attachment-image] load failed for ${id}: ${message}`);
        return null;
    }
    return `data:${detectImageMime(bytes)};base64,${encodeBase64(bytes)}`;
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
            if (uri) {
                rememberInCache(id, uri);
                setState({ uri, loading: false, error: null });
            } else {
                setState({ uri: null, loading: false, error: 'load_failed' });
            }
        }).catch((err) => {
            if (cancelled) return;
            const message = err instanceof Error ? err.message : 'unknown';
            setState({ uri: null, loading: false, error: message });
        });

        return () => { cancelled = true; };
    }, [sessionId, id]);

    return state;
}
