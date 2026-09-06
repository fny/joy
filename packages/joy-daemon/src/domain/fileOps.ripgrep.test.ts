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
import { pidAlive } from "./bounded";

/** kill -0: is `pid` still there (a reaped process is not)? Polls briefly
 *  because init reaps a re-parented grandchild a moment after SIGKILL. */
async function waitGone(pid: number, ms = 3_000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (!pidAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return !pidAlive(pid);
}
/** Live libuv handles of the kinds a tool run creates. */
function toolHandles(): number {
  return process.getActiveResourcesInfo().filter((k) => k === "PipeWrap" || k === "ProcessWrap").length;
}
/** The handle count once it has stopped changing (an earlier test's pipes
 *  can still be closing), so a before/after comparison is meaningful. */
async function quiescentHandles(): Promise<number> {
  let last = toolHandles();
  for (let stable = 0; stable < 5;) {
    await new Promise((r) => setTimeout(r, 40));
    const now = toolHandles();
    if (now === last) stable++; else { stable = 0; last = now; }
  }
  return last;
}

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

  it("a pattern that merely looks like --files is still a search (-e --files)", async () => {
    // The mode is decided by the option parser: `--files` here is the VALUE
    // of -e, so the run is a search and gets the default operand — it used
    // to be read off the raw argv, so no `.` was appended and rg answered
    // "no matches" from its closed stdin (#538 residual).
    writeFileSync(join(dir, "src", "flag.txt"), "use --files to list\n");
    const jailed = jailToolArgs("rg", ["-e", "--files"], dir);
    expect(jailed.ok && jailed.mode).toBe("search");
    const inline = jailToolArgs("rg", ["--regexp=--files"], dir);
    expect(inline.ok && inline.mode).toBe("search");
    const r = await handleRipgrep(dir, { args: ["-e", "--files"] } as never);
    expect(r.success).toBe(true);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("flag.txt");
    expect(r.stdout).toContain("use --files to list");
    // And a real --files stays a listing (no operand injected, no pattern).
    const list = jailToolArgs("rg", ["--files"], dir);
    expect(list.ok && list.mode).toBe("list");
    const clustered = jailToolArgs("rg", ["-ie", "--files"], dir);
    expect(clustered.ok && clustered.mode).toBe("search");
  }, 20_000);
});

describe("jailed tool runs are bounded (#538)", () => {
  it("terminates a child that never exits and says so", async () => {
    const r = await runTool("/bin/sh", ["-c", "sleep 30"], dir, undefined, 300);
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).not.toBe(0);
  }, 20_000);

  it("terminates the whole process group, grandchild included, before settling", async () => {
    // A shell whose background grandchild ignores SIGTERM and keeps the
    // pipes open. Signalling only the direct child left that grandchild
    // alive and writing after `timedOut` (#538 residual); the group kill
    // must escalate to SIGKILL and the result must not arrive until the
    // descendant is gone — with no pipe or process handle left behind.
    const before = await quiescentHandles();
    const started = Date.now();
    // The grandchild ignores TERM (the disposition survives exec) and holds
    // the inherited pipes without writing, so only SIGKILL ends it — a
    // write would die of SIGPIPE once the pipes are destroyed and prove less.
    const r = await runTool(
      "/bin/sh",
      ["-c", "sh -c 'trap \"\" TERM; exec sleep 30' & echo \"pid=$!\"; wait"],
      dir, undefined, 300,
    );
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).toBe(-1);
    // Settled only after the grace period ran out and SIGKILL was sent.
    expect(Date.now() - started).toBeGreaterThanOrEqual(2_300);
    const m = /pid=(\d+)/.exec(r.stdout);
    expect(m, r.stdout).not.toBeNull();
    const grandchild = Number(m![1]);
    // kill -0 on the grandchild: gone when the promise settled (the short
    // poll only covers init reaping the already-killed, re-parented process).
    expect(await waitGone(grandchild, 500)).toBe(true);
    // Nothing retained: the destroyed pipes and the process handle close on
    // the next turns of the loop.
    const settledBy = Date.now() + 2_000;
    while (toolHandles() > before && Date.now() < settledBy) await new Promise((res) => setTimeout(res, 20));
    expect(toolHandles()).toBe(before);
  }, 20_000);

  it("does not flag a run that finished in time", async () => {
    const r = await runTool("/bin/sh", ["-c", "echo ok"], dir, undefined, 10_000);
    expect(r.timedOut).toBe(false);
    expect(r.stdout).toBe("ok\n");
  }, 20_000);
});
