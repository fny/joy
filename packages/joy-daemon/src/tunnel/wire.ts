// HTTP-over-sealed-stream encoding shared by executor (daemon) and client.
//
// Request plaintext stream : frame0 = JSON head { m, p, h }   (method/path/headers)
//                            frame1..N = body bytes; FINAL on the last frame
//                            (a bodiless request FINALs the head frame itself)
// Response plaintext stream: frame0 = JSON head { s, h }      (status/headers)
//                            frame1..N = body bytes, same FINAL rule.
import { SealedWriter, SealedReader, CHUNK_MAX } from "./sealedStream";

export interface RequestHead { m: string; p: string; h: Record<string, string> }
export interface ResponseHead { s: number; h: Record<string, string> }

export function sealRequest(key: Uint8Array, head: RequestHead, body: Uint8Array): Uint8Array {
  return sealHeadAndBody(key, JSON.stringify(head), body);
}
export function sealResponse(key: Uint8Array, head: ResponseHead, body: Uint8Array): Uint8Array {
  return sealHeadAndBody(key, JSON.stringify(head), body);
}

function sealHeadAndBody(key: Uint8Array, headJson: string, body: Uint8Array): Uint8Array {
  const w = new SealedWriter(key);
  const parts: Uint8Array[] = [w.header()];
  const headBytes = new TextEncoder().encode(headJson);
  if (headBytes.length > CHUNK_MAX) throw new Error("head exceeds one chunk");
  parts.push(w.push(headBytes, body.length === 0));
  for (let off = 0; off < body.length; off += CHUNK_MAX) {
    const end = Math.min(off + CHUNK_MAX, body.length);
    parts.push(w.push(body.subarray(off, end), end === body.length));
  }
  return concatAll(parts);
}

/** Unseal a complete head+body wire buffer. */
export function openHeadAndBody<T>(key: Uint8Array, wire: Uint8Array): { head: T; body: Uint8Array } {
  const r = new SealedReader(key);
  const chunks = r.feed(wire);
  r.finish();
  if (chunks.length === 0) throw new Error("empty stream");
  const head = JSON.parse(new TextDecoder().decode(chunks[0])) as T;
  return { head, body: concatAll(chunks.slice(1)) };
}

/** Incremental head+body reader for streamed responses: head resolves as soon
 *  as frame0 verifies; body chunks surface as they arrive. */
export class StreamingOpen<T> {
  #reader: SealedReader;
  head: T | null = null;
  constructor(key: Uint8Array) { this.#reader = new SealedReader(key); }
  get finished(): boolean { return this.#reader.finished; }
  feed(bytes: Uint8Array): Uint8Array[] {
    const chunks = this.#reader.feed(bytes);
    if (this.head === null && chunks.length > 0) {
      this.head = JSON.parse(new TextDecoder().decode(chunks[0])) as T;
      return chunks.slice(1);
    }
    return chunks;
  }
  finish(): void { this.#reader.finish(); }
}

export function concatAll(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}
