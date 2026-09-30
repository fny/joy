// The sealed tunnel to one daemon, for small JSON calls — a port of
// packages/joy-daemon/src/tunnel/{sealedStream,wire,client}.ts.
//
// Direct mode uses it for ONE thing: carrying the WebRTC offer and answer.
// Sealed under the machine's tunnel key, the relay can neither read nor swap
// them, so it cannot put itself in the middle of the peer connection.
//
// Wire: streamId16 ‖ frames; frame = u32be(len) ‖ secretbox(tag ‖ chunk)
// under hmac512(tunnelKey, "stream" ‖ streamId)[0..32], nonce = counter as a
// big-endian u64 in the last 8 of 24 bytes; tag 0x01 marks the final frame.
// The first chunk is the JSON head; the response head names the request it
// answers (r = hex(request streamId)).
import { deriveKey, hmac512, utf8, fromUtf8, hex, randomBytes, secretbox, secretboxOpen } from './crypto.js';

const CHUNK_MAX = 128 * 1024;

export const tunnelKeyFor = (machineKey, machineId) => deriveKey(machineKey, 'Joy Tunnel', [machineId]);

const streamKey = (key, streamId) => hmac512(key, concat(utf8('stream'), streamId)).slice(0, 32);
function nonceFor(counter) {
  const n = new Uint8Array(24);
  new DataView(n.buffer).setBigUint64(16, BigInt(counter));
  return n;
}
function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/** Seal a request: { wire, binding }. */
export function sealRequest(key, head, body = new Uint8Array(0)) {
  const streamId = randomBytes(16);
  const k = streamKey(key, streamId);
  const chunks = [utf8(JSON.stringify(head))];
  for (let off = 0; off < body.length; off += CHUNK_MAX) chunks.push(body.subarray(off, off + CHUNK_MAX));
  const parts = [streamId];
  chunks.forEach((c, i) => {
    const final = i === chunks.length - 1;
    const ct = secretbox(concat(new Uint8Array([final ? 1 : 0]), c), nonceFor(i), k);
    const len = new Uint8Array(4);
    new DataView(len.buffer).setUint32(0, ct.length);
    parts.push(len, ct);
  });
  return { wire: concat(...parts), binding: hex(streamId) };
}

/** Open a complete response; throws unless it is whole, authentic and bound
 *  to the request with `binding`. */
export function openResponse(key, wire, binding) {
  if (wire.length < 16) throw new Error('tunnel: short response');
  const k = streamKey(key, wire.subarray(0, 16));
  const view = new DataView(wire.buffer, wire.byteOffset, wire.byteLength);
  const chunks = [];
  let at = 16; let counter = 0; let finished = false;
  while (at < wire.length) {
    if (finished) throw new Error('tunnel: data after the final frame');
    if (at + 4 > wire.length) throw new Error('tunnel: truncated frame');
    const len = view.getUint32(at);
    if (at + 4 + len > wire.length) throw new Error('tunnel: truncated frame');
    const opened = secretboxOpen(wire.subarray(at + 4, at + 4 + len), nonceFor(counter), k);
    if (!opened) throw new Error('tunnel: a frame failed authentication');
    counter++; at += 4 + len;
    if (opened[0] === 1) finished = true;
    else if (opened[0] !== 0) throw new Error('tunnel: unknown frame tag');
    chunks.push(opened.subarray(1));
  }
  if (!finished) throw new Error('tunnel: the response was cut off');
  const head = JSON.parse(fromUtf8(chunks[0]));
  if (head?.r !== binding) throw new Error('tunnel: the response answers another request');
  return { status: head.s, headers: head.h ?? {}, body: concat(...chunks.slice(1)) };
}

/** One JSON call to the daemon's local API through the relay. `post(wire)`
 *  sends the sealed bytes to the relay's tunnel entry for this machine and
 *  resolves { status, contentType, bytes } (RelayClient.postTunnel). */
export async function tunnelJson(post, key, method, path, body) {
  const bytes = body === undefined ? new Uint8Array(0) : utf8(JSON.stringify(body));
  const headers = body === undefined ? {} : { 'content-type': 'application/json' };
  const { wire, binding } = sealRequest(key, { m: method, p: path, h: headers, t: Date.now() }, bytes);
  const r = await post(wire);
  if ((r.contentType ?? '').includes('application/json')) {
    // The relay's own refusal (daemon_offline, 403) — not the daemon's answer.
    let code = `relay_${r.status}`;
    try { code = JSON.parse(fromUtf8(r.bytes))?.error ?? code; } catch { /* keep the status */ }
    throw Object.assign(new Error(code === 'daemon_offline' ? 'the machine is offline' : `relay: ${code}`), { status: r.status, code });
  }
  const res = openResponse(key, r.bytes, binding);
  let json = null;
  try { json = JSON.parse(fromUtf8(res.body)); } catch { /* not json */ }
  return { status: res.status, json };
}
