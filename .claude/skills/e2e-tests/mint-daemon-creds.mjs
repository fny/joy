#!/usr/bin/env node
// Headless daemon credentials for the prod-mirror stack: mints a throwaway
// account THROUGH the relay (real /v1/auth path into the local happy-server)
// and writes access.key + settings.json into a happy home dir, so a daemon
// started with HAPPY_HOME_DIR=<dir> runs under that account with a known
// machineId — no browser approval step needed.
//
//   node mint-daemon-creds.mjs --relay http://127.0.0.1:3105 \
//     --home ~/.joy-test --machine v2-live-e2e
//
// Prints the bearer token on stdout (for driving the client side of tests
// under the SAME account). NOTE: the encryption keys written are random —
// the v2 nucleus lane needs only token+machineId; happy-plane E2E decryption
// for this account is not meaningful (fine for v2 tests).
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const tweetnacl = createRequire('/home/claude/Workspace/joy/packages/happy-cli/package.json')('tweetnacl');

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const RELAY = arg('relay', 'http://127.0.0.1:3105');
const HOME = arg('home')?.replace(/^~/, process.env.HOME ?? '');
const MACHINE = arg('machine', 'v2-live-e2e');
if (!HOME) { console.error('need --home'); process.exit(2); }

const b64 = (u8) => Buffer.from(u8).toString('base64');
const kp = tweetnacl.sign.keyPair();
const challenge = tweetnacl.randomBytes(32);
const res = await fetch(`${RELAY}/v1/auth`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    publicKey: b64(kp.publicKey), challenge: b64(challenge),
    signature: b64(tweetnacl.sign.detached(challenge, kp.secretKey)),
  }),
});
const { token } = await res.json();
if (!token) { console.error('mint failed:', res.status); process.exit(1); }

mkdirSync(HOME, { recursive: true });
writeFileSync(join(HOME, 'access.key'), JSON.stringify({
  token,
  encryption: { publicKey: b64(randomBytes(32)), machineKey: b64(randomBytes(32)) },
}, null, 2));
writeFileSync(join(HOME, 'settings.json'), JSON.stringify({
  machineId: MACHINE, serverUrl: RELAY,
}, null, 2));
console.error(`WROTE ${HOME}/access.key + settings.json (machineId ${MACHINE})`);
console.log(token);
