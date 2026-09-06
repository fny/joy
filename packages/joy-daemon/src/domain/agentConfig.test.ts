import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { parsePathExpr, parseAssignment, applyAgentConfigAssignments, readAgentConfig, writeAgentConfigRaw } from "./agentConfig";

describe("parsePathExpr", () => {
  it("splits dots and [n] indices", () => {
    expect(parsePathExpr("examples[0].title")).toEqual(["examples", 0, "title"]);
    expect(parsePathExpr("model")).toEqual(["model"]);
    expect(parsePathExpr("permissions.allow[2]")).toEqual(["permissions", "allow", 2]);
    expect(parsePathExpr("a[0][1].b")).toEqual(["a", 0, 1, "b"]);
  });
  // #525: the grammar is anchored — anything the old scanner silently skipped
  // is now an error, so the op cannot report a write that never happened.
  it("rejects negative indices, unmatched brackets, empty segments and stray separators (#525)", () => {
    for (const bad of ["examples[-1].title", "a[", "a]", "a[b]", "a..b", ".a", "a.", "a[1]x", "", "a[ 1 ]"]) {
      expect(() => parsePathExpr(bad), bad).toThrow(/bad path/);
    }
  });
  // #54: prototype-walking segments never reach the document.
  it("refuses __proto__ / constructor / prototype segments (#54)", () => {
    expect(() => parsePathExpr("__proto__.polluted")).toThrow(/not an allowed key/);
    expect(() => parsePathExpr("constructor.prototype.polluted")).toThrow(/not an allowed key/);
    expect(() => parsePathExpr("a.prototype")).toThrow(/not an allowed key/);
  });
});

describe("parseAssignment", () => {
  it("JSON values parse; bare words stay strings", () => {
    expect(parseAssignment('examples[0].title = "this is an example"')).toEqual({ path: ["examples", 0, "title"], value: "this is an example", del: false });
    expect(parseAssignment("a.b = true")).toEqual({ path: ["a", "b"], value: true, del: false });
    expect(parseAssignment("a.b = 42")).toEqual({ path: ["a", "b"], value: 42, del: false });
    expect(parseAssignment("model = opus")).toEqual({ path: ["model"], value: "opus", del: false });
    expect(parseAssignment('env = {"FOO":"bar"}')).toEqual({ path: ["env"], value: { FOO: "bar" }, del: false });
  });
  it("null deletes", () => {
    expect(parseAssignment("a.b = null").del).toBe(true);
  });
  it("rejects non-assignments", () => {
    expect(() => parseAssignment("no equals here")).toThrow();
  });
});

// applyAgentConfigAssignments / readAgentConfig / writeAgentConfigRaw resolve
// their per-agent paths under $HOME at call time — point HOME at a temp dir.
describe("agent config file round-trip", () => {
  const home = mkdtempSync(join(tmpdir(), "joy-agentconfig-"));
  const realHome = process.env.HOME;
  beforeEach(() => { process.env.HOME = home; });
  afterAll(() => { process.env.HOME = realHome; rmSync(home, { recursive: true, force: true }); });

  it("merges assignments into existing claude settings.json, keeps other keys, writes backup", () => {
    const dir = join(home, ".claude");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "settings.json");
    writeFileSync(file, JSON.stringify({ model: "opus", env: { KEEP: "1" } }, null, 2));

    const r = applyAgentConfigAssignments("claude", ['env.NEW = "yes"', "alwaysThinkingEnabled = true"]);
    expect(r.ok).toBe(true);
    const doc = JSON.parse(readFileSync(file, "utf-8"));
    expect(doc).toEqual({ model: "opus", env: { KEEP: "1", NEW: "yes" }, alwaysThinkingEnabled: true });
    expect(existsSync(file + ".joy-bak")).toBe(true);
    expect(JSON.parse(readFileSync(file + ".joy-bak", "utf-8")).env).toEqual({ KEEP: "1" });
  });

  it("creates the file when missing and supports array paths", () => {
    const r = applyAgentConfigAssignments("pi", ['examples[0].title = "this is an example"']);
    expect(r.ok).toBe(true);
    const doc = JSON.parse(readFileSync(join(home, ".pi", "agent", "settings.json"), "utf-8"));
    expect(doc.examples[0].title).toBe("this is an example");
  });

  it("codex config.toml round-trips through smol-toml", () => {
    const dir = join(home, ".codex");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.toml"), 'model = "gpt-5.5"\n');
    const r = applyAgentConfigAssignments("codex", ["model_reasoning_effort = high"]);
    expect(r.ok).toBe(true);
    const read = readAgentConfig("codex");
    expect(read.ok).toBe(true);
    expect((read as any).parsed).toMatchObject({ model: "gpt-5.5", model_reasoning_effort: "high" });
  });

  it("refuses to merge into an unparseable file", () => {
    const dir = join(home, ".config", "opencode");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "opencode.json"), "{ broken");
    const r = applyAgentConfigAssignments("opencode", ["theme = dark"]);
    expect(r.ok).toBe(false);
    expect((r as any).error).toContain("raw mode");
  });

  it("writeAgentConfigRaw validates format", () => {
    expect(writeAgentConfigRaw("claude", "not json").ok).toBe(false);
    expect(writeAgentConfigRaw("claude", '{"model":"fable"}').ok).toBe(true);
  });

  // #526: deleting a MISSING descendant used to auto-vivify its way there,
  // replacing the scalar parent with {} before deleting nothing.
  it("deleting a missing descendant leaves an existing scalar parent untouched (#526)", () => {
    const dir = join(home, ".claude");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "settings.json");
    writeFileSync(file, JSON.stringify({ important: "original", env: { A: "1" } }));
    const r = applyAgentConfigAssignments("claude", ["important.missing = null", "nope.deeper.key = null", "env.B = null"]);
    expect(r.ok).toBe(true);
    expect((r as any).applied).toBe(0); // nothing changed
    expect(JSON.parse(readFileSync(file, "utf-8"))).toEqual({ important: "original", env: { A: "1" } });
    // A real delete still works and is counted.
    const r2 = applyAgentConfigAssignments("claude", ["env.A = null"]);
    expect((r2 as any).applied).toBe(1);
    expect(JSON.parse(readFileSync(file, "utf-8"))).toEqual({ important: "original", env: {} });
  });

  // #525: a malformed path is an error for the whole op; the file is unchanged.
  it("a malformed path fails the op and leaves the file unchanged (#525)", () => {
    const dir = join(home, ".claude");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "settings.json");
    const before = JSON.stringify({ examples: [{ title: "a" }] });
    writeFileSync(file, before);
    const r = applyAgentConfigAssignments("claude", ['examples[-1].title = "change"']);
    expect(r.ok).toBe(false);
    expect((r as any).error).toMatch(/bad path/);
    expect(readFileSync(file, "utf-8")).toBe(before);
    // Type mismatch against the real document is an error too, not a stringly write.
    const r2 = applyAgentConfigAssignments("claude", ['examples.title = "x"']);
    expect(r2.ok).toBe(false);
    expect((r2 as any).error).toMatch(/type mismatch/);
    expect(readFileSync(file, "utf-8")).toBe(before);
  });

  // #54: the op is meant to be exposed to an editor UI — it must not be able
  // to touch Object.prototype.
  it("cannot pollute Object.prototype through a path expression (#54)", () => {
    const r = applyAgentConfigAssignments("claude", ["__proto__.polluted = 1"]);
    expect(r.ok).toBe(false);
    expect(({} as any).polluted).toBeUndefined();
    const r2 = applyAgentConfigAssignments("claude", ["constructor.prototype.polluted2 = 1"]);
    expect(r2.ok).toBe(false);
    expect(({} as any).polluted2).toBeUndefined();
  });

  it("unknown agent is rejected", () => {
    expect(readAgentConfig("mystery").ok).toBe(false);
  });
});
