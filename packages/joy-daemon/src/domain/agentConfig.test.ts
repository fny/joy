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

  it("unknown agent is rejected", () => {
    expect(readAgentConfig("mystery").ok).toBe(false);
  });
});
