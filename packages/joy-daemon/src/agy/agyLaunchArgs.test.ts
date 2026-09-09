import { describe, expect, it } from "vitest";
import { agyLaunchArgs } from "./agySession";

const base = ["--print", "", "--input-format", "stream-json", "--output-format", "stream-json", "--dangerously-skip-permissions", "--add-dir", "/w", "--print-timeout", "30m"];

describe("agyLaunchArgs", () => {
  it("the fixed print-mode argv, then conversation, model", () => {
    expect(agyLaunchArgs({ cwd: "/w", printTimeout: "30m", conversationId: "c1", model: "Gemini 3.1 Pro (High)" })).toEqual([...base, "--conversation", "c1", "--model", "Gemini 3.1 Pro (High)"]);
    expect(agyLaunchArgs({ cwd: "/w", printTimeout: "30m", continueLast: true })).toEqual([...base, "--continue"]);
  });
  it("effort and mode map to --effort / --mode; bypass adds nothing; approvals stay skipped", () => {
    expect(agyLaunchArgs({ cwd: "/w", printTimeout: "30m", effort: "high", permissionMode: "plan" })).toEqual([...base, "--effort", "high", "--mode", "plan"]);
    expect(agyLaunchArgs({ cwd: "/w", printTimeout: "30m", permissionMode: "acceptEdits" })).toEqual([...base, "--mode", "accept-edits"]);
    expect(agyLaunchArgs({ cwd: "/w", printTimeout: "30m", permissionMode: "bypassPermissions" })).toEqual(base);
  });
  it("extra args are shell-split and appended", () => {
    expect(agyLaunchArgs({ cwd: "/w", printTimeout: "30m", extraArgs: '--sandbox --project "my proj"' })).toEqual([...base, "--sandbox", "--project", "my proj"]);
  });
});
