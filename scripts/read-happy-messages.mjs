#!/usr/bin/env node
// Read + decrypt a session's messages as a happy client would (legacy key),
// printing the wire-shape {role, content, meta} so we can confirm joy's
// output is renderable by the happy app.
// Usage: node read-happy-messages.mjs <sessionId> <joyCredsPath>
import tweetnacl from 'tweetnacl';
import { readFileSync } from 'node:fs';

const [sessionId, credsPath] = process.argv.slice(2);
const creds = JSON.parse(readFileSync(credsPath, 'utf8'));
const SERVER = creds.serverUrl ?? 'https://api.cluster-fluster.com';
const key = new Uint8Array(Buffer.from(creds.encryption.secret, 'base64'));

function decryptLegacy(buf, k) {
    const n = tweetnacl.secretbox.nonceLength;
    const nonce = buf.slice(0, n);
    const ct = buf.slice(n);
    const pt = tweetnacl.secretbox.open(ct, nonce, k);
    if (!pt) return null;
    try { return JSON.parse(new TextDecoder().decode(pt)); } catch { return null; }
}

const res = await fetch(`${SERVER}/v3/sessions/${sessionId}/messages?after_seq=0&limit=50`, {
    headers: { Authorization: `Bearer ${creds.token}` },
});
const { messages } = await res.json();
for (const m of messages) {
    const c = typeof m.content === 'string' ? m.content : m.content?.c;
    if (!c) continue;
    const plain = decryptLegacy(new Uint8Array(Buffer.from(c, 'base64')), key);
    const role = plain?.role ?? '?';
    const ctype = plain?.content?.type ?? '?';
    const text = plain?.content?.text ?? '';
    const joyType = plain?.meta?.joy?.type ?? '';
    console.log(`seq ${String(m.seq).padStart(3)} | role=${role.padEnd(7)} | content.type=${String(ctype).padEnd(18)} | joy=${joyType.padEnd(16)} | ${text.slice(0, 50)}`);
}
