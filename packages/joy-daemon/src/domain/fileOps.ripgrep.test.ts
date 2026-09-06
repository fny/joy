// #538 — a ripgrep search with no path operand.
//
// rg searches STDIN, not the tree, when it is given no path and stdin is not
// a tty; runTool always hands it a pipe. `rg review-needle` therefore hung on
// that unused pipe with a live child, and once stdin was closed it answered
// "no matches" while never opening a single project file. The handler now
// supplies the cwd as an explicit operand, and every jailed tool run has a
// deadline so a wedged child cannot hold the request forever.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleRipgrep, jailToolArgs, runTool } from "./fileOps";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "joy-rg-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "hit.txt"), "before\nreview-needle here\nafter\n");
  writeFileSync(join(dir, "src", "miss.txt"), "nothing to see\n");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("handleRipgrep with no path operand (#538)", () => {
  it("searches the working directory instead of waiting on stdin", async () => {
    const r = await handleRipgrep(dir, { args: ["review-needle"] } as never);
    expect(r.success).toBe(true);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("review-needle here");
    expect(r.stdout).toContain("hit.txt");
  }, 20_000);

  it("still reports a real no-match as exit 1, not as a hang", async () => {
    const r = await handleRipgrep(dir, { args: ["definitely-not-present"] } as never);
    expect(r.success).toBe(true);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toBe("");
  }, 20_000);

  it("leaves an explicit path operand alone", async () => {
    const r = await handleRipgrep(dir, { args: ["review-needle", "src"] } as never);
    expect(r.success).toBe(true);
    expect(r.stdout?.startsWith("src/")).toBe(true); // no injected "./"
  }, 20_000);

  it("works with the pattern supplied by -e (every positional is then a path)", async () => {
    const r = await handleRipgrep(dir, { args: ["-e", "review-needle"] } as never);
    expect(r.success).toBe(true);
    expect(r.stdout).toContain("review-needle here");
  }, 20_000);

  it("--files lists the tree and needs no injected operand", async () => {
    const r = await handleRipgrep(dir, { args: ["--files"] } as never);
    expect(r.success).toBe(true);
    expect(r.stdout).toContain("hit.txt");
  }, 20_000);

  it("reports which positionals are path operands", () => {
    const bare = jailToolArgs("rg", ["needle"], dir);
    expect(bare.ok && bare.pathOperands).toEqual([]);
    const withPath = jailToolArgs("rg", ["needle", "src"], dir);
    expect(withPath.ok && withPath.pathOperands).toEqual(["src"]);
  });
});

describe("jailed tool runs are bounded (#538)", () => {
  it("terminates a child that never exits and says so", async () => {
    const r = await runTool("/bin/sh", ["-c", "sleep 30"], dir, undefined, 300);
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).not.toBe(0);
  }, 20_000);

  it("does not flag a run that finished in time", async () => {
    const r = await runTool("/bin/sh", ["-c", "echo ok"], dir, undefined, 10_000);
    expect(r.timedOut).toBe(false);
    expect(r.stdout).toBe("ok\n");
  }, 20_000);
});
