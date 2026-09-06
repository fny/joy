/**
 * Thumbhash generation — web implementation.
 * Draws the image onto a small Canvas to extract RGBA pixel data,
 * then encodes it with the thumbhash library.
 *
 * Output: base64-encoded thumbhash string (~55 chars), or undefined on error.
 *
 * Assumes expo-image-picker returns blob: or data: URIs on web, which do not
 * require CORS headers. If called with remote http(s) URIs lacking CORS
 * headers, image loading will fail (caught and returns undefined).
 */
import { rgbaToThumbHash, thumbHashToDataURL } from 'thumbhash';

const THUMB_SIZE = 100; // max dimension; thumbhash works best ≤100px
const LOAD_TIMEOUT_MS = 5000;

function toBase64(bytes: Uint8Array): string {
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

/**
 * Canvas size for the thumbnail: the longest edge scaled to THUMB_SIZE, the
 * other edge scaled proportionally but never below one pixel. A 1x1000 image
 * scaled to 0.1px rounded to a zero-width canvas, getImageData threw, and the
 * placeholder went missing for every thin image (#455).
 */
export function thumbCanvasSize(width: number, height: number, max: number = THUMB_SIZE): { w: number; h: number } {
    const scale = max / Math.max(width, height);
    return {
        w: Math.min(max, Math.max(1, Math.round(width * scale))),
        h: Math.min(max, Math.max(1, Math.round(height * scale))),
    };
}

export async function generateThumbhash(
    uri: string,
    width: number,
    height: number,
): Promise<string | undefined> {
    if (width <= 0 || height <= 0) return undefined;

    try {
        // Scale down to THUMB_SIZE on the longest edge (each edge >= 1px, #455)
        const { w, h } = thumbCanvasSize(width, height);

        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;

        const ctx = canvas.getContext('2d');
        if (!ctx) return undefined;

        await new Promise<void>((resolve, reject) => {
            const img = new Image();
            img.crossOrigin = 'anonymous';

            const timeout = setTimeout(() => {
                img.onload = null;
                img.onerror = null;
                reject(new Error('Thumbhash image load timeout'));
            }, LOAD_TIMEOUT_MS);

            img.onload = () => {
                clearTimeout(timeout);
                ctx.drawImage(img, 0, 0, w, h);
                resolve();
            };
            img.onerror = (e) => {
                clearTimeout(timeout);
                reject(e);
            };
            img.src = uri;
        });

        const { data } = ctx.getImageData(0, 0, w, h);
        const hash = rgbaToThumbHash(w, h, data);
        return toBase64(hash);
    } catch (e) {
        if (__DEV__) {
            console.warn('[thumbhash] generation failed:', e);
        }
        return undefined;
    }
}

export function thumbhashToDataUri(thumbhashBase64: string): string | undefined {
    try {
        const bytes = Uint8Array.from(atob(thumbhashBase64), (c) => c.charCodeAt(0));
        return thumbHashToDataURL(bytes);
    } catch {
        return undefined;
    }
}
