import * as Crypto from 'expo-crypto';

/**
 * HMAC-SHA256 over expo-crypto's digest (the same construction as
 * hmac_sha512.ts, with SHA-256's 64-byte block). Every buffer handed to the
 * native digest is a standalone Uint8Array: the iOS binding reads a view's
 * whole backing store (#307) and rejects a bare ArrayBuffer (sync.ts).
 */
export async function hmac_sha256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
    const blockSize = 64;
    const opad = 0x5c;
    const ipad = 0x36;

    let actualKey = key;
    if (key.length > blockSize) {
        const keyHash = await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, new Uint8Array(key));
        actualKey = new Uint8Array(keyHash);
    }

    const paddedKey = new Uint8Array(blockSize);
    paddedKey.set(actualKey);

    const innerData = new Uint8Array(blockSize + data.length);
    const outerData = new Uint8Array(blockSize + 32);
    for (let i = 0; i < blockSize; i++) {
        innerData[i] = paddedKey[i] ^ ipad;
        outerData[i] = paddedKey[i] ^ opad;
    }
    innerData.set(data, blockSize);
    const innerHash = await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, innerData);
    outerData.set(new Uint8Array(innerHash), blockSize);
    const finalHash = await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, outerData);
    return new Uint8Array(finalHash);
}
