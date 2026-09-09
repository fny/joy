import { describe, it, expect } from "vitest";
import { chunkForTyping, garbledEchoOf, TYPE_CHUNK_CHARS } from "./typing";

describe("chunkForTyping", () => {
  it("leaves a short line whole and an empty line absent", () => {
    expect(chunkForTyping("hello")).toEqual(["hello"]);
    expect(chunkForTyping("")).toEqual([]);
  });
  it("splits a long line into pieces that fit the pty queue and rejoin exactly", () => {
    const line = "x".repeat(7_345);
    const parts = chunkForTyping(line);
    expect(parts.length).toBe(Math.ceil(7_345 / TYPE_CHUNK_CHARS));
    expect(parts.every((p) => Array.from(p).length <= TYPE_CHUNK_CHARS)).toBe(true);
    expect(parts.join("")).toBe(line);
  });
  it("never splits inside a surrogate pair", () => {
    const line = "😀".repeat(1_500);
    const parts = chunkForTyping(line, 1_000);
    expect(parts.length).toBe(2);
    expect(parts.join("")).toBe(line);
    for (const p of parts) expect(() => encodeURIComponent(p)).not.toThrow(); // lone surrogates throw here
  });
});

describe("garbledEchoOf", () => {
  const dispatch = "A".repeat(4_042) + "B".repeat(3_303); // 7,345 like the real one
  it("recognises the real case: the first 4,042 landed, then something else", () => {
    const echo = "A".repeat(4_042) + "B".repeat(1_654);
    expect(garbledEchoOf(echo, dispatch)).toEqual({ landed: 5_696, total: 7_345 });
  });
  it("is null for an exact echo, and for a genuinely different message", () => {
    expect(garbledEchoOf(dispatch, dispatch)).toBeNull();
    expect(garbledEchoOf("yes", dispatch)).toBeNull();
    expect(garbledEchoOf("C".repeat(3_000), dispatch)).toBeNull();
  });
  it("needs a prefix of at least a quarter of the dispatch, floored at 256", () => {
    expect(garbledEchoOf("A".repeat(1_800) + "Z", dispatch)).toBeNull();          // < 7345/4
    expect(garbledEchoOf("A".repeat(1_900) + "Z", dispatch)).not.toBeNull();
    const short = "q".repeat(300);
    expect(garbledEchoOf("q".repeat(200) + "Z", short)).toBeNull();               // < 256
    expect(garbledEchoOf("q".repeat(260) + "Z", short)).not.toBeNull();
  });
});
