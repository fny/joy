// Sealed byte stream for the daemon tunnel: E2E encryption between a client
// (app/CLI) and a daemon, THROUGH a relay that must stay blind.
//
//   wire   = streamId(16) || frame*
//   frame  = len u32 BE || ciphertext || authTag(16)
//   AEAD   = IETF ChaCha20-Poly1305 (node:crypto native — tweetnacl's pure-JS
//            secretbox measured <1MB/s here, disqualifying for file streaming;
//            the app side pairs with libsodium crypto_aead_chacha20poly1305_ietf,
//            the same construction)
//   key    = per-STREAM subkey: HMAC-SHA512(tunnelKey, "stream" || streamId)[0..32]
//            — the 12-byte IETF nonce is then just the chunk counter, and
//            counter nonces can never collide across streams because no two
//            streams share a key (the same shape secretstream uses internally)
//   nonce  = u32(0) || counter u64 BE
//   plaintext frame = tag(1: 0x00 MESSAGE | 0x01 FINAL) || chunk
//
// Properties (each carried by a test):
//  - per-chunk authentication → streaming decryption, no whole-body buffering
//  - strict ordering: the counter IS the nonce; reorder/replay/drop fails MAC
//  - truncation-evidence: no FINAL tag ⇒ finish() throws, never silent EOF
//
// The tunnel key never touches the relay: both ends derive it —
// deriveTunnelKey(master, machineId) — the same zero-distribution trick as
// the relay perimeter key (pairing.ts).
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";

export const CHUNK_MAX = 128 * 1024; // plaintext bytes per frame
const TAG_LEN = 16;
const TAG_MESSAGE = 0x00;
const TAG_FINAL = 0x01;

export class TamperError extends Error {
  constructor(msg: string) { super(msg); this.name = "TamperError"; }
}

// ── key derivation ───────────────────────────────────────────────────────────

function hmac512(key: Uint8Array, data: Uint8Array): Buffer {
  return createHmac("sha512", key).update(data).digest();
}

/** Tunnel key for one machine — same chain shape as the perimeter key
 *  (hmac(seed, master) → chain → hmac(chain, 0x00||index)), with its own seed
 *  string so the trees can never collide. Both ends COMPUTE this; it is never
 *  distributed and the relay never holds it. */
export function deriveTunnelKey(master: Uint8Array, machineId: string): Uint8Array {
  const I = hmac512(new TextEncoder().encode("Joy Tunnel Master Seed"), master);
  const chain = I.subarray(32);
  const I2 = hmac512(chain, Buffer.concat([Buffer.from([0x00]), Buffer.from(machineId, "utf8")]));
  return new Uint8Array(I2.subarray(0, 32));
}

function streamKey(tunnelKey: Uint8Array, streamId: Uint8Array): Buffer {
  return hmac512(tunnelKey, Buffer.concat([Buffer.from("stream"), streamId])).subarray(0, 32);
}

function nonceFor(counter: bigint): Buffer {
  const n = Buffer.alloc(12);
  n.writeBigUInt64BE(counter, 4);
  return n;
}

// ── writer ───────────────────────────────────────────────────────────────────

export class SealedWriter {
  #key: Buffer;
  #streamId: Uint8Array;
  #counter = 0n;
  #finished = false;
  #headerSent = false;

  constructor(tunnelKey: Uint8Array, streamId?: Uint8Array) {
    if (tunnelKey.length !== 32) throw new Error("key must be 32 bytes");
    this.#streamId = streamId ?? new Uint8Array(randomBytes(16));
    this.#key = streamKey(tunnelKey, this.#streamId);
  }

  /** First bytes on the wire. Call once, before any frame. */
  header(): Uint8Array {
    if (this.#headerSent) throw new Error("header already emitted");
    this.#headerSent = true;
    return this.#streamId.slice();
  }

  /** Seal one chunk (≤ CHUNK_MAX) into a length-prefixed frame. */
  push(plaintext: Uint8Array, final: boolean): Uint8Array {
    if (!this.#headerSent) throw new Error("emit header() first");
    if (this.#finished) throw new Error("stream already finalized");
    if (plaintext.length > CHUNK_MAX) throw new Error(`chunk exceeds ${CHUNK_MAX}`);
    const cipher = createCipheriv("chacha20-poly1305", this.#key, nonceFor(this.#counter), { authTagLength: TAG_LEN });
    const tagged = Buffer.concat([Buffer.from([final ? TAG_FINAL : TAG_MESSAGE]), plaintext]);
    const ct = Buffer.concat([cipher.update(tagged), cipher.final(), cipher.getAuthTag()]);
    this.#counter += 1n;
    if (final) this.#finished = true;
    const frame = Buffer.alloc(4 + ct.length);
    frame.writeUInt32BE(ct.length, 0);
    ct.copy(frame, 4);
    return new Uint8Array(frame);
  }

  /** Seal an arbitrary buffer as N frames, the last tagged FINAL. */
  sealAll(data: Uint8Array): Uint8Array {
    const parts: Uint8Array[] = [this.header()];
    if (data.length === 0) { parts.push(this.push(new Uint8Array(0), true)); return concatAll(parts); }
    for (let off = 0; off < data.length; off += CHUNK_MAX) {
      const end = Math.min(off + CHUNK_MAX, data.length);
      parts.push(this.push(data.subarray(off, end), end === data.length));
    }
    return concatAll(parts);
  }
}

// ── reader ───────────────────────────────────────────────────────────────────

export class SealedReader {
  #tunnelKey: Uint8Array;
  #key: Buffer | null = null;
  #counter = 0n;
  #buf: Buffer = Buffer.alloc(0);
  #finished = false;

  constructor(tunnelKey: Uint8Array) {
    if (tunnelKey.length !== 32) throw new Error("key must be 32 bytes");
    this.#tunnelKey = tunnelKey;
  }

  get finished(): boolean { return this.#finished; }

  /** Feed wire bytes as they arrive; returns every chunk completed by this
   *  feed, each verified BEFORE it is returned. Throws TamperError on any
   *  auth failure (tamper, reorder, replay, wrong key) and on data after
   *  FINAL. Partial frames are buffered for the next feed. */
  feed(bytes: Uint8Array): Uint8Array[] {
    if (this.#finished && bytes.length > 0) throw new TamperError("data after FINAL");
    this.#buf = this.#buf.length === 0 ? Buffer.from(bytes) : Buffer.concat([this.#buf, bytes]);
    const out: Uint8Array[] = [];
    if (this.#key === null) {
      if (this.#buf.length < 16) return out;
      this.#key = streamKey(this.#tunnelKey, this.#buf.subarray(0, 16));
      this.#buf = this.#buf.subarray(16);
    }
    for (;;) {
      if (this.#buf.length < 4) return out;
      const len = this.#buf.readUInt32BE(0);
      if (len < TAG_LEN + 1 || len > CHUNK_MAX + TAG_LEN + 1) throw new TamperError("implausible frame length");
      if (this.#buf.length < 4 + len) return out;
      if (this.#finished) throw new TamperError("frame after FINAL");
      const ct = this.#buf.subarray(4, 4 + len - TAG_LEN);
      const authTag = this.#buf.subarray(4 + len - TAG_LEN, 4 + len);
      this.#buf = this.#buf.subarray(4 + len);
      let opened: Buffer;
      try {
        const d = createDecipheriv("chacha20-poly1305", this.#key, nonceFor(this.#counter), { authTagLength: TAG_LEN });
        d.setAuthTag(authTag);
        opened = Buffer.concat([d.update(ct), d.final()]);
      } catch {
        throw new TamperError(`frame ${this.#counter} failed authentication`);
      }
      this.#counter += 1n;
      const tag = opened[0];
      if (tag !== TAG_MESSAGE && tag !== TAG_FINAL) throw new TamperError("unknown frame tag");
      out.push(new Uint8Array(opened.subarray(1)));
      if (tag === TAG_FINAL) this.#finished = true;
    }
  }

  /** Call at EOF: an un-FINALed stream is a truncation, and must not pass
   *  silently — that is the whole point over plain streaming. */
  finish(): void {
    if (!this.#finished) throw new TamperError("stream truncated: no FINAL frame");
    if (this.#buf.length > 0) throw new TamperError("trailing bytes after FINAL");
  }

  /** Convenience: unseal a complete wire buffer to one plaintext. */
  static open(tunnelKey: Uint8Array, wire: Uint8Array): Uint8Array {
    const r = new SealedReader(tunnelKey);
    const chunks = r.feed(wire);
    r.finish();
    return concatAll(chunks);
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

function concatAll(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}
