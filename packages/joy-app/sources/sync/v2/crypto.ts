/**
 * v2 content codec — the symmetric half of the v2 encryption seam. The
 * per-session key comes from Encryption.openV2SessionKey (the envelope the
 * daemon sealed at bind); this module seals/opens individual messages and
 * the attachment bytes that ride beside them.
 *
 * Wire format: "v2e1:" + b64(nonce24 ‖ secretbox(utf8(json), nonce, key)).
 * Legacy/test format: plain JSON {v:1,t:'plain',text} — decode accepts both
 * so pre-encryption sessions keep rendering.
 *
 * Attachments: the message JSON carries `attachments` (id + display facts),
 * sealed with the text so the relay learns nothing about them; the bytes
 * themselves are secretbox'd under the SAME session key (nonce24 ‖ box, the
 * encryptBlob layout) and uploaded as an opaque body. The daemon opens both
 * with the key it minted at bind.
 */
import sodium from '@/encryption/libsodium.lib';

/** An attachment as it travels inside a sealed message. `id` is the relay's
 *  attachment id (GET /joy/v2/attachments/:id); the rest is what the chat
 *  needs to render it before (or without) the bytes. */
export interface V2Attachment {
    id: string;
    name: string;
    /** Plaintext size in bytes. */
    size: number;
    mime?: string;
    width?: number;
    height?: number;
    thumbhash?: string;
}

export interface V2Message {
    text: string;
    attachments: V2Attachment[];
}

export function sealV2Content(text: string, key: Uint8Array | null, attachments?: V2Attachment[]): string {
    const json = JSON.stringify({ v: 1, t: 'plain', text, ...(attachments?.length ? { attachments } : {}) });
    if (!key) return json;
    const nonce = sodium.randombytes_buf(24);
    const ct = sodium.crypto_secretbox_easy(sodium.from_string(json), nonce, key);
    const buf = new Uint8Array(nonce.length + ct.length);
    buf.set(nonce, 0); buf.set(ct, nonce.length);
    return 'v2e1:' + sodium.to_base64(buf, sodium.base64_variants.ORIGINAL);
}

function parseAttachments(raw: unknown): V2Attachment[] {
    if (!Array.isArray(raw)) return [];
    const out: V2Attachment[] = [];
    for (const a of raw) {
        if (!a || typeof a.id !== 'string' || typeof a.name !== 'string') continue;
        out.push({
            id: a.id,
            name: a.name,
            size: typeof a.size === 'number' ? a.size : 0,
            ...(typeof a.mime === 'string' ? { mime: a.mime } : {}),
            ...(typeof a.width === 'number' ? { width: a.width } : {}),
            ...(typeof a.height === 'number' ? { height: a.height } : {}),
            ...(typeof a.thumbhash === 'string' ? { thumbhash: a.thumbhash } : {}),
        });
    }
    return out;
}

/** Open a message envelope: text + attachments. null when sealed content
 *  cannot be opened (missing/wrong key) or the payload is not ours. */
export function openV2Message(ciphertext: string | null | undefined, key: Uint8Array | null): V2Message | null {
    if (!ciphertext) return null;
    let p: any;
    if (ciphertext.startsWith('v2e1:')) {
        if (!key) return null; // sealed content without the key — refuse honestly
        try {
            const raw = sodium.from_base64(ciphertext.slice(5), sodium.base64_variants.ORIGINAL);
            const pt = sodium.crypto_secretbox_open_easy(raw.slice(24), raw.slice(0, 24), key);
            p = JSON.parse(sodium.to_string(pt));
        } catch { return null; }
    } else {
        try { p = JSON.parse(ciphertext); } catch { return null; }
    }
    if (!p || typeof p.text !== 'string') return null;
    return { text: p.text, attachments: parseAttachments(p.attachments) };
}

export function openV2Content(ciphertext: string | null | undefined, key: Uint8Array | null): string | null {
    if (!ciphertext) return null;
    const m = openV2Message(ciphertext, key);
    if (m) return m.text;
    if (ciphertext.startsWith('v2e1:')) return null;
    return `⟨${ciphertext.length}b payload⟩`;
}

/** Standalone copy: the native libsodium module sizes arguments by the
 *  underlying ArrayBuffer, so a view onto a larger buffer reads wrong. */
const standalone = (b: Uint8Array) => (b.byteOffset === 0 && b.buffer.byteLength === b.length ? b : b.slice());

/** Seal attachment bytes for upload: nonce24 ‖ secretbox(bytes). Plaintext
 *  (legacy) sessions upload the bytes as they are — same policy as the text. */
export function sealV2Bytes(bytes: Uint8Array, key: Uint8Array | null): Uint8Array {
    if (!key) return bytes;
    const nonce = sodium.randombytes_buf(24);
    const ct = sodium.crypto_secretbox_easy(standalone(bytes), nonce, standalone(key));
    const out = new Uint8Array(nonce.length + ct.length);
    out.set(nonce, 0); out.set(ct, nonce.length);
    return out;
}

export function openV2Bytes(bytes: Uint8Array, key: Uint8Array | null): Uint8Array | null {
    if (!key) return bytes;
    if (bytes.length < 24 + 16) return null;
    try {
        return sodium.crypto_secretbox_open_easy(bytes.slice(24), bytes.slice(0, 24), standalone(key));
    } catch { return null; }
}
