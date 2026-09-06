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

  it("a grandchild orphaned outside the tree is live, not reaped: its history does not erase real work (#554 regression)", () => {
    // At `a`, child 2 has 100 historical reaped ticks and a still-running
    // grandchild 3 with 100 own ticks. Child 2 exits and root reaps its
    // 100; grandchild 3 outlives it and is reparented outside the tree,
    // alive; another short-lived child burns and is reaped for 30. Root's
    // childTicks rises by 130 — the in-window work is 30, not 0.
    const a: TreeSnapshot = { uptimeTicks: 100, procs: new Map([[1, proc(0, 0, 1, 0)], [2, proc(1, 0, 1, 100)], [3, proc(2, 100, 1)]]) };
    const b: TreeSnapshot = { uptimeTicks: 140, procs: new Map([[1, proc(0, 0, 1, 130)]]) };
    expect(treeCpuTicks(a, b)).toBe(30); // no host-wide table: the orphan cannot have been reaped by a survivor
    const alive: TreeSnapshot = { ...b, all: new Map([[1, proc(0, 0, 1, 130)], [3, proc(0, 120, 1)]]) };
    expect(treeCpuTicks(a, alive)).toBe(30); // host-wide table: pid 3 is still alive elsewhere
  });

  it("a grandchild that its departing parent reaped first flows through to the surviving ancestor", () => {
    // Same start, but grandchild 3 finished and was reaped by child 2
    // before 2 exited: root absorbs 2's own + 2's reaped (100 + 3's 100)
    // + the fresh 30. Both pre-window baselines come out: 30.
    const a: TreeSnapshot = { uptimeTicks: 100, procs: new Map([[1, proc(0, 0, 1, 0)], [2, proc(1, 0, 1, 100)], [3, proc(2, 100, 1)]]) };
    const b: TreeSnapshot = { uptimeTicks: 140, procs: new Map([[1, proc(0, 0, 1, 230)]]), all: new Map([[1, proc(0, 0, 1, 230)]]) };
    expect(treeCpuTicks(a, b)).toBe(30);
  });

  it("a departed child's baseline is charged to its own reaper, not to a sibling's fresh reaped work", () => {
    // Two surviving children: X reaps a departed grandchild whose history
    // (100) it never fully absorbs in the window (its delta is 60); Y reaps
    // a grandchild born and finished inside the window (30). One global
    // subtraction read 60 + 30 - 100 = 0; per ancestor it is 0 + 30.
    const a: TreeSnapshot = { uptimeTicks: 100, procs: new Map([[1, proc(0, 0, 1)], [10, proc(1, 0, 1, 0)], [11, proc(10, 100, 1)], [20, proc(1, 0, 1, 0)]]) };
    const b: TreeSnapshot = { uptimeTicks: 140, procs: new Map([[1, proc(0, 0, 1)], [10, proc(1, 0, 1, 60)], [20, proc(1, 0, 1, 30)]]) };
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
