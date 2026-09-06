import { getRandomBytes } from 'expo-crypto';
import sodium from '@/encryption/libsodium.lib';
import { standaloneBytes } from './standalone';

// Poly1305 tag length. The native module exports no *_MACBYTES constant, so
// spell it out (both box and secretbox use a 16-byte MAC).
const BOX_MACBYTES = 16;
const SECRETBOX_MACBYTES = 16;

/**
 * Derive the curve25519 box keypair a 32-byte seed stands for.
 *
 * #306: the former `getPublicKeyForBox(secret)` treated its argument as a
 * SEED (crypto_box_seed_keypair) while `decryptBox(_, secret)` treats its
 * argument as the PRIVATE KEY, so a bundle sealed to getPublicKeyForBox(s)
 * could never be opened with decryptBox(bundle, s). The native module has
 * no crypto_scalarmult_base to derive a public key from a private key, so
 * the single contract is: seeds go through this helper, and the returned
 * `privateKey` is what `decryptBox` takes. Existing callers already hold
 * real private keys (crypto_box_keypair / crypto_box_seed_keypair output),
 * so nothing stored changes shape.
 */
export function boxKeyPairFromSeed(seed: Uint8Array): { publicKey: Uint8Array; privateKey: Uint8Array } {
    const keyPair = sodium.crypto_box_seed_keypair(standaloneBytes(seed));
    return { publicKey: keyPair.publicKey, privateKey: keyPair.privateKey };
}

// Every view handed to sodium is materialized first (#307): the native
// bridge reads a view's entire backing store, so a subarray plaintext would
// be sealed together with its neighbours and a key view over a larger
// buffer would be rejected as the wrong length. See standalone.ts.

export function encryptBox(data: Uint8Array, recipientPublicKey: Uint8Array): Uint8Array {
    const ephemeralKeyPair = sodium.crypto_box_keypair();
    const nonce = getRandomBytes(sodium.crypto_box_NONCEBYTES);
    const encrypted = sodium.crypto_box_easy(
        standaloneBytes(data),
        nonce,
        standaloneBytes(recipientPublicKey),
        ephemeralKeyPair.privateKey,
    );

    // Bundle format: ephemeral public key (32 bytes) + nonce (24 bytes) + encrypted data
    const result = new Uint8Array(ephemeralKeyPair.publicKey.length + nonce.length + encrypted.length);
    result.set(ephemeralKeyPair.publicKey, 0);
    result.set(nonce, ephemeralKeyPair.publicKey.length);
    result.set(encrypted, ephemeralKeyPair.publicKey.length + nonce.length);

    return result;
}

export function decryptBox(encryptedBundle: Uint8Array, recipientSecretKey: Uint8Array): Uint8Array | null {
    // Extract components from bundle: ephemeral public key (32 bytes) + nonce (24 bytes) + encrypted data.
    // subarray + standaloneBytes: one exact-length copy each, even when the
    // bundle is a Buffer (whose .slice() would keep the shared pool, #307).
    const pkEnd = sodium.crypto_box_PUBLICKEYBYTES;
    const nonceEnd = pkEnd + sodium.crypto_box_NONCEBYTES;
    if (encryptedBundle.length < nonceEnd + BOX_MACBYTES) {
        return null;
    }
    const ephemeralPublicKey = standaloneBytes(encryptedBundle.subarray(0, pkEnd));
    const nonce = standaloneBytes(encryptedBundle.subarray(pkEnd, nonceEnd));
    const encrypted = standaloneBytes(encryptedBundle.subarray(nonceEnd));

    try {
        const decrypted = sodium.crypto_box_open_easy(encrypted, nonce, ephemeralPublicKey, standaloneBytes(recipientSecretKey));
        return decrypted;
    } catch (error) {
        return null;
    }
}

export function encryptSecretBox(data: any, secret: Uint8Array): Uint8Array {
    const nonce = getRandomBytes(sodium.crypto_secretbox_NONCEBYTES);
    // TextEncoder output already owns exactly its bytes; only the key needs materializing.
    const encrypted = sodium.crypto_secretbox_easy(new TextEncoder().encode(JSON.stringify(data)), nonce, standaloneBytes(secret));
    const result = new Uint8Array(nonce.length + encrypted.length);
    result.set(nonce);
    result.set(encrypted, nonce.length);
    return result;
}

export function decryptSecretBox(data: Uint8Array, secret: Uint8Array): any | null {
    const nonceEnd = sodium.crypto_secretbox_NONCEBYTES;
    if (data.length < nonceEnd + SECRETBOX_MACBYTES) {
        return null;
    }
    const nonce = standaloneBytes(data.subarray(0, nonceEnd));
    const encrypted = standaloneBytes(data.subarray(nonceEnd));

    try {
        const decrypted = sodium.crypto_secretbox_open_easy(encrypted, nonce, standaloneBytes(secret));
        if (!decrypted) {
            return null;
        }
        return JSON.parse(new TextDecoder().decode(decrypted));
    } catch (error) {
        return null;
    }
}
