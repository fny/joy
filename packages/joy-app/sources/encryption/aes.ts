import * as crypto from 'rn-encryption';
import { decodeBase64, encodeBase64 } from '@/encryption/base64';

/**
 * AES-GCM — native implementation via rn-encryption.
 *
 * rn-encryption's surface is UTF-8-string in, UTF-8-string out (it calls
 * `data.utf8` on the way in and decodes UTF-8 on the way out). The bytes
 * API below therefore carries arbitrary bytes as BASE64 TEXT inside the
 * authenticated plaintext — see encryptAESGCM. aes.web.ts mirrors this so a
 * blob sealed on one platform opens on the other.
 */

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
    // envelope (nonce + ciphertext + tag) is unchanged; only its plaintext
    // payload is base64 text. .trim() here cleans transport whitespace off
    // the returned base64 ciphertext, never off plaintext.
    const encrypted = (await crypto.encryptAsyncAES(encodeBase64(data), key64)).trim();
    return decodeBase64(encrypted);
}

export async function decryptAESGCM(data: Uint8Array, key64: string): Promise<Uint8Array | null> {
    const raw = await decryptAESGCMString(encodeBase64(data), key64);
    // #304: '' is a successfully authenticated EMPTY plaintext, not a failure
    // — only null (a failed open) is. Truthiness conflated the two.
    if (raw === null) {
        return null;
    }
    try {
        return decodeBase64(raw);
    } catch {
        return null;
    }
}
