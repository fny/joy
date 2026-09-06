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
import { encodeUTF8, decodeUTF8 } from '@/encryption/text';
import { standaloneBytes } from '@/encryption/standalone';

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
    // Not sodium.from_string: the native module (@more-tech/react-native-libsodium)
    // exports to_string but no from_string — on iOS/Android that call was
    // "undefined is not a function" and every send failed while reads worked.
    // Every byte view that reaches sodium owns exactly its bytes: the native
    // module sizes arguments by their whole backing store (#305/#307).
    const ct = sodium.crypto_secretbox_easy(standaloneBytes(encodeUTF8(json)), nonce, standaloneBytes(key));
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

/** An adapter record the daemon forwarded (text, tool call, turn lifecycle
 *  with usage, terminal-typed user prompt) — the raw shape the normalizer
 *  in sync/typesRaw understands (role 'session' | 'user' | 'agent'). */
export interface V2Record { role: string; content: { type: string; [k: string]: unknown }; meta?: Record<string, unknown> }
export type V2Payload = { t: 'plain'; message: V2Message } | { t: 'record'; record: V2Record };

/** Open a sealed payload into whichever shape it is: a text message
 *  ({v:1,t:'plain'}) or a forwarded adapter record ({v:1,t:'record'}). null
 *  when sealed content cannot be opened (missing/wrong key) or the payload
 *  is neither. */
export function openV2Payload(ciphertext: string | null | undefined, key: Uint8Array | null): V2Payload | null {
    if (!ciphertext) return null;
    let p: any;
    if (ciphertext.startsWith('v2e1:')) {
        if (!key) return null; // sealed content without the key — refuse honestly
        try {
            const raw = sodium.from_base64(ciphertext.slice(5), sodium.base64_variants.ORIGINAL);
            const pt = sodium.crypto_secretbox_open_easy(
                standaloneBytes(raw.subarray(24)),
                standaloneBytes(raw.subarray(0, 24)),
                standaloneBytes(key),
            );
            p = JSON.parse(decodeUTF8(pt));
        } catch { return null; }
    } else {
        try { p = JSON.parse(ciphertext); } catch { return null; }
    }
    if (!p) return null;
    if (p.t === 'record') {
        const r = p.record;
        if (!r || typeof r.role !== 'string' || !r.content || typeof r.content.type !== 'string') return null;
        return { t: 'record', record: r as V2Record };
    }
    if (typeof p.text !== 'string') return null;
    return { t: 'plain', message: { text: p.text, attachments: parseAttachments(p.attachments) } };
}

/** Open a text message envelope: text + attachments. null for records. */
export function openV2Message(ciphertext: string | null | undefined, key: Uint8Array | null): V2Message | null {
    const p = openV2Payload(ciphertext, key);
    return p?.t === 'plain' ? p.message : null;
}

export function openV2Content(ciphertext: string | null | undefined, key: Uint8Array | null): string | null {
    if (!ciphertext) return null;
    const m = openV2Message(ciphertext, key);
    if (m) return m.text;
    if (ciphertext.startsWith('v2e1:')) return null;
    return `⟨${ciphertext.length}b payload⟩`;
}

// Byte ownership at the sodium boundary is @/encryption/standalone's
// standaloneBytes. The local copy this file used to carry called `.slice()`,
// which a Buffer overrides to return ANOTHER VIEW of its pool — so a Buffer
// view [1,2] inside [9,1,2,9] still sealed all four bytes under the native
// contract, and an authentic ciphertext handed over as a Buffer failed to
// open (native byte ownership sweep, #305/#307).

/** Seal attachment bytes for upload: nonce24 ‖ secretbox(bytes). Plaintext
 *  (legacy) sessions upload the bytes as they are — same policy as the text. */
export function sealV2Bytes(bytes: Uint8Array, key: Uint8Array | null): Uint8Array {
    if (!key) return bytes;
    const nonce = sodium.randombytes_buf(24);
    const ct = sodium.crypto_secretbox_easy(standaloneBytes(bytes), nonce, standaloneBytes(key));
    const out = new Uint8Array(nonce.length + ct.length);
    out.set(nonce, 0); out.set(ct, nonce.length);
    return out;
}

export function openV2Bytes(bytes: Uint8Array, key: Uint8Array | null): Uint8Array | null {
    if (!key) return bytes;
    if (bytes.length < 24 + 16) return null;
    try {
        return sodium.crypto_secretbox_open_easy(
            standaloneBytes(bytes.subarray(24)),
            standaloneBytes(bytes.subarray(0, 24)),
            standaloneBytes(key),
        );
    } catch { return null; }
}
