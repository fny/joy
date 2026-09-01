/**
 * Card interop: the daemon seals session CARDS with tweetnacl
 * (nucleusLane.sealCard); the app opens them with libsodium (card.ts). This
 * pins the wire format across the two stacks — the exact seam where a wrong
 * sodium import once made EVERY card silently unopenable (openCard returned
 * null, the session list fell back to placeholder cards, and the failure
 * surfaced as "sessions have no names/paths", nowhere near the real cause).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import _sodium from 'libsodium-wrappers';
import nacl from 'tweetnacl';

// The native libsodium module doesn't load under vitest (same reason
// crypto.interop.test.ts mirrors the codec instead of importing it), so this
// suite mirrors openCard's EXACT steps over libsodium-wrappers. The live
// integration proof is the UI drive-through; this pins the wire format.
let sodium: typeof _sodium;
beforeAll(async () => { await _sodium.ready; sodium = _sodium; });

function openCard(encryptedMetadata: string | null | undefined, key: Uint8Array | null): Record<string, unknown> | null {
    if (!encryptedMetadata) return null;
    try {
        let json: string;
        if (encryptedMetadata.startsWith('v2e1:')) {
            if (!key) return null;
            const raw = sodium.from_base64(encryptedMetadata.slice(5), sodium.base64_variants.ORIGINAL);
            const pt = sodium.crypto_secretbox_open_easy(raw.slice(24), raw.slice(0, 24), key);
            json = new TextDecoder().decode(pt);
        } else {
            json = encryptedMetadata;
        }
        const parsed = JSON.parse(json) as { t?: string; metadata?: Record<string, unknown> };
        if (parsed && parsed.t === 'card' && parsed.metadata && typeof parsed.metadata === 'object') return parsed.metadata;
        return null;
    } catch { return null; }
}

// The daemon's sealer, byte-for-byte (nucleusLane.sealCard, tweetnacl).
function daemonSealCard(metadata: Record<string, unknown>, key: Uint8Array | null): string {
    const json = JSON.stringify({ v: 1, t: 'card', metadata });
    if (!key) return json;
    const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
    const ct = nacl.secretbox(new Uint8Array(Buffer.from(json, 'utf8')), nonce, key);
    return 'v2e1:' + Buffer.concat([Buffer.from(nonce), Buffer.from(ct)]).toString('base64');
}

describe('v2 session cards (daemon tweetnacl → app libsodium)', () => {
    const key = new Uint8Array(nacl.randomBytes(32));
    const metadata = {
        path: '/tmp/proj', host: 'box', machineId: 'm-1',
        joy__state: 'running', summary: { text: 'A title', updatedAt: 1 },
        v2: { sessionId: 's-1', relay: 'https://r', keyEnvelope: 'v2sk1:x', localSessionId: 'l-1' },
    };

    it('opens a sealed card', () => {
        const sealed = daemonSealCard(metadata, key);
        expect(sealed.startsWith('v2e1:')).toBe(true);
        expect(openCard(sealed, key)).toEqual(metadata);
    });

    it('opens a plaintext (legacy-pairing) card', () => {
        expect(openCard(daemonSealCard(metadata, null), null)).toEqual(metadata);
    });

    it('refuses a sealed card without the key (placeholder card, not a crash)', () => {
        expect(openCard(daemonSealCard(metadata, key), null)).toBeNull();
    });

    it('refuses a card sealed under a different key', () => {
        const other = new Uint8Array(nacl.randomBytes(32));
        expect(openCard(daemonSealCard(metadata, key), other)).toBeNull();
    });

    it('refuses non-card payloads (a message envelope is not a card)', () => {
        // encodeContent's shape — t:'plain' — must not pass as a card.
        const notCard = JSON.stringify({ v: 1, t: 'plain', text: 'hi' });
        expect(openCard(notCard, null)).toBeNull();
        expect(openCard(null, key)).toBeNull();
        expect(openCard('garbage', key)).toBeNull();
    });
});
