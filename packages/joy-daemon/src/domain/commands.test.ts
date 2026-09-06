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
    expect(scanCommandsDir(join(root, ".claude/commands"), "claude:command").map((c) => c.name).sort())
      .toEqual(["deploy", "frontend:build", "test"]);
  });

  it("captures the frontmatter description when present", () => {
    write(".claude/commands/deploy.md", "---\ndescription: Ship it\n---\nbody");
    write(".claude/commands/plain.md", "no frontmatter");
    const byName = Object.fromEntries(
      scanCommandsDir(join(root, ".claude/commands"), "claude:command").map((c) => [c.name, c.description]),
    );
    expect(byName.deploy).toBe("Ship it");
    expect(byName.plain).toBeUndefined();
  });

  it("returns [] for a missing dir", () => {
    expect(scanCommandsDir(join(root, "nope"), "claude:command")).toEqual([]);
  });
});

describe("scanSkillsDir", () => {
  it("uses the SKILL.md frontmatter name, falling back to the dir name", () => {
    write(".claude/skills/codex/SKILL.md", "---\nname: codex\ndescription: x\n---\nbody");
    write(".claude/skills/weird-dir/SKILL.md", "---\ndescription: no name here\n---\nbody");
    write(".claude/skills/notaskill/readme.md", "no manifest"); // skipped (no SKILL.md)
    expect(scanSkillsDir(join(root, ".claude/skills"), "claude:skill").map((c) => c.name).sort())
      .toEqual(["codex", "weird-dir"]);
  });
});

describe("frontmatter edge cases (#531)", () => {
  it("an empty name: does not swallow the next field; the dir name is the fallback", () => {
    write(".claude/skills/deploy/SKILL.md", "---\nname:\ndescription: Deploy the app\n---\nbody");
    write(".claude/skills/spaced/SKILL.md", "---\nname:   \t\ndescription:\t  Tabs and spaces  \n---\nbody");
    const byDir = Object.fromEntries(scanSkillsDir(join(root, ".claude/skills"), "claude:skill").map((c) => [c.description, c.name]));
    expect(byDir["Deploy the app"]).toBe("deploy");
    expect(byDir["Tabs and spaces"]).toBe("spaced");
  });
});

describe("description ownership (#532)", () => {
  it("a description removed from the source disappears from the next push", async () => {
    const pushed: Array<Record<string, unknown>> = [];
    const relay = { getOrCreateMachine: async (meta: Record<string, unknown>) => { pushed.push(meta); return true; }, capabilities: () => ({}) };
    const reg = new CommandRegistry({ relayClient: relay as never, baseMachineMetadata: {}, homeDir: join(root, "nohome") });
    write(".claude/commands/deploy.md", "---\ndescription: Old description\n---");
    reg.setProject(root, []); // register the project cwd; refresh() rescans it
    reg.refresh();
    await reg.pushMachineIfChanged();
    expect(pushed.at(-1)?.slashCommandDescriptions).toEqual({ deploy: "Old description" });
    write(".claude/commands/deploy.md", "no frontmatter any more");
    reg.refresh();
    await reg.pushMachineIfChanged();
    expect(pushed.at(-1)?.slashCommandDescriptions).toEqual({});
    // a description supplied by ANOTHER current source survives a rescan of this one
    write("other/.claude/commands/deploy.md", "---\ndescription: From project B\n---");
    reg.setProject(join(root, "other"), scanProject(join(root, "other")));
    reg.refresh();
    await reg.pushMachineIfChanged();
    expect(pushed.at(-1)?.slashCommandDescriptions).toEqual({ deploy: "From project B" });
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

    reg.setProject("/proj/a", [{ name: "a-only", tags: ["claude:command"] }]);
    reg.setProject("/proj/b", [{ name: "b-only", tags: ["claude:command"] }]);

    expect(reg.forProject("/proj/a")).toEqual(["a-only", "global"]);
    expect(reg.forProject("/proj/b")).toEqual(["b-only", "global"]);
    // union = machine ∪ every project (machine knowledge persists across projects)
    expect(reg.union()).toEqual(["a-only", "b-only", "global"]);
  });

  it("refresh() re-validates projects so removed commands drop out", () => {
    const reg = new CommandRegistry({ relayClient: null, baseMachineMetadata: {}, homeDir: root });
    reg.rescanMachine();
    reg.setProject(root, scanProject(root)); // currently empty
    write(".claude/commands/new.md");        // add a command after the initial scan
    expect(reg.refresh().slashCommands).toContain("new");
  });
});

// ── multi-agent conventions (codex / opencode / .agents) ────────────────────
describe("multi-agent discovery", () => {
  it("scanProject sees codex, opencode, and .agents skills + opencode commands", () => {
    write(".codex/skills/codex-skill/SKILL.md", "---\ndescription: c\n---");
    write(".opencode/skills/oc-skill/SKILL.md", "---\ndescription: o\n---");
    write(".agents/skills/shared-skill/SKILL.md", "---\ndescription: s\n---");
    write(".opencode/commands/oc-cmd.md");
    expect(scanProject(root).map((c) => c.name)).toEqual(["codex-skill", "oc-cmd", "oc-skill", "shared-skill"]);
  });

  it("scanMachine sees codex prompts (top-level only) + personal skills across conventions", () => {
    write(".codex/prompts/draftpr.md", "---\ndescription: Draft a PR\n---");
    // codex ignores subdirectories of prompts — so must we.
    write(".codex/prompts/nested/hidden.md");
    write(".codex/skills/personal-codex/SKILL.md");
    write(".agents/skills/personal-shared/SKILL.md");
    write(".config/opencode/commands/oc-global.md");
    const names = scanMachine(root).map((c) => c.name);
    expect(names).toContain("draftpr");
    expect(names).toContain("personal-codex");
    expect(names).toContain("personal-shared");
    expect(names).toContain("oc-global");
    expect(names).not.toContain("nested:hidden");
    expect(names).not.toContain("hidden");
  });
});

describe("flavor-filtered projection", () => {
  it("each flavor's palette only offers what its harness loads", () => {
    write(".claude/commands/cc.md");
    write(".claude/skills/claude-skill/SKILL.md");
    write(".codex/skills/codex-skill/SKILL.md");
    write(".opencode/commands/oc-cmd.md");
    write(".agents/skills/shared/SKILL.md");
    const reg = new CommandRegistry({ relayClient: null, baseMachineMetadata: {}, homeDir: join(root, "nohome") });
    reg.setProject(root, scanProject(root));
    expect(reg.forProject(root, "claude")).toEqual(["cc", "claude-skill"]);
    // codex: own skills + the cross-agent standard — NOT claude's anything
    expect(reg.forProject(root, "codex")).toEqual(["codex-skill", "shared"]);
    // opencode: own + .agents + claude SKILLS (compat) — not claude commands
    expect(reg.forProject(root, "opencode")).toEqual(["claude-skill", "oc-cmd", "shared"]);
    // no flavor → unfiltered union (machine-page semantics)
    expect(reg.forProject(root)).toEqual(["cc", "claude-skill", "codex-skill", "oc-cmd", "shared"]);
  });
});
