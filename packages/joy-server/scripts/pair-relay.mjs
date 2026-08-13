// Programmatic pairing of a joy-server daemon against a relay's happy-server.
// Replicates BOTH sides of the QR flow in one process:
//   account side (joy-app):  /v1/auth (sign challenge) -> token; approve the
//     terminal request with encryptBox([0x00||contentPub], cliBoxPub)
//   terminal side (happy-cli): /v1/auth/request -> poll -> decrypt -> write
//     access.key {token, encryption:{publicKey, machineKey}} + settings.json
// Usage: node scripts/pair-relay.mjs <relayUrl> <credsDir>   (run from packages/joy-server)
import { createRequire } from "node:module";
import { createHmac, randomBytes, randomUUID, createHash } from "node:crypto";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
const require = createRequire(import.meta.url);
const nacl = require("tweetnacl");

const [relayUrl, credsDir] = process.argv.slice(2);
if (!relayUrl || !credsDir) { console.error("usage: pair-relay.mjs <relayUrl> <credsDir>"); process.exit(2); }

const b64 = (u8) => Buffer.from(u8).toString("base64");
const unb64 = (s) => new Uint8Array(Buffer.from(s, "base64"));

async function post(path, body, token) {
  const headers = { "Content-Type": "application/json", "X-Happy-Client": "cli/e2e" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(relayUrl + path, { method: "POST", headers, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${path} -> HTTP ${r.status}: ${await r.text()}`);
  return r.json();
}

// deriveKey(master, usage, path) — the app's HMAC-SHA512 key tree.
function hmac512(key, data) { return new Uint8Array(createHmac("sha512", key).update(data).digest()); }
function deriveKey(master, usage, path) {
  let I = hmac512(new TextEncoder().encode(usage + " Master Seed"), master);
  let key = I.slice(0, 32), chain = I.slice(32);
  for (const index of path) {
    I = hmac512(chain, new Uint8Array([0x00, ...new TextEncoder().encode(index)]));
    key = I.slice(0, 32); chain = I.slice(32);
  }
  return key;
}
// libsodium crypto_box_seed_keypair: sk = SHA-512(seed)[0:32], pk = scalarmult_base
function boxSeedKeypair(seed) {
  const sk = new Uint8Array(createHash("sha512").update(seed).digest()).slice(0, 32);
  return nacl.box.keyPair.fromSecretKey(sk);
}
// app's encryptBox: ephemeralPub(32) || nonce(24) || crypto_box_easy
function encryptBox(data, recipientPub) {
  const eph = nacl.box.keyPair();
  const nonce = new Uint8Array(randomBytes(24));
  const ct = nacl.box(data, nonce, recipientPub, eph.secretKey);
  return new Uint8Array([...eph.publicKey, ...nonce, ...ct]);
}
function decryptBox(bundle, recipientSecret) {
  const ephPub = bundle.slice(0, 32), nonce = bundle.slice(32, 56), ct = bundle.slice(56);
  return nacl.box.open(ct, nonce, ephPub, recipientSecret);
}

// ── 1. account on the relay ──
const accountSecret = new Uint8Array(randomBytes(32));
const signKp = nacl.sign.keyPair.fromSeed(accountSecret);
const challenge = new Uint8Array(randomBytes(32));
const signature = nacl.sign.detached(challenge, signKp.secretKey);
const { token: accountToken } = await post("/v1/auth", {
  publicKey: b64(signKp.publicKey), challenge: b64(challenge), signature: b64(signature),
});
console.log("account created on", relayUrl);

// ── 2. terminal auth request (daemon's ephemeral box key) ──
const termKp = nacl.box.keyPair();
await post("/v1/auth/request", { publicKey: b64(termKp.publicKey), supportsV2: true });

// ── 3. approve as the account (the app's responseV2 bundle) ──
const contentSeed = deriveKey(accountSecret, "Happy EnCoder", ["content"]);
const contentPub = boxSeedKeypair(contentSeed).publicKey;
const bundle = new Uint8Array([0x00, ...contentPub]);
await post("/v1/auth/response", { publicKey: b64(termKp.publicKey), response: b64(encryptBox(bundle, termKp.publicKey)) }, accountToken);

// ── 4. terminal picks up the approval ──
const resp = await post("/v1/auth/request", { publicKey: b64(termKp.publicKey), supportsV2: true });
if (resp.state !== "authorized") { console.error("not authorized:", resp); process.exit(1); }
const decrypted = decryptBox(unb64(resp.response), termKp.secretKey);
if (!decrypted || decrypted[0] !== 0) { console.error("bad approval payload"); process.exit(1); }

// ── 5. write joy-server credential files ──
mkdirSync(credsDir, { recursive: true });
const accessKeyPath = join(credsDir, "access.key");
if (existsSync(accessKeyPath)) { console.error("refusing to overwrite existing " + accessKeyPath); process.exit(1); }
writeFileSync(accessKeyPath, JSON.stringify({
  token: resp.token,
  encryption: { publicKey: b64(decrypted.slice(1, 33)), machineKey: b64(new Uint8Array(randomBytes(32))) },
}, null, 2));
const machineId = randomUUID();
writeFileSync(join(credsDir, "settings.json"), JSON.stringify({ machineId, serverUrl: relayUrl }, null, 2));
console.log("paired: credsDir=" + credsDir, "machineId=" + machineId);
// stdout line the harness can grep for the follow-up server-side check
console.log("ACCOUNT_TOKEN=" + accountToken);
