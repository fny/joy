import { describe, it, expect, vi } from 'vitest';
import { createHash, createHmac, createPrivateKey, createPublicKey, diffieHellman, randomBytes } from 'node:crypto';
import nacl from 'tweetnacl';

// expo-crypto's digest, backed by node: the proof is HMAC-SHA256 over it.
vi.mock('expo-crypto', () => ({
    CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
    digest: async (_alg: string, data: Uint8Array) => {
        const out = createHash('sha256').update(data).digest();
        return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
    },
}));

import { PAIRING_PROOF_LABEL, pairingHandshakeOf, pairingProof } from './pairingProof';
import { encodeHex } from './hex';

/** The cross-package proof vector (#127) — the SAME bytes are asserted by
 *  the daemon (packages/joy-daemon/src/relay/pairing.test.ts) and the relay
 *  (packages/joy-relay/test/wave-f-pairing.test.mjs), so the three
 *  derivations cannot drift apart unnoticed. */
const VECTOR = {
    requesterPriv: Buffer.from('01080f161d242b323940474e555c636a71787f868d949ba2a9b0b7bec5ccd3da', 'hex'),
    requesterPub: Buffer.from('c8feca81be196cdf2cadeabf13c4903d7632dce4955aa68b6e5d9adef54e2616', 'hex'),
    relayPub: Buffer.from('c25e8b84378b21071d603dfce3f947b162b6e715240344db0a18d99259a6de23', 'hex'),
    challenge: Buffer.from('fffcf9f6f3f0edeae7e4e1dedbd8d5d2cfccc9c6c3c0bdbab7b4b1aeaba8a5a2', 'hex').toString('base64'),
    proofHex: '58d584b4cc82b5cf464318067108a5e0ccfdbbff55df77b0db7c7a513147cc93',
};

const X25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');
const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');

/** The relay's verifier, written the way accounts.mjs writes it (Node
 *  x25519 + HMAC), so the app's tweetnacl derivation is checked against
 *  OpenSSL inside this suite too. */
function relayExpects(relayPriv: Uint8Array, requesterPub: Uint8Array, challenge: string): string {
    const priv = createPrivateKey({ key: Buffer.concat([X25519_PKCS8_PREFIX, Buffer.from(relayPriv)]), format: 'der', type: 'pkcs8' });
    const relayPub = createPublicKey(priv).export({ format: 'der', type: 'spki' }).subarray(-32);
    const pub = createPublicKey({ key: Buffer.concat([X25519_SPKI_PREFIX, Buffer.from(requesterPub)]), format: 'der', type: 'spki' });
    const shared = diffieHellman({ privateKey: priv, publicKey: pub });
    return createHmac('sha256', shared)
        .update(Buffer.concat([Buffer.from(PAIRING_PROOF_LABEL), Buffer.from(challenge, 'base64'), Buffer.from(requesterPub), relayPub]))
        .digest('base64');
}

describe('pairingProof (#127)', () => {
    it('reproduces the cross-package test vector', async () => {
        const keypair = { publicKey: new Uint8Array(VECTOR.requesterPub), secretKey: new Uint8Array(VECTOR.requesterPriv) };
        expect(encodeHex(nacl.scalarMult.base(keypair.secretKey)).toLowerCase()).toBe(VECTOR.requesterPub.toString('hex'));
        const proof = await pairingProof(keypair, { challenge: VECTOR.challenge, relayPublicKey: VECTOR.relayPub.toString('base64') });
        expect(proof).toBeDefined();
        expect(encodeHex(Buffer.from(proof!, 'base64')).toLowerCase()).toBe(VECTOR.proofHex);
    });

    it('agrees with the relay verifier (Node x25519 + HMAC) for fresh keys', async () => {
        for (let i = 0; i < 8; i++) {
            const kp = nacl.box.keyPair();
            const relayPriv = randomBytes(32);
            const relayPub = nacl.scalarMult.base(new Uint8Array(relayPriv));
            const challenge = randomBytes(32).toString('base64');
            const proof = await pairingProof(kp, { challenge, relayPublicKey: Buffer.from(relayPub).toString('base64') });
            expect(proof).toBe(relayExpects(relayPriv, kp.publicKey, challenge));
        }
    });

    it('a secret handed over as a view of a larger buffer still proves', async () => {
        const backing = new Uint8Array(96);
        backing.set(VECTOR.requesterPriv, 32);
        const keypair = { publicKey: new Uint8Array(VECTOR.requesterPub), secretKey: backing.subarray(32, 64) };
        const proof = await pairingProof(keypair, { challenge: VECTOR.challenge, relayPublicKey: VECTOR.relayPub.toString('base64') });
        expect(encodeHex(Buffer.from(proof!, 'base64')).toLowerCase()).toBe(VECTOR.proofHex);
    });

    it('yields no proof for a handshake that does not decode, so the poll falls back to the legacy pickup', async () => {
        const keypair = { publicKey: new Uint8Array(VECTOR.requesterPub), secretKey: new Uint8Array(VECTOR.requesterPriv) };
        expect(await pairingProof(keypair, { challenge: VECTOR.challenge, relayPublicKey: 'AAAA' })).toBeUndefined();
        expect(await pairingProof(keypair, { challenge: '', relayPublicKey: VECTOR.relayPub.toString('base64') })).toBeUndefined();
    });

    it('pairingHandshakeOf reads the handshake off a relay reply and nothing off a legacy or error one', () => {
        expect(pairingHandshakeOf({ state: 'requested', challenge: 'c', relayPublicKey: 'r' })).toEqual({ challenge: 'c', relayPublicKey: 'r' });
        expect(pairingHandshakeOf({ state: 'pending' })).toBeNull();
        expect(pairingHandshakeOf({ state: 'expired', challenge: '', relayPublicKey: 'r' })).toBeNull();
        expect(pairingHandshakeOf(null)).toBeNull();
        expect(pairingHandshakeOf('nope')).toBeNull();
    });
});
