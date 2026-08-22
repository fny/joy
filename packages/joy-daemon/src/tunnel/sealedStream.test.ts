// Every property the tunnel's security rests on gets its own test: a sealed
// stream must stream (per-chunk verify), refuse reorder/replay/tamper, and
// make truncation LOUD. These are the guarantees the relay is trusted not to
// need — so they must hold against a malicious relay, which is what the
// adversarial cases simulate.
import { test, expect } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { SealedWriter, SealedReader, TamperError, deriveTunnelKey, CHUNK_MAX } from "./sealedStream";

const rnd = (n: number) => new Uint8Array(randomBytes(n));
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const master = new Uint8Array(32).fill(7);
const KEY = deriveTunnelKey(master, "machine-a");

function sealAll(data: Uint8Array, key = KEY): Uint8Array {
  return new SealedWriter(key).sealAll(data);
}

test("round-trips empty, small, and multi-chunk payloads", () => {
  for (const size of [0, 1, 17, CHUNK_MAX, CHUNK_MAX + 1, 5 * 1024 * 1024 + 3]) {
    const data = rnd(size);
    // digest compare: vitest toEqual walks big buffers element-by-element (~30s at 5MB)
    expect(sha(SealedReader.open(KEY, sealAll(data)))).toBe(sha(data));
  }
});

test("derived keys: per-machine, deterministic, distinct from the perimeter tree", () => {
  expect(deriveTunnelKey(master, "machine-a")).toEqual(deriveTunnelKey(master, "machine-a"));
  expect(deriveTunnelKey(master, "machine-b")).not.toEqual(deriveTunnelKey(master, "machine-a"));
  expect(deriveTunnelKey(new Uint8Array(32).fill(8), "machine-a")).not.toEqual(KEY);
});

test("streams: chunks come out verified as bytes arrive, before FINAL", () => {
  const w = new SealedWriter(KEY);
  const wire = [w.header(), w.push(new TextEncoder().encode("first"), false)];
  const r = new SealedReader(KEY);
  const got: Uint8Array[] = [];
  for (const part of wire) got.push(...r.feed(part));
  expect(Buffer.concat(got).toString()).toBe("first"); // usable NOW
  expect(r.finished).toBe(false);
  got.push(...r.feed(w.push(new TextEncoder().encode("|last"), true)));
  r.finish();
  expect(Buffer.concat(got).toString()).toBe("first|last");
});

test("byte-dribble: arbitrary wire fragmentation reassembles identically", () => {
  const data = rnd(300_000);
  const wire = sealAll(data);
  const r = new SealedReader(KEY);
  const got: Uint8Array[] = [];
  for (let i = 0; i < wire.length; i += 997) got.push(...r.feed(wire.slice(i, i + 997)));
  r.finish();
  expect(sha(Buffer.concat(got))).toBe(sha(data));
});

test("tamper: one flipped ciphertext bit fails that frame's authentication", () => {
  const wire = sealAll(rnd(200_000));
  const evil = wire.slice();
  evil[16 + 4 + 50] ^= 0x01; // inside the first frame's box
  expect(() => SealedReader.open(KEY, evil)).toThrow(TamperError);
});

test("reorder: swapping two frames fails — the counter is the nonce", () => {
  const w = new SealedWriter(KEY);
  const h = w.header();
  const f1 = w.push(rnd(100), false);
  const f2 = w.push(rnd(100), false);
  const f3 = w.push(rnd(10), true);
  const r = new SealedReader(KEY);
  r.feed(h);
  expect(() => { r.feed(f2); r.feed(f1); r.feed(f3); }).toThrow(TamperError);
});

test("replay: repeating a frame fails for the same reason", () => {
  const w = new SealedWriter(KEY);
  const h = w.header();
  const f1 = w.push(rnd(100), false);
  const r = new SealedReader(KEY);
  r.feed(h); r.feed(f1);
  expect(() => r.feed(f1)).toThrow(TamperError);
});

test("truncation: missing FINAL is an error at finish(), never a silent EOF", () => {
  const w = new SealedWriter(KEY);
  const wire = [w.header(), w.push(rnd(100), false)]; // no final
  const r = new SealedReader(KEY);
  for (const p of wire) r.feed(p);
  expect(() => r.finish()).toThrow(/truncated/);
});

test("data after FINAL is rejected", () => {
  const w = new SealedWriter(KEY);
  const wire = Buffer.concat([w.header(), w.push(rnd(10), true)]);
  const r = new SealedReader(KEY);
  r.feed(wire);
  const w2 = new SealedWriter(KEY);
  w2.header();
  expect(() => r.feed(w2.push(rnd(10), true))).toThrow(TamperError);
});

test("wrong key (wrong machine, wrong account) cannot read a single chunk", () => {
  const wire = sealAll(rnd(1000));
  expect(() => SealedReader.open(deriveTunnelKey(master, "machine-b"), wire)).toThrow(TamperError);
  expect(() => SealedReader.open(deriveTunnelKey(new Uint8Array(32).fill(9), "machine-a"), wire)).toThrow(TamperError);
});
