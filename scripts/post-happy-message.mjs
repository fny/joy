#!/usr/bin/env node
// Simulate a happy web-UI user message: encrypt {role:'user', content:{type:'text', text}}
// with the session's legacy key and POST it to the relay's v3 messages endpoint.
// Usage: node post-happy-message.mjs <sessionId> "<text>" <joyCredsPath>
import tweetnacl from 'tweetnacl';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const [sessionId, text, credsPath] = process.argv.slice(2);
const creds = JSON.parse(readFileSync(credsPath, 'utf8'));
const SERVER = creds.serverUrl ?? 'https://api.cluster-fluster.com';
const key = new Uint8Array(Buffer.from(creds.encryption.secret, 'base64'));

// legacy encrypt: nonce | secretbox(JSON)
function encryptLegacy(data, k) {
    const nonce = tweetnacl.randomBytes(tweetnacl.secretbox.nonceLength);
    const pt = new TextEncoder().encode(JSON.stringify(data));
    const ct = tweetnacl.secretbox(pt, nonce, k);
    const out = new Uint8Array(nonce.length + ct.length);
    out.set(nonce); out.set(ct, nonce.length);
    return out;
}

const payload = { role: 'user', content: { type: 'text', text }, meta: { sentFrom: 'web-sim' } };
const enc = encryptLegacy(payload, key);
const body = JSON.stringify({ messages: [{ content: Buffer.from(enc).toString('base64'), localId: randomUUID() }] });

const res = await fetch(`${SERVER}/v3/sessions/${sessionId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${creds.token}`, 'Content-Type': 'application/json' },
    body,
});
console.log(`POST -> HTTP ${res.status}`);
console.log(await res.text());
