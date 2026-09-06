import nacl from 'tweetnacl';
import { decodeBase64, encodeBase64 } from './base64';
import { encodeUTF8 } from './text';
import { hmac_sha256 } from './hmac_sha256';

// The pairing proof of possession (#127), the app's side of the wire the
// relay verifies in packages/joy-relay/src/accounts.mjs and the daemon
// produces in packages/joy-daemon/src/relay/pairing.ts. The relay hands a
// pairing request a `challenge` (32 random bytes) and a per-request X25519
// `relayPublicKey`; the pickup poll presents
//     proof = HMAC-SHA256(X25519(ourPriv, relayPub),
//                         label || challenge || ourPub || relayPub)
// which only the holder of the ephemeral PRIVATE key can compute — without
// it, anyone who saw the QR (the public key is its content) could poll
// first and be minted the account bearer.
//
// This module is the ONE owner of the tweetnacl import: the native libsodium
// binding exposes no scalar multiplication (libsodium.ts, "no
// crypto_scalarmult_base"), so X25519 runs in JS here. tweetnacl's
// scalarMult clamps the scalar the way libsodium and OpenSSL do, so a
// crypto_box_seed_keypair private key agrees byte for byte with the relay's
// Node x25519 (pinned by the cross-package vector in pairingProof.spec.ts).

/** Domain separator of the proof — a WIRE CONSTANT shared with the relay's
 *  PAIRING_PROOF_LABEL and the daemon's pairing.ts. */
export const PAIRING_PROOF_LABEL = 'joy-pairing-proof-v1';

export interface PairingHandshake {
    challenge: string;
    relayPublicKey: string;
}

export interface PairingKeyPair {
    publicKey: Uint8Array;
    secretKey: Uint8Array;
}

/** The handshake a relay reply carries, or null when it carries none (a
 *  relay from before the proof, an `expired` reply, an error body). */
export function pairingHandshakeOf(reply: unknown): PairingHandshake | null {
    if (!reply || typeof reply !== 'object') {
        return null;
    }
    const { challenge, relayPublicKey } = reply as Record<string, unknown>;
    if (typeof challenge !== 'string' || !challenge || typeof relayPublicKey !== 'string' || !relayPublicKey) {
        return null;
    }
    return { challenge, relayPublicKey };
}

/**
 * The base64 proof for `handshake`, or undefined when the handshake does
 * not decode (a 32-byte relay key and a non-empty challenge are required),
 * in which case the caller polls without a proof, the legacy way.
 */
export async function pairingProof(keypair: PairingKeyPair, handshake: PairingHandshake): Promise<string | undefined> {
    let relayPub: Uint8Array;
    let challenge: Uint8Array;
    try {
        relayPub = decodeBase64(handshake.relayPublicKey);
        challenge = decodeBase64(handshake.challenge);
    } catch {
        return undefined;
    }
    if (relayPub.length !== nacl.scalarMult.groupElementLength || challenge.length === 0) {
        return undefined;
    }
    // Standalone copies: the secret may be a view over a larger buffer, and
    // the native digest reads a view's whole backing store (#307).
    const shared = nacl.scalarMult(new Uint8Array(keypair.secretKey), relayPub);
    const label = encodeUTF8(PAIRING_PROOF_LABEL);
    const message = new Uint8Array(label.length + challenge.length + keypair.publicKey.length + relayPub.length);
    message.set(label, 0);
    message.set(challenge, label.length);
    message.set(keypair.publicKey, label.length + challenge.length);
    message.set(relayPub, label.length + challenge.length + keypair.publicKey.length);
    return encodeBase64(await hmac_sha256(shared, message));
}
