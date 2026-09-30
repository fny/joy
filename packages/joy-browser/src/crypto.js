// The account-side wire formats, for a browser: tweetnacl and nothing else.
//
// This is the subset of packages/joy-mcp/src/crypto.mjs an extension needs to
// be a client of ONE account: log in, open session keys and cards, open the
// agent's output, seal a prompt, name the machines and seal a spawn spec for
// one. The tunnel (src/tunnel.js) builds on the secretbox exported here; it
// carries only the WebRTC setup of Direct mode.
//
// node:crypto is gone: SHA-512 is nacl.hash, HMAC-SHA512 is built on it, and
// randomness is nacl.randomBytes (crypto.getRandomValues underneath). Formats:
//   key tree     deriveKey(master, usage, path) — an HMAC-SHA512 chain
//   content key  box keypair from deriveKey(secret, 'Joy Content', ['content'])
//   login        ed25519 keypair from the 32-byte account secret
//   envelope     "v2sk1:" + b64(epk32 ‖ nonce24 ‖ box(sessionKey))
//   content      "v2e1:"  + b64(nonce24 ‖ secretbox(utf8(json)))
//   machine key  b64(0x00 ‖ epk32 ‖ nonce24 ‖ box(key)), opened with the content key
//   machine card 0x00 ‖ iv12 ‖ AES-256-GCM(ct ‖ tag16) under the machine key —
//                the one format tweetnacl lacks; WebCrypto has it, so that one
//                function is async
import * as vendored from '../vendor/nacl-fast.min.js';

/** The vendored build is UMD. As a real ES module — the service worker, or
 *  node — there is no `module`, so it attaches itself to `self.nacl`. A bundler
 *  or test runner that supplies CommonJS gets it as the export instead. Take
 *  whichever happened rather than depend on one loader's behaviour. */
const nacl = [globalThis.nacl, vendored.default, vendored].find((c) => typeof c?.secretbox === 'function');
if (!nacl) throw new Error('tweetnacl did not load');

const enc = new TextEncoder();
const dec = new TextDecoder();
export const utf8 = (s) => enc.encode(s);
export const fromUtf8 = (u8) => dec.decode(u8);

export function b64(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
}
export function unb64(str) {
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const unb64url = (s) => unb64(s.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '').padEnd(Math.ceil(s.replace(/=+$/, '').length / 4) * 4, '='));
export const hex = (u8) => [...u8].map((b) => b.toString(16).padStart(2, '0')).join('');

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/** HMAC-SHA512 (RFC 2104) over nacl.hash; SHA-512's block is 128 bytes. */
export function hmac512(key, data) {
  const BLOCK = 128;
  let k = key.length > BLOCK ? nacl.hash(key) : key;
  if (k.length < BLOCK) k = concat(k, new Uint8Array(BLOCK - k.length));
  const ipad = new Uint8Array(BLOCK); const opad = new Uint8Array(BLOCK);
  for (let i = 0; i < BLOCK; i++) { ipad[i] = k[i] ^ 0x36; opad[i] = k[i] ^ 0x5c; }
  return nacl.hash(concat(opad, nacl.hash(concat(ipad, data))));
}

/** The app's key tree: root = HMAC-SHA512(`${usage} Master Seed`, master),
 *  then one child per path element, HMAC-SHA512(chain, 0x00 ‖ index). */
export function deriveKey(master, usage, path) {
  let I = hmac512(utf8(`${usage} Master Seed`), master);
  let key = I.slice(0, 32);
  let chain = I.slice(32);
  for (const index of path) {
    I = hmac512(chain, concat(new Uint8Array([0x00]), utf8(index)));
    key = I.slice(0, 32);
    chain = I.slice(32);
  }
  return key;
}

/** libsodium crypto_box_seed_keypair: sk = sha512(seed)[0..32]. */
export function boxSeedKeyPair(seed) {
  return nacl.box.keyPair.fromSecretKey(nacl.hash(seed).slice(0, 32));
}
/** The account's content keypair — what opens every session key envelope. */
export const contentKeyPair = (secret) => boxSeedKeyPair(deriveKey(secret, 'Joy Content', ['content']));
/** The account's login identity. */
export const signKeyPair = (secret) => nacl.sign.keyPair.fromSeed(secret);
/** The relay's perimeter key, for relays that gate on one. */
export const relayPerimeterKey = (secret) => hex(deriveKey(secret, 'Joy Relay', ['perimeter']));
export const sign = (message, secretKey) => nacl.sign.detached(message, secretKey);
export const randomBytes = (n) => nacl.randomBytes(n);
export const secretbox = (msg, nonce, key) => nacl.secretbox(msg, nonce, key);
export const secretboxOpen = (box, nonce, key) => nacl.secretbox.open(box, nonce, key);

/** A backup code (dashed base32 as the app shows it, or bare base64url) →
 *  the 32-byte account secret. Same forgiveness as the daemon's. */
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function parseBackupCode(input) {
  const trimmed = String(input).trim();
  // 43 base64url characters ARE a 32-byte secret — checked first, because that
  // alphabet includes `-`, which the dashed base32 form below also uses.
  if (/^[A-Za-z0-9_-]{43}=?$/.test(trimmed)) {
    try { const bytes = unb64url(trimmed); if (bytes.length === 32) return bytes; } catch { /* fall through */ }
  }
  if (!/[-\s]/.test(trimmed) && trimmed.length <= 50) {
    let bytes = null;
    try { bytes = unb64url(trimmed); } catch { /* not base64url */ }
    if (bytes && bytes.length === 32) return bytes;
    throw new Error('invalid backup code');
  }
  const cleaned = trimmed.toUpperCase().replace(/0/g, 'O').replace(/1/g, 'I').replace(/8/g, 'B').replace(/9/g, 'G').replace(/[^A-Z2-7]/g, '');
  if (!cleaned) throw new Error('invalid backup code');
  const out = []; let buf = 0; let bits = 0;
  for (const ch of cleaned) {
    buf = ((buf << 5) | B32.indexOf(ch)) & 0xfff; bits += 5;
    if (bits >= 8) { bits -= 8; out.push((buf >> bits) & 0xff); }
  }
  if (out.length !== 32) throw new Error(`invalid backup code length: ${out.length}`);
  return new Uint8Array(out);
}

/** epk32 ‖ nonce24 ‖ box(data), opened with the recipient's secret key. */
export function openBox(bundle, recipientSecret) {
  if (bundle.length < 56 + 16) return null;
  return nacl.box.open(bundle.subarray(56), bundle.subarray(32, 56), bundle.subarray(0, 32), recipientSecret);
}

/** "v2sk1:" envelope → the 32-byte session key, or null. */
export function openSessionKeyEnvelope(envelope, contentSecret) {
  if (typeof envelope !== 'string' || !envelope.startsWith('v2sk1:')) return null;
  try {
    const key = openBox(unb64(envelope.slice(6)), contentSecret);
    return key && key.length === 32 ? key : null;
  } catch { return null; }
}

export function sealV2Json(obj, key) {
  const json = JSON.stringify(obj);
  if (!key) return json; // a plaintext session: the relay stores it as sent
  const nonce = nacl.randomBytes(24);
  return 'v2e1:' + b64(concat(nonce, nacl.secretbox(utf8(json), nonce, key)));
}
export function openV2Json(ciphertext, key) {
  if (typeof ciphertext !== 'string' || !ciphertext) return null;
  try {
    if (ciphertext.startsWith('v2e1:')) {
      if (!key) return null;
      const raw = unb64(ciphertext.slice(5));
      const pt = nacl.secretbox.open(raw.subarray(24), raw.subarray(0, 24), key);
      return pt ? JSON.parse(fromUtf8(pt)) : null;
    }
    return JSON.parse(ciphertext);
  } catch { return null; }
}

/** A prompt, as the app seals it. */
export const sealText = (text, key) => sealV2Json({ v: 1, t: 'plain', text }, key);

/** One relay event's ciphertext → { t:'plain', text } | { t:'record', record } | null. */
export function openPayload(ciphertext, key) {
  const p = openV2Json(ciphertext, key);
  if (!p) return null;
  if (p.t === 'record') {
    const r = p.record;
    if (!r || typeof r.role !== 'string' || !r.content || typeof r.content.type !== 'string') return null;
    return { t: 'record', record: r };
  }
  return typeof p.text === 'string' ? { t: 'plain', text: p.text } : null;
}

/** The session card: { v, t:'card', metadata } → metadata. */
export function openCard(encryptedMetadata, key) {
  const p = openV2Json(encryptedMetadata, key);
  return p && p.t === 'card' && p.metadata && typeof p.metadata === 'object' ? p.metadata : null;
}

// ── machines ─────────────────────────────────────────────────────────────────

/** A machine's data key as the relay stores it: b64(0x00 ‖ box bundle). */
export function openMachineKey(encrypted, contentSecret) {
  if (typeof encrypted !== 'string' || !encrypted) return null;
  try {
    const bytes = unb64(encrypted);
    if (bytes[0] !== 0) return null;
    const key = openBox(bytes.subarray(1), contentSecret);
    return key && key.length === 32 ? key : null;
  } catch { return null; }
}

/** The machine's card (host, displayName, capabilities…), or null. */
export async function openMachineMetadata(encrypted, machineKey) {
  if (typeof encrypted !== 'string' || !encrypted || !machineKey) return null;
  try {
    const bytes = unb64(encrypted);
    if (bytes[0] !== 0 || bytes.length < 1 + 12 + 16) return null;
    const k = await crypto.subtle.importKey('raw', machineKey, 'AES-GCM', false, ['decrypt']);
    // WebCrypto takes ciphertext ‖ tag as one buffer, which is how it is stored.
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.subarray(1, 13) }, k, bytes.subarray(13));
    return JSON.parse(fromUtf8(new Uint8Array(pt)));
  } catch { return null; }
}

/** A spawn spec for one daemon: sealed under the machine's "Joy Spawn Spec"
 *  leaf when it advertises that it opens those, the plain form every daemon
 *  parses otherwise. */
export function sealSpawnSpec(spec, machineKey, machineId) {
  const key = machineKey ? deriveKey(machineKey, 'Joy Spawn Spec', [machineId]) : null;
  return sealV2Json({ v: 1, t: 'spawn', ...spec }, key);
}
