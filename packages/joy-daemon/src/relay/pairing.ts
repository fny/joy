// Self-pairing against a relay from an account backup code — both sides of the
// QR flow in one process, no browser approval. Used by `joy auth`: the account
// side is us (signing key derived from the pasted secret), the terminal side
// is us (fresh box keypair), so the "approval" is signing our own request.
// The relay auto-creates the account on first contact, which is what makes a
// single backup code work across every relay.
//
// The account secret transits memory only — callers must not persist it.
import { createHmac, createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import tweetnacl from "tweetnacl";
import { joyRelayAccessKey } from "../paths";

// App's backup format (secretKeyBackup.ts): RFC 4648 base32, dash-grouped,
// with the same typo forgiveness (0→O, 1→I, 8→B, 9→G, junk stripped).
const B32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** Parse a user-entered backup code (dashed base32 OR bare base64url) into the
 *  32-byte account secret. Throws on anything that doesn't decode to 32 bytes. */
export function parseBackupCode(input: string): Uint8Array {
  const trimmed = input.trim();
  // Bare base64url form (the on-device representation) — accepted for parity
  // with the app's normalizeSecretKey.
  if (!/[-\s]/.test(trimmed) && trimmed.length <= 50) {
    const bytes = new Uint8Array(Buffer.from(trimmed, "base64url"));
    if (bytes.length === 32) return bytes;
    throw new Error("invalid secret key");
  }
  const cleaned = trimmed
    .toUpperCase()
    .replace(/0/g, "O")
    .replace(/1/g, "I")
    .replace(/8/g, "B")
    .replace(/9/g, "G")
    .replace(/[^A-Z2-7]/g, "");
  if (cleaned.length === 0) throw new Error("invalid secret key");
  const bytes: number[] = [];
  let buf = 0;
  let bits = 0;
  for (const ch of cleaned) {
    buf = (buf << 5) | B32_ALPHABET.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buf >> bits) & 0xff);
    }
  }
  if (bytes.length !== 32) throw new Error(`invalid secret key length: ${bytes.length}`);
  return new Uint8Array(bytes);
}

const b64 = (u8: Uint8Array) => Buffer.from(u8).toString("base64");
const unb64 = (s: string) => new Uint8Array(Buffer.from(s, "base64"));

function hmac512(key: Uint8Array, data: Uint8Array): Uint8Array {
  return new Uint8Array(createHmac("sha512", key).update(data).digest());
}

// The app's HMAC-SHA512 key tree ("Happy EnCoder" usage, ["content"] path).
function deriveContentSeed(master: Uint8Array): Uint8Array {
  let I = hmac512(new TextEncoder().encode("Happy EnCoder Master Seed"), master);
  let key = I.slice(0, 32);
  let chain = I.slice(32);
  for (const index of ["content"]) {
    I = hmac512(chain, new Uint8Array([0x00, ...new TextEncoder().encode(index)]));
    key = I.slice(0, 32);
    chain = I.slice(32);
  }
  return key;
}

// libsodium crypto_box_seed_keypair: sk = SHA-512(seed)[0:32]
function boxSeedKeypair(seed: Uint8Array) {
  const sk = new Uint8Array(createHash("sha512").update(seed).digest()).slice(0, 32);
  return tweetnacl.box.keyPair.fromSecretKey(sk);
}

// App's encryptBox framing: ephemeralPub(32) || nonce(24) || crypto_box_easy
function encryptBox(data: Uint8Array, recipientPub: Uint8Array): Uint8Array {
  const eph = tweetnacl.box.keyPair();
  const nonce = new Uint8Array(randomBytes(24));
  const ct = tweetnacl.box(data, nonce, recipientPub, eph.secretKey);
  return new Uint8Array([...eph.publicKey, ...nonce, ...ct]);
}

function decryptBox(bundle: Uint8Array, recipientSecret: Uint8Array): Uint8Array | null {
  return tweetnacl.box.open(bundle.slice(56), bundle.slice(32, 56), bundle.slice(0, 32), recipientSecret);
}

async function post(relayUrl: string, path: string, body: unknown, token?: string): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = { "Content-Type": "application/json", "X-Happy-Client": "cli/joy-auth" };
  const relayKey = joyRelayAccessKey();
  if (relayKey) headers["X-Joy-Relay-Key"] = relayKey;
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(relayUrl + path, { method: "POST", headers, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${path} -> HTTP ${r.status}: ${await r.text()}`);
  return (await r.json()) as Record<string, unknown>;
}

/** Pair this machine with a relay using the account secret: log in (the relay
 *  creates the account on first contact), self-approve a fresh terminal
 *  keypair, and write access.key + settings.json into credsDir. Any existing
 *  pair is backed up as *.replaced. Returns the new machineId. */
export async function pairWithRelay(relayUrl: string, accountSecret: Uint8Array, credsDir: string): Promise<string> {
  // 1. account login — signature over a self-chosen challenge
  const signKp = tweetnacl.sign.keyPair.fromSeed(accountSecret);
  const challenge = new Uint8Array(randomBytes(32));
  const signature = tweetnacl.sign.detached(challenge, signKp.secretKey);
  const auth = await post(relayUrl, "/v1/auth", {
    publicKey: b64(signKp.publicKey), challenge: b64(challenge), signature: b64(signature),
  });
  const accountToken = String(auth.token ?? "");
  if (!accountToken) throw new Error("relay returned no account token");

  // 2. terminal request + self-approval
  const termKp = tweetnacl.box.keyPair();
  await post(relayUrl, "/v1/auth/request", { publicKey: b64(termKp.publicKey), supportsV2: true });
  const contentPub = boxSeedKeypair(deriveContentSeed(accountSecret)).publicKey;
  const bundle = new Uint8Array([0x00, ...contentPub]);
  await post(relayUrl, "/v1/auth/response",
    { publicKey: b64(termKp.publicKey), response: b64(encryptBox(bundle, termKp.publicKey)) }, accountToken);

  // 3. pick up the approval
  const resp = await post(relayUrl, "/v1/auth/request", { publicKey: b64(termKp.publicKey), supportsV2: true });
  if (resp.state !== "authorized") throw new Error(`pairing not authorized (state=${String(resp.state)})`);
  const decrypted = decryptBox(unb64(String(resp.response)), termKp.secretKey);
  if (!decrypted || decrypted[0] !== 0) throw new Error("bad approval payload");

  // 4. write creds (back up whatever was there)
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
  return machineId;
}
