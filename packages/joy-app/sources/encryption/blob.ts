/**
 * Binary blob encryption/decryption using NaCl crypto_secretbox (XSalsa20-Poly1305).
 *
 * Unlike encryptSecretBox in libsodium.ts, this operates on raw Uint8Array
 * without JSON serialization, making it suitable for image/file blobs.
 *
 * Wire format: [nonce (24 bytes)] [ciphertext + auth tag (16 bytes + data)]
 */
import sodium from '@/encryption/libsodium.lib';
import { getRandomBytes } from 'expo-crypto';
import { standaloneBytes } from './standalone';

// Poly1305 tag length; the native module exports no crypto_secretbox_MACBYTES.
const SECRETBOX_MACBYTES = 16;

/**
 * Encrypt a binary blob with a 32-byte secret key.
 * Returns: nonce (24) + ciphertext (data.length + 16 auth tag)
 */
export function encryptBlob(data: Uint8Array, key: Uint8Array): Uint8Array {
    const nonce = getRandomBytes(sodium.crypto_secretbox_NONCEBYTES);
    // Defensive copies: the native libsodium TurboModule on iOS reads
    // arguments via getArrayBuffer().length(runtime), which returns the
    // *underlying ArrayBuffer's* byteLength rather than the view length.
    // If a caller passes in a view onto a larger buffer, the native side can
    // either reject it ("invalid key length") or read the wrong bytes.
    // standaloneBytes copies with `new Uint8Array(view)` rather than
    // `.slice()`: a Buffer's slice() is itself a view onto the same pool,
    // so the old copy still handed the whole backing store to native (#305).
    const encrypted = sodium.crypto_secretbox_easy(standaloneBytes(data), nonce, standaloneBytes(key));
    const encryptedStandalone = standaloneBytes(encrypted);
    const result = new Uint8Array(nonce.length + encryptedStandalone.length);
    result.set(nonce, 0);
    result.set(encryptedStandalone, nonce.length);
    return result;
}

/**
 * Decrypt a blob previously encrypted with encryptBlob.
 * Returns null if decryption fails (wrong key, corrupted, truncated).
 */
export function decryptBlob(bundle: Uint8Array, key: Uint8Array): Uint8Array | null {
    if (bundle.length < sodium.crypto_secretbox_NONCEBYTES + SECRETBOX_MACBYTES) {
        return null;
    }
    // subarray + standaloneBytes gives each component an exact-length buffer
    // of its own even when `bundle` is a Buffer (#305); the key gets the
    // same treatment because native validates it by backing-store length.
    const nonce = standaloneBytes(bundle.subarray(0, sodium.crypto_secretbox_NONCEBYTES));
    const ciphertext = standaloneBytes(bundle.subarray(sodium.crypto_secretbox_NONCEBYTES));
    try {
        return sodium.crypto_secretbox_open_easy(ciphertext, nonce, standaloneBytes(key));
    } catch {
        return null;
    }
}
