// Every wire format the app speaks, in Node with tweetnacl + node:crypto.
//
// The relay stores ciphertext only, so a client of the account has to open
// (and seal) exactly what the app and the daemons do:
//   key tree     deriveKey(master, usage, path) — HMAC-SHA512 chain
//                (packages/joy-app/sources/encryption/deriveKey.ts)
//   content key  box keypair from deriveKey(secret, 'Joy Content', ['content'])
//                (encryption.ts / daemon pairing.ts boxSeedKeypair)
//   login        ed25519 keypair from the 32-byte account secret
//   envelope     "v2sk1:" + b64(epk32 ‖ nonce24 ‖ box(sessionKey))  → session key
//   content      "v2e1:"  + b64(nonce24 ‖ secretbox(utf8(json)))   → message / card / spawn spec
//   machine key  b64(0x00 ‖ epk32 ‖ nonce24 ‖ box(key)) opened with the content key
//   machine card AES-256-GCM(iv12 ‖ ct ‖ tag16) under the machine key, 0x00-prefixed
//   tunnel       streams of secretbox frames under HMAC-derived per-stream keys
//                (packages/joy-app/sources/sync/v2/tunnel.ts)
// tweetnacl's secretbox IS libsodium's crypto_secretbox_easy (XSalsa20-Poly1305),
// and its box IS crypto_box_easy — the same bytes the native app produces.
import { createHmac, createHash, randomBytes, createDecipheriv, createCipheriv } from 'node:crypto';
import nacl from 'tweetnacl';

export const b64 = (u8) => Buffer.from(u8).toString('base64');
export const unb64 = (s) => new Uint8Array(Buffer.from(s, 'base64'));
export const utf8 = (s) => new Uint8Array(Buffer.from(s, 'utf8'));
export const fromUtf8 = (u8) => Buffer.from(u8).toString('utf8');
export const hex = (u8) => Buffer.from(u8).toString('hex');

export function hmac512(key, data) {
  return new Uint8Array(createHmac('sha512', Buffer.from(key)).update(Buffer.from(data)).digest());
}

/** The app's key tree: root = HMAC-SHA512(`${usage} Master Seed`, master),
 *  then one child per path element, HMAC-SHA512(chain, 0x00 ‖ index). */
export function deriveKey(master, usage, path) {
  let I = hmac512(utf8(`${usage} Master Seed`), master);
  let key = I.slice(0, 32);
  let chain = I.slice(32);
  for (const index of path) {
    I = hmac512(chain, new Uint8Array([0x00, ...utf8(index)]));
    key = I.slice(0, 32);
    chain = I.slice(32);
  }
  return key;
}

/** libsodium crypto_box_seed_keypair: sk = sha512(seed)[0..32]. */
export function boxSeedKeyPair(seed) {
  const sk = new Uint8Array(createHash('sha512').update(Buffer.from(seed)).digest()).slice(0, 32);
  return nacl.box.keyPair.fromSecretKey(sk);
}

/** The account's content keypair — what opens every session key envelope. */
export function contentKeyPair(accountSecret) {
  return boxSeedKeyPair(deriveKey(accountSecret, 'Joy Content', ['content']));
}

/** The account's login identity. */
export function signKeyPair(accountSecret) {
  return nacl.sign.keyPair.fromSeed(accountSecret);
}

export function relayPerimeterKey(accountSecret) {
  return hex(deriveKey(accountSecret, 'Joy Relay', ['perimeter']));
}

/** Parse a backup code (dashed base32 as the app shows it, or bare base64url)
 *  into the 32-byte account secret. Same forgiveness as the daemon's. */
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function parseBackupCode(input) {
  const trimmed = String(input).trim();
  if (/^[A-Za-z0-9_-]{43}=?$/.test(trimmed)) {
    const bytes = new Uint8Array(Buffer.from(trimmed, 'base64url'));
    if (bytes.length === 32) return bytes;
  }
  if (!/[-\s]/.test(trimmed) && trimmed.length <= 50) {
    const bytes = new Uint8Array(Buffer.from(trimmed, 'base64url'));
    if (bytes.length === 32) return bytes;
    throw new Error('invalid secret key');
  }
  const cleaned = trimmed.toUpperCase().replace(/0/g, 'O').replace(/1/g, 'I').replace(/8/g, 'B').replace(/9/g, 'G').replace(/[^A-Z2-7]/g, '');
  if (!cleaned) throw new Error('invalid secret key');
  const out = []; let buf = 0; let bits = 0;
  for (const ch of cleaned) {
    buf = (buf << 5) | B32.indexOf(ch); bits += 5;
    if (bits >= 8) { bits -= 8; out.push((buf >> bits) & 0xff); }
  }
  if (out.length !== 32) throw new Error(`invalid secret key length: ${out.length}`);
  return new Uint8Array(out);
}

// ── box bundles ────────────────────────────────────────────────────────────

/** epk32 ‖ nonce24 ‖ box(data) to a recipient public key. */
export function sealBox(data, recipientPub) {
  const eph = nacl.box.keyPair();
  const nonce = new Uint8Array(randomBytes(24));
  const ct = nacl.box(data, nonce, recipientPub, eph.secretKey);
  return new Uint8Array([...eph.publicKey, ...nonce, ...ct]);
}
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
/** The daemon's side of the same envelope (tests, and any future re-seal). */
export function sealSessionKeyEnvelope(sessionKey, contentPub) {
  return 'v2sk1:' + b64(sealBox(sessionKey, contentPub));
}

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
export function sealMachineKey(machineKey, contentPub) {
  return b64(new Uint8Array([0x00, ...sealBox(machineKey, contentPub)]));
}

// ── secretbox payloads ("v2e1:") ───────────────────────────────────────────

export function sealV2Json(obj, key) {
  const json = JSON.stringify(obj);
  if (!key) return json;
  const nonce = new Uint8Array(randomBytes(24));
  const ct = nacl.secretbox(utf8(json), nonce, key);
  return 'v2e1:' + b64(new Uint8Array([...nonce, ...ct]));
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
export function sealText(text, key) { return sealV2Json({ v: 1, t: 'plain', text }, key); }

/** One relay event's ciphertext → { t:'plain', text } | { t:'record', record } | null. */
export function openPayload(ciphertext, key) {
  const p = openV2Json(ciphertext, key);
  if (!p) return null;
  if (p.t === 'record') {
    const r = p.record;
    if (!r || typeof r.role !== 'string' || !r.content || typeof r.content.type !== 'string') return null;
    return { t: 'record', record: r };
  }
  if (typeof p.text !== 'string') return null;
  return { t: 'plain', text: p.text, attachments: Array.isArray(p.attachments) ? p.attachments : [] };
}

/** The session card: { v, t:'card', metadata } → metadata. */
export function openCard(encryptedMetadata, key) {
  const p = openV2Json(encryptedMetadata, key);
  return p && p.t === 'card' && p.metadata && typeof p.metadata === 'object' ? p.metadata : null;
}
export function sealCard(metadata, key) { return sealV2Json({ v: 1, t: 'card', metadata }, key); }

/** A spawn spec sealed for a daemon that advertises spawnSpecSealed. */
export function sealSpawnSpec(spec, machineKey, machineId) {
  const key = machineKey ? deriveKey(machineKey, 'Joy Spawn Spec', [machineId]) : null;
  return sealV2Json({ v: 1, t: 'spawn', ...spec }, key);
}

// ── machine metadata (AES-256-GCM under the machine key) ───────────────────

export function openMachineMetadata(encrypted, machineKey) {
  if (typeof encrypted !== 'string' || !encrypted || !machineKey) return null;
  try {
    const bytes = Buffer.from(encrypted, 'base64');
    if (bytes[0] !== 0 || bytes.length < 1 + 12 + 16) return null;
    const iv = bytes.subarray(1, 13);
    const body = bytes.subarray(13);
    const ct = body.subarray(0, body.length - 16);
    const tag = body.subarray(body.length - 16);
    const d = createDecipheriv('aes-256-gcm', Buffer.from(machineKey), iv);
    d.setAuthTag(tag);
    const pt = Buffer.concat([d.update(ct), d.final()]);
    return JSON.parse(pt.toString('utf8'));
  } catch { return null; }
}
export function sealMachineMetadata(metadata, machineKey) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', Buffer.from(machineKey), iv);
  const ct = Buffer.concat([c.update(Buffer.from(JSON.stringify(metadata), 'utf8')), c.final()]);
  return Buffer.concat([Buffer.from([0]), iv, ct, c.getAuthTag()]).toString('base64');
}

// ── the sealed tunnel to a daemon ──────────────────────────────────────────

const CHUNK_MAX = 128 * 1024;
const TAG_MESSAGE = 0x00;
const TAG_FINAL = 0x01;

export function deriveTunnelKey(machineKey, machineId) { return deriveKey(machineKey, 'Joy Tunnel', [machineId]); }
function streamKey(tunnelKey, streamId) { return hmac512(tunnelKey, new Uint8Array([...utf8('stream'), ...streamId])).slice(0, 32); }
function nonceFor(counter) {
  const n = new Uint8Array(24);
  new DataView(n.buffer).setBigUint64(16, counter, false);
  return n;
}
function concat(parts) {
  let len = 0; for (const p of parts) len += p.length;
  const out = new Uint8Array(len); let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

/** Seal head + body into one request stream; returns { wire, binding }. */
export function sealTunnelRequest(tunnelKey, head, body = new Uint8Array(0)) {
  const streamId = new Uint8Array(randomBytes(16));
  const key = streamKey(tunnelKey, streamId);
  const parts = [streamId];
  let counter = 0n;
  const push = (plain, final) => {
    const tagged = new Uint8Array(1 + plain.length);
    tagged[0] = final ? TAG_FINAL : TAG_MESSAGE;
    tagged.set(plain, 1);
    const ct = nacl.secretbox(tagged, nonceFor(counter), key);
    counter += 1n;
    const frame = new Uint8Array(4 + ct.length);
    new DataView(frame.buffer).setUint32(0, ct.length, false);
    frame.set(ct, 4);
    parts.push(frame);
  };
  push(utf8(JSON.stringify(head)), body.length === 0);
  for (let off = 0; off < body.length; off += CHUNK_MAX) {
    const end = Math.min(off + CHUNK_MAX, body.length);
    push(body.subarray(off, end), end === body.length);
  }
  return { wire: concat(parts), binding: hex(streamId) };
}

export class TunnelError extends Error {
  constructor(status, code, message) { super(message ?? code); this.status = status; this.code = code; }
}

/** Open a response stream bound to our request; returns { head, body }. */
export function openTunnelResponse(tunnelKey, wire, expectBinding) {
  if (wire.length < 16) throw new TunnelError(502, 'short_stream');
  const streamId = wire.subarray(0, 16);
  const key = streamKey(tunnelKey, streamId);
  let off = 16; let counter = 0n; let head = null; const bodyParts = []; let sawFinal = false;
  while (off + 4 <= wire.length) {
    const len = new DataView(wire.buffer, wire.byteOffset + off, 4).getUint32(0, false);
    off += 4;
    if (off + len > wire.length) throw new TunnelError(502, 'truncated_frame');
    const plain = nacl.secretbox.open(wire.subarray(off, off + len), nonceFor(counter), key);
    off += len;
    if (!plain) throw new TunnelError(502, 'tamper');
    counter += 1n;
    const final = plain[0] === TAG_FINAL;
    const chunk = plain.subarray(1);
    if (head === null) {
      let parsed = null;
      try { parsed = JSON.parse(fromUtf8(chunk)); } catch { /* below */ }
      if (!parsed || typeof parsed !== 'object' || typeof parsed.s !== 'number') throw new TunnelError(502, 'bad_response_head');
      if (parsed.r !== expectBinding) throw new TunnelError(502, 'unbound_response');
      head = parsed;
    } else bodyParts.push(chunk);
    if (final) { sawFinal = true; break; }
  }
  if (head !== null && !sawFinal) throw new TunnelError(502, 'connection_slow');
  if (!sawFinal || head === null) throw new TunnelError(502, 'stream_truncated');
  return { head, body: concat(bodyParts) };
}

/** The daemon's side of the tunnel, for tests: open a request, seal a reply. */
export function openTunnelRequest(tunnelKey, wire) {
  const streamId = wire.subarray(0, 16);
  const key = streamKey(tunnelKey, streamId);
  let off = 16; let counter = 0n; let head = null; const body = [];
  while (off + 4 <= wire.length) {
    const len = new DataView(wire.buffer, wire.byteOffset + off, 4).getUint32(0, false);
    off += 4;
    const plain = nacl.secretbox.open(wire.subarray(off, off + len), nonceFor(counter), key);
    off += len; counter += 1n;
    if (!plain) throw new Error('tamper');
    const chunk = plain.subarray(1);
    if (head === null) head = JSON.parse(fromUtf8(chunk)); else body.push(chunk);
    if (plain[0] === TAG_FINAL) break;
  }
  return { head, body: concat(body), binding: hex(streamId) };
}
export function sealTunnelResponse(tunnelKey, head, body = new Uint8Array(0)) {
  return sealTunnelRequest(tunnelKey, head, body).wire;
}
