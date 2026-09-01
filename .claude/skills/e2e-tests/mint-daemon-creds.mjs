#!/usr/bin/env node
// Headless daemon credentials for the prod-mirror stack: mints a throwaway
// account on the local relay (POST /joy/v2/auth — the same ed25519 login the
// app uses) and writes access.key + settings.json into a joy home dir, so a
// daemon started with JOY_HOME_DIR=<dir> runs under that account with a known
// machineId — no browser approval step needed.
//
//   node mint-daemon-creds.mjs --relay http://127.0.0.1:3105 \
//     --home ~/.joy-test --machine v2-live-e2e
//
// Prints the bearer token on stdout (for driving the client side of tests
// under the SAME account). NOTE: the encryption keys written are random —
// the v2 nucleus lane needs only token+machineId; app-side decryption of this
// daemon's sealed cards is not meaningful (fine for daemon/relay tests).
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const REPO = process.env.JOY_REPO ?? new URL('../../..', import.meta.url).pathname;
const tweetnacl = createRequire(`${REPO}/packages/joy-daemon/package.json`)('tweetnacl');

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
const res = await fetch(`${RELAY}/joy/v2/auth`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-joy-client': 'cli/e2e' },
  body: JSON.stringify({
    publicKey: b64(kp.publicKey), challenge: b64(challenge),
    signature: b64(tweetnacl.sign.detached(challenge, kp.secretKey)),
  }),
});
const { token } = await res.json();
if (!token) { console.error('mint failed:', res.status); process.exit(1); }

// The daemon reads a relay's pairing from <joyHome>/relays/<host_port>/
// (joyRelayCredsDir, keyed by JOY_RELAY_URL).
const u = new URL(RELAY);
const relayKey = u.port ? `${u.hostname}_${u.port}` : u.hostname;
const dir = join(HOME, 'relays', relayKey);
const accessKey = JSON.stringify({
  token,
  encryption: { publicKey: b64(randomBytes(32)), machineKey: b64(randomBytes(32)) },
}, null, 2);
const settings = JSON.stringify({ machineId: MACHINE, serverUrl: RELAY }, null, 2);
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'access.key'), accessKey);
writeFileSync(join(dir, 'settings.json'), settings);
console.error(`WROTE access.key + settings.json to ${dir} (machineId ${MACHINE})`);
console.log(token);
