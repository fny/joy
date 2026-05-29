#!/usr/bin/env node
// Derive joy credentials.json from a happy backup secret key (base32).
// Usage: node derive-joy-creds.mjs "<7EOJU-...-OA>" <joyHomeDir>
import tweetnacl from 'tweetnacl';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const SERVER_URL = process.env.HAPPY_SERVER_URL ?? 'https://api.cluster-fluster.com';

function base32ToBytes(base32) {
    const normalized = base32.toUpperCase()
        .replace(/0/g, 'O').replace(/1/g, 'I').replace(/8/g, 'B').replace(/9/g, 'G');
    const cleaned = normalized.replace(/[^A-Z2-7]/g, '');
    const bytes = [];
    let buffer = 0, bufferLength = 0;
    for (const char of cleaned) {
        const value = BASE32_ALPHABET.indexOf(char);
        if (value === -1) throw new Error('Invalid base32 character');
        buffer = (buffer << 5) | value;
        bufferLength += 5;
        if (bufferLength >= 8) {
            bufferLength -= 8;
            bytes.push((buffer >> bufferLength) & 0xff);
        }
    }
    return new Uint8Array(bytes);
}

const b64 = (u8) => Buffer.from(u8).toString('base64');

async function main() {
    const [keyStr, joyHome] = process.argv.slice(2);
    if (!keyStr || !joyHome) {
        console.error('usage: derive-joy-creds.mjs "<key>" <joyHomeDir>');
        process.exit(1);
    }
    const secret = base32ToBytes(keyStr);
    if (secret.length < 32) throw new Error(`decoded secret too short: ${secret.length} bytes`);
    const seed = secret.slice(0, 32);

    // Auth challenge: sign a random nonce with the ed25519 key derived from the seed.
    const keypair = tweetnacl.sign.keyPair.fromSeed(seed);
    const challenge = tweetnacl.randomBytes(32);
    const signature = tweetnacl.sign.detached(challenge, keypair.secretKey);

    const res = await fetch(`${SERVER_URL}/v1/auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Happy-Client': 'joy-test/0.0.0' },
        body: JSON.stringify({
            challenge: b64(challenge),
            publicKey: b64(keypair.publicKey),
            signature: b64(signature),
        }),
    });
    if (!res.ok) throw new Error(`auth failed: HTTP ${res.status} ${await res.text()}`);
    const data = await res.json();
    if (!data.success || !data.token) throw new Error(`auth response missing token: ${JSON.stringify(data)}`);

    mkdirSync(joyHome, { recursive: true });
    const creds = {
        token: data.token,
        serverUrl: SERVER_URL,
        // Legacy variant: the account secret IS the symmetric content key, and
        // sessions carry no dataEncryptionKey. The web app, logging in with the
        // same backup key, derives the same key and can decrypt.
        encryption: { type: 'legacy', secret: b64(seed) },
    };
    const path = join(joyHome, 'credentials.json');
    writeFileSync(path, JSON.stringify(creds, null, 2));
    console.log(`wrote ${path}`);
    console.log(`token: ${data.token.slice(0, 24)}...`);
}

main().catch((e) => { console.error(e); process.exit(1); });
