import { decodeBase64 } from "@/encryption/base64";
import { decodeUTF8, encodeUTF8 } from "@/encryption/text";

export function parseToken(token: string) {
    const parts = token.split('.');
    if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
        throw new Error('Invalid token format: expected "header.payload.signature" with non-empty parts');
    }
    const [header, payload, signature] = parts;

    try {
        // JWT segments are base64url (RFC 7515 §2): '-' and '_' instead of
        // '+' and '/', no padding. Decoding in standard-base64 mode made atob
        // reject every payload whose bytes happened to produce those
        // characters (#439); 'base64url' normalizes the alphabet and padding.
        const sub = JSON.parse(decodeUTF8(decodeBase64(payload, 'base64url'))).sub;
        if (typeof sub !== 'string') {
            throw new Error('Invalid token: missing or invalid sub claim');
        }
        return sub;
    } catch (error) {
        if (error instanceof Error && error.message.includes('Invalid token')) {
            throw error; // Re-throw our validation errors
        }
        throw new Error(`Invalid token: failed to decode payload - ${error instanceof Error ? error.message : 'unknown error'}`);
    }
}