// Terminal side of the QR pairing flow against a relay, approval done by a
// HUMAN in the app (unlike pair-relay.mjs, which fabricates both sides with a
// throwaway account). Use this to (re)pair a relay's daemon creds under YOUR
// account: run it, open the printed link in a browser whose app is logged into
// THAT relay, click "Accept Connection", and the script writes the creds.
// Usage: node scripts/pair-relay-request.mjs <relayUrl> <credsDir>
import { createRequire } from "node:module";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { join } from "node:path";
const require = createRequire(import.meta.url);
const nacl = require("tweetnacl");

const [relayUrl, credsDir] = process.argv.slice(2);
if (!relayUrl || !credsDir) { console.error("usage: pair-relay-request.mjs <relayUrl> <credsDir>"); process.exit(2); }

const b64 = (u8) => Buffer.from(u8).toString("base64");
const b64url = (u8) => Buffer.from(u8).toString("base64url");
const unb64 = (s) => new Uint8Array(Buffer.from(s, "base64"));

async function post(path, body) {
  const r = await fetch(relayUrl + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Joy-Client": "cli/pair-request" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${path} -> HTTP ${r.status}: ${await r.text()}`);
  return r.json();
}

function decryptBox(bundle, recipientSecret) {
  const ephPub = bundle.slice(0, 32), nonce = bundle.slice(32, 56), ct = bundle.slice(56);
  return nacl.box.open(ct, nonce, ephPub, recipientSecret);
}

// ── 1. auth request ──
const termKp = nacl.box.keyPair();
await post("/joy/v2/auth/request", { publicKey: b64(termKp.publicKey), supportsV2: true });
const key = b64url(termKp.publicKey);
console.log("Approve this pairing from a browser logged into " + relayUrl + ":");
console.log("");
console.log("  https://joy.expo.app/terminal/connect#key=" + key);
console.log("");
console.log("(dev metro: http://localhost:8081/terminal/connect#key=" + key + ")");
console.log("Waiting for approval (up to 30 min)...");

// ── 2. poll until a human approves in the app ──
const deadline = Date.now() + 30 * 60_000;
let resp;
for (;;) {
  if (Date.now() > deadline) { console.error("TIMEOUT: not approved within 30 min"); process.exit(1); }
  await new Promise((r) => setTimeout(r, 2000));
  resp = await post("/joy/v2/auth/request", { publicKey: b64(termKp.publicKey), supportsV2: true });
  if (resp.state === "authorized") break;
}
const decrypted = decryptBox(unb64(resp.response), termKp.secretKey);
if (!decrypted || decrypted[0] !== 0) { console.error("bad approval payload"); process.exit(1); }

// ── 3. write creds (back up whatever was there) ──
mkdirSync(credsDir, { recursive: true });
for (const f of ["access.key", "settings.json", "account.secret"]) {
  const p = join(credsDir, f);
  if (existsSync(p)) renameSync(p, p + ".replaced");
}
writeFileSync(join(credsDir, "access.key"), JSON.stringify({
  token: resp.token,
  encryption: { publicKey: b64(decrypted.slice(1, 33)), machineKey: b64(new Uint8Array(randomBytes(32))) },
}, null, 2), { mode: 0o600 });
const machineId = randomUUID();
writeFileSync(join(credsDir, "settings.json"), JSON.stringify({ machineId, serverUrl: relayUrl }, null, 2));
console.log("PAIRED: credsDir=" + credsDir + " machineId=" + machineId);
