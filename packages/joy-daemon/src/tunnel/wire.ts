// HTTP-over-sealed-stream encoding shared by executor (daemon) and client.
//
// Request plaintext stream : frame0 = JSON head { m, p, h, t } (method/path/headers/client ms clock)
//                            frame1..N = body bytes; FINAL on the last frame
//                            (a bodiless request FINALs the head frame itself)
// Response plaintext stream: frame0 = JSON head { s, h, r }   (status/headers/binding)
//                            frame1..N = body bytes, same FINAL rule.
//
// Binding (r): every response head names the request it answers — `r` is the
// hex of the REQUEST stream id (the 16 random bytes the client put first on
// the wire). It rides inside the sealed head, so a relay cannot forge or
// strip it, and a client that checks it cannot be fed a recorded response to
// some OTHER request as if it were this one's (the response key alone did not
// prevent that: it was derived from the response's own stream id, which the
// relay controls by replaying the whole stream). The daemon always emits `r`;
// a client that was not told what to expect (an older one) ignores it.
import { SealedWriter, SealedReader, CHUNK_MAX, TamperError } from "./sealedStream";

/** `t` (client ms clock) lets the daemon refuse a request the relay held back
 *  (replayGuard.ts). Optional on the wire: older clients do not send it. */
export interface RequestHead { m: string; p: string; h: Record<string, string>; t?: number }
export interface ResponseHead { s: number; h: Record<string, string>; r?: string }

/** The binding a response to this request wire must carry: hex(stream id). */
export function requestBinding(requestWire: Uint8Array): string {
  return Buffer.from(requestWire.subarray(0, 16)).toString("hex");
}

/** Throw unless `head` is a response head bound to `expectBinding`. Runs on
 *  the first frame, before any status or body is surfaced to the caller. */
export function assertBoundResponse(head: unknown, expectBinding: string): void {
  const h = head as Partial<ResponseHead> | null;
  if (!h || typeof h !== "object" || typeof h.s !== "number") throw new TamperError("response head malformed");
  if (h.r !== expectBinding) throw new TamperError(h.r === undefined ? "response carries no request binding" : "response bound to another request");
}

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

/** Unseal a complete head+body wire buffer. With `expectBinding` (a response
 *  being opened by the client that sent the request) the head must be bound
 *  to that request or the whole stream is rejected. */
export function openHeadAndBody<T>(key: Uint8Array, wire: Uint8Array, expectBinding?: string): { head: T; body: Uint8Array } {
  const r = new SealedReader(key);
  const chunks = r.feed(wire);
  r.finish();
  if (chunks.length === 0) throw new Error("empty stream");
  const head = JSON.parse(new TextDecoder().decode(chunks[0])) as T;
  if (expectBinding !== undefined) assertBoundResponse(head, expectBinding);
  return { head, body: concatAll(chunks.slice(1)) };
}

/** Incremental head+body reader for streamed responses: head resolves as soon
 *  as frame0 verifies; body chunks surface as they arrive. With
 *  `expectBinding` the head is checked against the request BEFORE it (or any
 *  body chunk) is surfaced. */
export class StreamingOpen<T> {
  #reader: SealedReader;
  #expectBinding: string | undefined;
  head: T | null = null;
  constructor(key: Uint8Array, expectBinding?: string) {
    this.#reader = new SealedReader(key);
    this.#expectBinding = expectBinding;
  }
  get finished(): boolean { return this.#reader.finished; }
  feed(bytes: Uint8Array): Uint8Array[] {
    const chunks = this.#reader.feed(bytes);
    if (this.head === null && chunks.length > 0) {
      const head = JSON.parse(new TextDecoder().decode(chunks[0])) as T;
      if (this.#expectBinding !== undefined) assertBoundResponse(head, this.#expectBinding);
      this.head = head;
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
