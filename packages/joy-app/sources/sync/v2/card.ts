// Session CARDS over v2: the daemon seals the session's metadata object (the
// thing the session list renders) with the session content key and publishes
// it to the relay (nucleusLane.sealCard ↔ this opener). The card IS the
// session's metadata — same shape the reducers already consume.
import sodium from '@more-tech/react-native-libsodium';

/** Open a sealed card ("v2e1:" secretbox) or a plaintext legacy card (bare
 *  JSON). Returns the metadata object, or null when it cannot be opened —
 *  callers render a minimal placeholder card rather than dropping the row. */
export function openCard(encryptedMetadata: string | null | undefined, key: Uint8Array | null): Record<string, unknown> | null {
    if (!encryptedMetadata) return null;
    try {
        let json: string;
        if (encryptedMetadata.startsWith('v2e1:')) {
            if (!key) return null; // sealed card without the session key
            const raw = sodium.from_base64(encryptedMetadata.slice(5), sodium.base64_variants.ORIGINAL);
            const nonce = raw.slice(0, 24);
            const pt = sodium.crypto_secretbox_open_easy(raw.slice(24), nonce, key);
            json = new TextDecoder().decode(pt);
        } else {
            json = encryptedMetadata;
        }
        const parsed = JSON.parse(json) as { v?: number; t?: string; metadata?: Record<string, unknown> };
        if (parsed && parsed.t === 'card' && parsed.metadata && typeof parsed.metadata === 'object') {
            return parsed.metadata;
        }
        return null;
    } catch {
        return null;
    }
}
