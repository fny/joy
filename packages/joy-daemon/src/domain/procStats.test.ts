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
