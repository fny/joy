/**
 * v2 content codec — the symmetric half of the v2 encryption seam. The
 * per-session key comes from Encryption.openV2SessionKey (the envelope the
 * daemon sealed at bind); this module seals/opens individual messages.
 *
 * Wire format: "v2e1:" + b64(nonce24 ‖ secretbox(utf8(json), nonce, key)).
 * Legacy/test format: plain JSON {v:1,t:'plain',text} — decode accepts both
 * so pre-encryption sessions keep rendering.
 */
import sodium from '@/encryption/libsodium.lib';

export function sealV2Content(text: string, key: Uint8Array | null): string {
    const json = JSON.stringify({ v: 1, t: 'plain', text });
    if (!key) return json;
    const nonce = sodium.randombytes_buf(24);
    const ct = sodium.crypto_secretbox_easy(sodium.from_string(json), nonce, key);
    const buf = new Uint8Array(nonce.length + ct.length);
    buf.set(nonce, 0); buf.set(ct, nonce.length);
    return 'v2e1:' + sodium.to_base64(buf, sodium.base64_variants.ORIGINAL);
}

export function openV2Content(ciphertext: string | null | undefined, key: Uint8Array | null): string | null {
    if (!ciphertext) return null;
    if (ciphertext.startsWith('v2e1:')) {
        if (!key) return null; // sealed content without the key — refuse honestly
        try {
            const raw = sodium.from_base64(ciphertext.slice(5), sodium.base64_variants.ORIGINAL);
            const pt = sodium.crypto_secretbox_open_easy(raw.slice(24), raw.slice(0, 24), key);
            const p = JSON.parse(sodium.to_string(pt));
            return typeof p.text === 'string' ? p.text : null;
        } catch { return null; }
    }
    try {
        const p = JSON.parse(ciphertext);
        if (p && p.t === 'plain' && typeof p.text === 'string') return p.text;
    } catch { /* not our envelope */ }
    return `⟨${ciphertext.length}b payload⟩`;
}
