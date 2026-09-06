// The quoting family at its sites (#470 #472 #500): each generated artifact is
// fed to the consumer that parses it — /bin/sh for the shell words, a strict
// XML check for the plist — with the characters that broke the old inline
// quoting in the paths.
import { test, expect, describe, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execPath } from "node:process";
import { launchdPlist } from "../launchdPlist";

/** Parse a command line with /bin/sh; return its words. */
function shWords(commandLine: string): string[] {
  const r = spawnSync("/bin/sh", ["-c", `set -- ${commandLine}; for a; do printf '%s\\0' "$a"; done`], { encoding: "utf8" });
  expect(r.status).toBe(0);
  return r.stdout.split("\0").slice(0, -1);
}

// A state dir with every character the old quoting got wrong: a `$`
// expression (#470), an apostrophe (#472), a space and a backtick.
let root: string;
let nastyHome: string;
const savedHome = process.env.JOY_HOME_DIR;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "quote-sites-"));
  nastyHome = join(root, "Jane's joy-$AGY_HOOK_REVIEW_LITERAL `x`");
  mkdirSync(nastyHome, { recursive: true });
  process.env.JOY_HOME_DIR = nastyHome;
});
afterAll(() => {
  if (savedHome === undefined) delete process.env.JOY_HOME_DIR; else process.env.JOY_HOME_DIR = savedHome;
  rmSync(root, { recursive: true, force: true });
});

describe("claude/hooks.ts (#470)", () => {
  test("the hook command parses to exactly [node, hook script] with the paths literal", async () => {
    const { ensureHookSettings } = await import("../claude/hooks");
    const { joyStateDir } = await import("../paths");
    const settingsPath = ensureHookSettings();
    expect(settingsPath).not.toBe("");
    expect(settingsPath.startsWith(nastyHome)).toBe(true);
    const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> };
    const command = settings.hooks.SessionStart[0].hooks[0].command;
    const words = shWords(command);
    expect(words).toEqual([execPath, join(joyStateDir(), "joy-hook.mjs")]);
    expect(words[1]).toContain("$AGY_HOOK_REVIEW_LITERAL"); // not expanded away
  });
});

describe("claude/optionsPrompt.ts (#472)", () => {
  test("the $(cat …) token expands to the prompt through /bin/sh despite an apostrophe in the path", async () => {
    const { optionsPromptArg, OPTIONS_SYSTEM_PROMPT } = await import("../claude/optionsPrompt");
    const dir = join(nastyHome, "state");
    const arg = optionsPromptArg(dir);
    const r = spawnSync("/bin/sh", ["-c", `printf '%s' ${arg}`], { encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).toBe(OPTIONS_SYSTEM_PROMPT);
  });
});

describe("launchdPlist (#500)", () => {
  test("XML metacharacters in PATH and paths are escaped; the document has no bare & or <", () => {
    const plist = launchdPlist({
      label: "vip.faraz.joy-daemon",
      node: "/Users/A&B/.nvm/node",
      serverTs: "/Users/A&B/pkg/<src>/server.ts",
      pkgDir: "/Users/A&B/pkg",
      path: "/Users/A&B/bin:/usr/bin",
      relayUrl: "https://relay.example?x=1&y=2",
      logFile: "/Users/A&B/Library/Logs/it's.log",
    });
    // Every `&` must start an entity; every `<` must open markup.
    for (const m of plist.matchAll(/&/g)) expect(plist.slice(m.index, m.index! + 6)).toMatch(/^&(amp|lt|gt|quot|apos);/);
    expect(plist).not.toMatch(/<string>[^<]*<[^/]/); // no `<` inside a string body
    expect(plist).toContain("<string>/Users/A&amp;B/bin:/usr/bin</string>");
    expect(plist).toContain("<string>/Users/A&amp;B/pkg/&lt;src&gt;/server.ts</string>");
    expect(plist).toContain("<string>https://relay.example?x=1&amp;y=2</string>");
    expect(plist).toContain("<string>/Users/A&amp;B/Library/Logs/it&apos;s.log</string>");
    // Well-formedness smoke check with the only XML parser at hand: balanced
    // <dict>/<array>/<string> tags.
    const count = (tag: string) => (plist.match(new RegExp(`<${tag}>`, "g")) ?? []).length;
    for (const tag of ["dict", "array", "string", "key"]) {
      expect((plist.match(new RegExp(`</${tag}>`, "g")) ?? []).length).toBe(count(tag));
    }
  });
});
