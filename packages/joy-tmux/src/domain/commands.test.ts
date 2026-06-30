import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  scanCommandsDir,
  scanSkillsDir,
  scanProject,
  scanMachine,
  scanPluginCommands,
  CommandRegistry,
} from "./commands.ts";

let root: string;

function write(rel: string, body = "") {
  const p = join(root, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, body);
}

beforeEach(() => { root = mkdtempSync(join(tmpdir(), "joy-cmds-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe("scanCommandsDir", () => {
  it("lists *.md and namespaces one level of subdirs", () => {
    write(".claude/commands/deploy.md");
    write(".claude/commands/test.md");
    write(".claude/commands/frontend/build.md");
    write(".claude/commands/notes.txt"); // ignored (not .md)
    expect(scanCommandsDir(join(root, ".claude/commands")).map((c) => c.name).sort())
      .toEqual(["deploy", "frontend:build", "test"]);
  });

  it("captures the frontmatter description when present", () => {
    write(".claude/commands/deploy.md", "---\ndescription: Ship it\n---\nbody");
    write(".claude/commands/plain.md", "no frontmatter");
    const byName = Object.fromEntries(
      scanCommandsDir(join(root, ".claude/commands")).map((c) => [c.name, c.description]),
    );
    expect(byName.deploy).toBe("Ship it");
    expect(byName.plain).toBeUndefined();
  });

  it("returns [] for a missing dir", () => {
    expect(scanCommandsDir(join(root, "nope"))).toEqual([]);
  });
});

describe("scanSkillsDir", () => {
  it("uses the SKILL.md frontmatter name, falling back to the dir name", () => {
    write(".claude/skills/codex/SKILL.md", "---\nname: codex\ndescription: x\n---\nbody");
    write(".claude/skills/weird-dir/SKILL.md", "---\ndescription: no name here\n---\nbody");
    write(".claude/skills/notaskill/readme.md", "no manifest"); // skipped (no SKILL.md)
    expect(scanSkillsDir(join(root, ".claude/skills")).map((c) => c.name).sort())
      .toEqual(["codex", "weird-dir"]);
  });
});

describe("scanProject", () => {
  it("merges commands + skills, deduped and sorted", () => {
    write(".claude/commands/deploy.md");
    write(".claude/skills/review/SKILL.md", "---\nname: review\n---");
    expect(scanProject(root).map((c) => c.name)).toEqual(["deploy", "review"]);
  });
});

describe("scanPluginCommands", () => {
  it("namespaces plugin commands and skills as plugin:name", () => {
    write(".claude/plugins/marketplaces/official/plugins/hookify/commands/configure.md");
    write(".claude/plugins/marketplaces/official/plugins/hookify/skills/lint/SKILL.md", "---\nname: lint\n---");
    expect(scanPluginCommands(join(root, ".claude/plugins")).map((c) => c.name).sort())
      .toEqual(["hookify:configure", "hookify:lint"]);
  });
});

describe("CommandRegistry", () => {
  it("projects a session as machine ∪ project, and unions across projects", () => {
    // machine-wide (personal) commands live under <home>/.claude
    write(".claude/commands/global.md");
    const reg = new CommandRegistry({ relayClient: null, baseMachineMetadata: {}, homeDir: root });
    reg.rescanMachine();

    reg.setProject("/proj/a", ["a-only"]);
    reg.setProject("/proj/b", ["b-only"]);

    expect(reg.forProject("/proj/a")).toEqual(["a-only", "global"]);
    expect(reg.forProject("/proj/b")).toEqual(["b-only", "global"]);
    // union = machine ∪ every project (machine knowledge persists across projects)
    expect(reg.union()).toEqual(["a-only", "b-only", "global"]);
  });

  it("refresh() re-validates projects so removed commands drop out", () => {
    const reg = new CommandRegistry({ relayClient: null, baseMachineMetadata: {}, homeDir: root });
    reg.rescanMachine();
    reg.setProject(root, scanProject(root).map((c) => c.name)); // currently empty
    write(".claude/commands/new.md");        // add a command after the initial scan
    expect(reg.refresh().slashCommands).toContain("new");
  });
});
