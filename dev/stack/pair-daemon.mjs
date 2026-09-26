// Pair a fresh test daemon through Joy's existing browser approval screen.
// Run from the daemon package with `node --import tsx /repo/dev/stack/pair-daemon.mjs WEB_ORIGIN`.
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { pairingProof } from '../../packages/joy-daemon/src/relay/pairing.ts';
import { joyRelayCredsDir, joyRelayUrl } from '../../packages/joy-daemon/src/paths.ts';
import { mkdirSecure, writeSecretFileAtomic } from '../../packages/joy-daemon/src/domain/secretFile.ts';

const require = createRequire(new URL('../../packages/joy-daemon/package.json', import.meta.url));
const nacl = require('tweetnacl');
const browser = new URL(process.argv[2]);
if (!['http:', 'https:'].includes(browser.protocol)) throw new Error('Expected a web origin');
const relay = joyRelayUrl();
const dir = joyRelayCredsDir();
if (['access.key', 'settings.json', 'perimeter.key', 'account.secret'].some(name => existsSync(join(dir, name)))) {
  throw new Error('This helper only pairs a fresh daemon; existing pairing files will not be overwritten.');
}
const kp = nacl.box.keyPair();
const publicKey = Buffer.from(kp.publicKey).toString('base64');
const headers = { 'content-type': 'application/json', 'x-joy-client': 'dev/stack-pair' };
const gate = process.env.JOY_RELAY_ACCESS_KEY;
if (gate) headers['x-joy-relay-key'] = gate;
async function request(proof) {
  const r = await fetch(relay + '/joy/v2/auth/request', {
    method: 'POST', headers,
    body: JSON.stringify({ publicKey, supportsV2: true, ...(proof ? { proof } : {}) }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!r.ok) throw new Error(`Pairing HTTP ${r.status}`);
  return r.json();
}
try {
  const created = await request();
  let proof = pairingProof(kp, created);
  if (!proof) throw new Error('The relay did not provide a pairing proof challenge');
  console.log(`${browser.origin}/terminal/connect#key=${Buffer.from(kp.publicKey).toString('base64url')}`);
  console.log('Waiting for approval in Joy (up to 10 minutes).');
  const deadline = Date.now() + 10 * 60_000;
  let paired = false;
  while (Date.now() < deadline) {
    await delay(1500);
    const reply = await request(proof);
    if (reply.state === 'requested' || reply.state === 'proof_required') {
      // The relay rotates a presented proof's challenge while approval is pending.
      proof = pairingProof(kp, reply);
      if (!proof) throw new Error('The relay did not provide a fresh pairing challenge');
      continue;
    }
    if (reply.state !== 'authorized') throw new Error(`Pairing state: ${reply.state}`);
    if (typeof reply.token !== 'string' || !reply.token || typeof reply.response !== 'string') throw new Error('Invalid approval');
    const box = Buffer.from(reply.response, 'base64');
    const plain = nacl.box.open(box.subarray(56), box.subarray(32, 56), box.subarray(0, 32), kp.secretKey);
    if (!plain || plain.length !== 33 || plain[0] !== 0) throw new Error('Invalid encrypted approval');
    mkdirSecure(dir);
    const machineId = randomUUID();
    writeSecretFileAtomic(join(dir, 'settings.json'), JSON.stringify({ machineId, serverUrl: relay }));
    if (gate) writeSecretFileAtomic(join(dir, 'perimeter.key'), gate + '\n');
    writeSecretFileAtomic(join(dir, 'access.key'), JSON.stringify({
      token: reply.token,
      encryption: { publicKey: Buffer.from(plain.subarray(1)).toString('base64'), machineKey: randomBytes(32).toString('base64') },
    }));
    plain.fill(0);
    console.log('Pairing saved. Restart the daemon to announce this machine.');
    paired = true;
    break;
  }
  if (!paired) throw new Error('Pairing timed out; run this helper again for a new link');
} finally { kp.secretKey.fill(0); }
