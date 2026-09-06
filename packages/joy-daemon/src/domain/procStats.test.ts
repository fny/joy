// CPU sampling over a process tree: children born (or reaped) during the
// sample must count once, not zero times (#554). Pure arithmetic over two
// /proc snapshots — no live processes involved.
import { describe, it, expect } from "vitest";
import { treeCpuTicks, type TreeSnapshot } from "./procStats";

const proc = (ppid: number, ticks: number, startTicks: number, childTicks = 0) =>
  ({ ppid, ticks, childTicks, rssBytes: 0, startTicks });

describe("treeCpuTicks (#554)", () => {
  it("a child born during the sample contributes its accumulated CPU", () => {
    const a: TreeSnapshot = { uptimeTicks: 1000, procs: new Map([[1, proc(0, 500, 10)]]) };
    const b: TreeSnapshot = { uptimeTicks: 1040, procs: new Map([[1, proc(0, 500, 10)], [2, proc(1, 30, 1010)]]) };
    expect(treeCpuTicks(a, b)).toBe(30);
  });

  it("a process that existed before the sample but joined the tree later is not guessed at", () => {
    const a: TreeSnapshot = { uptimeTicks: 1000, procs: new Map([[1, proc(0, 500, 10)]]) };
    const b: TreeSnapshot = { uptimeTicks: 1040, procs: new Map([[1, proc(0, 502, 10)], [3, proc(1, 900, 200)]]) };
    expect(treeCpuTicks(a, b)).toBe(2);
  });

  it("an exited child's reaped time counts once — only the part inside the window", () => {
    // child 2 had 20 ticks before the sample; it exits inside it with 50 total,
    // which the root's cutime/cstime absorbs. In-window share: 30.
    const a: TreeSnapshot = { uptimeTicks: 1000, procs: new Map([[1, proc(0, 100, 10, 0)], [2, proc(1, 20, 500)]]) };
    const b: TreeSnapshot = { uptimeTicks: 1040, procs: new Map([[1, proc(0, 100, 10, 50)]]) };
    expect(treeCpuTicks(a, b)).toBe(30);
  });

  it("a child that lives across both snapshots is a plain delta", () => {
    const a: TreeSnapshot = { uptimeTicks: 1000, procs: new Map([[1, proc(0, 100, 10)], [2, proc(1, 20, 500)]]) };
    const b: TreeSnapshot = { uptimeTicks: 1040, procs: new Map([[1, proc(0, 104, 10)], [2, proc(1, 60, 500)]]) };
    expect(treeCpuTicks(a, b)).toBe(44);
  });
});

describe("treeCpuTicks — departed subtree accounting (#554 residual)", () => {
  it("an idle child that exits with historic reaped time is not charged as new work", () => {
    // Child 2 had 10 own ticks and 100 ticks of ALREADY-reaped grandchildren
    // at `a`. It exits idle inside the window; the root's cutime/cstime
    // absorbs all 110. Nothing new happened → 0, not 100 (250% of a core).
    const a: TreeSnapshot = { uptimeTicks: 100, procs: new Map([[1, proc(0, 0, 1, 0)], [2, proc(1, 10, 1, 100)]]) };
    const b: TreeSnapshot = { uptimeTicks: 140, procs: new Map([[1, proc(0, 0, 1, 110)]]) };
    expect(treeCpuTicks(a, b)).toBe(0);
  });

  it("a departed child's in-window work still counts once, on top of its historic subtree", () => {
    // Child 2: 10 own + 100 reaped at `a`; burns 25 more and reaps a
    // grandchild's 5 fresh ticks before exiting → root absorbs 140.
    const a: TreeSnapshot = { uptimeTicks: 100, procs: new Map([[1, proc(0, 0, 1, 0)], [2, proc(1, 10, 1, 100)]]) };
    const b: TreeSnapshot = { uptimeTicks: 140, procs: new Map([[1, proc(0, 0, 1, 140)]]) };
    expect(treeCpuTicks(a, b)).toBe(30);
  });

  it("a reused pid is a new process plus an exited one, matched on start time", () => {
    // pid 2 at `a` (started at tick 50, 200 own ticks) exits and is reaped;
    // a NEW pid 2 (started at 120) has burned 7 ticks. In-window: 7 + the
    // reaped delta (200) minus the old process's pre-window 200 = 7.
    const a: TreeSnapshot = { uptimeTicks: 100, procs: new Map([[1, proc(0, 0, 1, 0)], [2, proc(1, 200, 50)]]) };
    const b: TreeSnapshot = { uptimeTicks: 140, procs: new Map([[1, proc(0, 0, 1, 200)], [2, proc(1, 7, 120)]]) };
    expect(treeCpuTicks(a, b)).toBe(7);
  });
});
