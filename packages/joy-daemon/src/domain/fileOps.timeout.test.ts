// #538 residual (Wave F9) — a timed-out tool run whose group kill did NOT
// confirm termination.
//
// runTool used to do `.then(done, done)` on killProcessGroup, discarding both
// its `false` return (members outlived SIGKILL) and any rejection, and the
// handlers then told the app the tool "was terminated" while a descendant
// could still be running. The result now carries `terminationUnconfirmed`
// and the handlers surface a distinct error for it. The kill helper is
// replaced here with a failing/throwing one — a claim about the result
// contract, not about SIGKILL failing on this host — and every fixture
// kills its own remaining processes afterwards.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("./bounded", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./bounded")>();
  return { ...actual, killProcessGroup: vi.fn(actual.killProcessGroup) };
});

import { killProcessGroup, pidAlive } from "./bounded";
import { handleRipgrep, runTool, TOOL_TIMEOUT_MS } from "./fileOps";

const killGroup = vi.mocked(killProcessGroup);
const FIXTURE = "sh -c 'trap \"\" TERM; exec sleep 30' & echo \"pid=$!\"; wait";

/** The pid runTool handed the kill helper — the tool's process-group leader. */
function leaderPid(): number {
  expect(killGroup).toHaveBeenCalledTimes(1);
  return killGroup.mock.calls[0]![0];
}
/** Kill the fixture's own group and grandchild: the mocked helper left them. */
async function reapFixture(leader: number, ...others: number[]): Promise<void> {
  for (const target of [-leader, leader, ...others]) { try { process.kill(target, "SIGKILL"); } catch { /* gone */ } }
  for (const p of [leader, ...others]) expect(await waitGone(p)).toBe(true);
}
async function waitGone(pid: number, ms = 3_000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (!pidAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return !pidAlive(pid);
}

let dir: string;
beforeEach(() => {
  killGroup.mockReset();
  dir = mkdtempSync(join(tmpdir(), "joy-tool-timeout-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "hit.txt"), "review-needle here\n");
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

describe("runTool keeps the kill helper's verdict (#538 residual)", () => {
  it("reports terminationUnconfirmed when the helper says members survived", async () => {
    killGroup.mockResolvedValueOnce(false);
    const r = await runTool("/bin/sh", ["-c", FIXTURE], dir, undefined, 300);
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).toBe(-1);
    expect(r.terminationUnconfirmed).toBe(true);
    // The claim is honest: the TERM-ignoring grandchild really is still there.
    const grandchild = Number(/pid=(\d+)/.exec(r.stdout)![1]);
    expect(pidAlive(grandchild)).toBe(true);
    await reapFixture(leaderPid(), grandchild);
  }, 20_000);

  it("reports terminationUnconfirmed when the helper throws, and still settles", async () => {
    killGroup.mockRejectedValueOnce(new Error("enumeration exploded"));
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const r = await runTool("/bin/sh", ["-c", FIXTURE], dir, undefined, 300);
      expect(r.timedOut).toBe(true);
      expect(r.terminationUnconfirmed).toBe(true);
      expect(stderr.mock.calls.map((c) => String(c[0])).join("")).toMatch(/kill failed \(enumeration exploded\) — termination unconfirmed/);
      const grandchild = Number(/pid=(\d+)/.exec(r.stdout)![1]);
      await reapFixture(leaderPid(), grandchild);
    } finally {
      stderr.mockRestore();
    }
  }, 20_000);

  it("a confirmed kill is a plain timeout: timedOut without the flag", async () => {
    // The real helper: SIGTERM ends `sleep`, so the group is confirmed gone.
    const r = await runTool("/bin/sh", ["-c", "sleep 30"], dir, undefined, 300);
    expect(r.timedOut).toBe(true);
    expect(r.terminationUnconfirmed).toBe(false);
    expect(await waitGone(leaderPid())).toBe(true);
  }, 20_000);

  it("a run that finishes in time carries neither", async () => {
    const r = await runTool("/bin/sh", ["-c", "echo ok"], dir, undefined, 10_000);
    expect(r).toMatchObject({ timedOut: false, terminationUnconfirmed: false, exitCode: 0, stdout: "ok\n" });
    expect(killGroup).not.toHaveBeenCalled();
  }, 20_000);
});

describe("handleRipgrep surfaces an unconfirmed termination (#538 residual)", () => {
  // The handler's deadline is the production TOOL_TIMEOUT_MS: fake only
  // setTimeout so it can be fired at once, before the real rg child closes
  // (the deadline is armed synchronously inside the call).
  it("says the descendants may still be running instead of 'was terminated'", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    killGroup.mockResolvedValueOnce(false);
    const pending = handleRipgrep(dir, { args: ["review-needle"] } as never);
    vi.advanceTimersByTime(TOOL_TIMEOUT_MS);
    const r = await pending;
    vi.useRealTimers();
    expect(r.success).toBe(false);
    expect(r.error).toBe(`ripgrep exceeded ${TOOL_TIMEOUT_MS / 1000}s; termination unconfirmed — descendants may still be running`);
    await reapFixture(leaderPid());
  }, 20_000);

  it("keeps the plain 'was terminated' error when the kill is confirmed", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    killGroup.mockResolvedValueOnce(true);
    const pending = handleRipgrep(dir, { args: ["review-needle"] } as never);
    vi.advanceTimersByTime(TOOL_TIMEOUT_MS);
    const r = await pending;
    vi.useRealTimers();
    expect(r.success).toBe(false);
    expect(r.error).toBe(`ripgrep exceeded ${TOOL_TIMEOUT_MS / 1000}s and was terminated`);
    await reapFixture(leaderPid());
  }, 20_000);
});
