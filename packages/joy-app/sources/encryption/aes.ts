import * as crypto from 'rn-encryption';
import { decodeBase64, encodeBase64 } from '@/encryption/base64';

/**
 * AES-GCM — native implementation via rn-encryption.
 *
 * rn-encryption's surface is UTF-8-string in, UTF-8-string out (it calls
 * `data.utf8` on the way in and decodes UTF-8 on the way out). The bytes
 * API below therefore carries arbitrary bytes as BASE64 TEXT inside the
 * authenticated plaintext, in a carrier versioned by a leading byte — see
 * BYTES_CARRIER_V1. aes.web.ts mirrors this so a blob sealed on one
 * platform opens on the other.
 */

/**
 * Byte-API carrier, version 1 (#303). WIRE CONSTANT shared with aes.web.ts —
 * the two files are platform variants of one module and cannot import each
 * other without dragging the other platform's crypto in.
 *
 *   v1     : 0x01 ‖ nonce(12) ‖ ciphertext ‖ tag(16)   plaintext = base64(bytes)
 *   legacy :        nonce(12) ‖ ciphertext ‖ tag(16)   plaintext = the bytes as UTF-8 text
 *
 * Before the carrier was versioned the byte API passed raw bytes through the
 * string surface unchanged, so an OLD blob's authenticated plaintext IS its
 * bytes (as UTF-8 text). The first fix put a `joy-aes-bytes-v1:` marker
 * INSIDE the plaintext — but the plaintext is arbitrary, caller-owned data,
 * so a legacy blob whose text began with that literal opened as the base64
 * of what followed. The version byte therefore sits OUTSIDE the GCM bundle.
 * A legacy bundle starts with a random nonce, so 1 in 256 begins with 0x01
 * too; the GCM tag tells them apart: opened as v1 its nonce is misaligned
 * and authentication fails, and the decoder then opens it as legacy. A v1
 * carrier can never pass as legacy for the same reason. (rn-encryption has
 * no additional-data parameter, so the byte cannot be bound via AAD; the
 * tag over the misaligned nonce is what makes the two forms unambiguous.)
 */
const BYTES_CARRIER_V1 = 0x01;

export async function encryptAESGCMString(data: string, key64: string): Promise<string> {
    return await crypto.encryptAsyncAES(data, key64);
}

export async function decryptAESGCMString(data: string, key64: string): Promise<string | null> {
    try {
        // #302: return the plaintext untouched. It is authenticated data;
        // the former .trim() deleted meaningful leading/trailing whitespace
        // ('  keep indentation\n' came back as 'keep indentation'). Whitespace
        // cleanup is only ever legitimate on the base64 CIPHERTEXT.
        const res = await crypto.decryptAsyncAES(data, key64);
        return typeof res === 'string' ? res : null;
    } catch {
        // Parity with aes.web.ts: a failed open is null, not a throw.
        return null;
    }
}

export async function encryptAESGCM(data: Uint8Array, key64: string): Promise<Uint8Array> {
    // #303: the native API only accepts UTF-8 strings, and running raw bytes
    // through TextDecoder is lossy (0xFF/0x80 became U+FFFD, a BOM vanished).
    // Base64 is a lossless text carrier for any byte sequence. The GCM
    // bundle (nonce + ciphertext + tag) is unchanged; the plaintext is the
    // base64 text and the carrier is versioned by a leading byte
    // (BYTES_CARRIER_V1). .trim() here cleans transport whitespace off the
    // returned base64 ciphertext, never off plaintext.
    const bundle = decodeBase64((await crypto.encryptAsyncAES(encodeBase64(data), key64)).trim());
    const out = new Uint8Array(1 + bundle.length);
    out[0] = BYTES_CARRIER_V1;
    out.set(bundle, 1);
    return out;
}

export async function decryptAESGCM(data: Uint8Array, key64: string): Promise<Uint8Array | null> {
    if (data.length > 0 && data[0] === BYTES_CARRIER_V1) {
        const b64 = await decryptAESGCMString(encodeBase64(data.subarray(1)), key64);
        // Authenticated as v1: the plaintext is base64 of the bytes.
        if (b64 !== null) {
            try {
                return decodeBase64(b64);
            } catch {
                return null;
            }
        }
        // Not a v1 carrier after all: a legacy bundle whose random nonce
        // starts with 0x01. Fall through and open it as what it is.
    }
    const raw = await decryptAESGCMString(encodeBase64(data), key64);
    // #304: '' is a successfully authenticated EMPTY plaintext, not a failure
    // — only null (a failed open) is. Truthiness conflated the two.
    if (raw === null) {
        return null;
    }
    // Legacy (unversioned) payload: the plaintext text is the bytes.
    return new TextEncoder().encode(raw);
}
