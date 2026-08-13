import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { resolveTranscriptId } from "./transcript";

// A throwaway dir holding fake transcripts to resolve ids against.
const DIR = "/tmp/joy-resolve-id-test";

beforeAll(() => {
  mkdirSync(DIR, { recursive: true });
  for (const id of ["abc123def", "abc999xyz", "z0000000", "shared"]) {
    writeFileSync(join(DIR, `${id}.jsonl`), "");
  }
  // Non-transcript noise that must be ignored.
  writeFileSync(join(DIR, "abc123def.txt"), "");
  writeFileSync(join(DIR, "notes.md"), "");
});

afterAll(() => rmSync(DIR, { recursive: true, force: true }));

describe("resolveTranscriptId", () => {
  it("returns an exact full id unchanged", () => {
    expect(resolveTranscriptId(DIR, "abc123def")).toBe("abc123def");
  });

  it("expands a unique prefix to the full id", () => {
    expect(resolveTranscriptId(DIR, "abc1")).toBe("abc123def");
    expect(resolveTranscriptId(DIR, "z")).toBe("z0000000");
  });

  it("throws on an ambiguous prefix rather than guessing", () => {
    expect(() => resolveTranscriptId(DIR, "abc")).toThrow(/ambiguous/);
  });

  it("leaves an unmatched id unchanged (caller reports not-found)", () => {
    expect(resolveTranscriptId(DIR, "nope")).toBe("nope");
  });

  it("prefers an exact match even when it is also a prefix of a longer id", () => {
    writeFileSync(join(DIR, "shared777.jsonl"), "");
    // "shared" matches both shared.jsonl (exact) and shared777.jsonl (prefix) —
    // the exact transcript wins instead of throwing ambiguous.
    expect(resolveTranscriptId(DIR, "shared")).toBe("shared");
  });

  it("only considers .jsonl files, not same-named other extensions", () => {
    // abc123def.txt exists but must not affect resolution of the .jsonl.
    expect(resolveTranscriptId(DIR, "abc123def")).toBe("abc123def");
  });

  it("returns the input unchanged when the dir does not exist", () => {
    expect(resolveTranscriptId("/no/such/dir", "abc1")).toBe("abc1");
  });
});
