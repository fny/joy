// CPU and memory for a session: the agent process and everything under it
// (tool shells, dev servers, test runners, subagents). Rooted at the agent's
// pid — the tmux pane shell above it is idle and not worth counting.
//
// Linux reads /proc directly and SAMPLES: /proc/<pid>/stat utime+stime twice,
// a short interval apart, so the number is "CPU right now", not `ps`'s
// lifetime average (meaningless for a claude that has been up for hours).
// macOS has no /proc; `ps` there reports a recent-window average, which is
// close enough, so one call does it.
import { readdirSync, readFileSync } from "fs";
import { execFile } from "child_process";
import { platform } from "os";
import { execFileSync } from "child_process";

// Read once: /proc reports RSS in pages and CPU in clock ticks, and neither is
// universally 4096 / 100 (64 KiB pages exist; so do non-100 Hz kernels).
let pageSizeCache = 0; let clkTckCache = 0;
function sysconf(name: "PAGESIZE" | "CLK_TCK", fallback: number): number {
  try { const n = Number(execFileSync("getconf", [name], { timeout: 2000 }).toString().trim()); return Number.isFinite(n) && n > 0 ? n : fallback; } catch { return fallback; }
}

export interface ProcessTreeStats {
  /** Percent of ONE core, summed over the tree (200 = two cores busy). */
  cpuPercent: number;
  /** Resident set, bytes, summed over the tree. */
  rssBytes: number;
  /** Processes in the tree, root included. */
  processCount: number;
  sampledAt: number;
}

const SAMPLE_MS = 400;

/** One process as read from /proc/<pid>/stat. Ticks are clock ticks. */
export interface ProcSample {
  ppid: number;
  /** utime + stime: CPU this process consumed itself. */
  ticks: number;
  /** cutime + cstime: CPU of children it has already waited for (reaped). */
  childTicks: number;
  rssBytes: number;
  /** starttime: clock ticks after boot when the process started. */
  startTicks: number;
}
/** The tree at one instant plus the boot-relative clock at that instant. */
export interface TreeSnapshot { procs: Map<number, ProcSample>; uptimeTicks: number }

function clockTicksPerSecond(): number {
  return clkTckCache || (clkTckCache = sysconf("CLK_TCK", 100));
}

function uptimeTicks(): number {
  try {
    const secs = Number(readFileSync("/proc/uptime", "utf8").split(" ")[0]);
    return Number.isFinite(secs) ? secs * clockTicksPerSecond() : 0;
  } catch { return 0; }
}

function linuxTree(root: number): TreeSnapshot {
  const all = new Map<number, ProcSample>();
  const pageSize = pageSizeCache || (pageSizeCache = sysconf("PAGESIZE", 4096));
  const uptime = uptimeTicks();
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    let stat: string;
    try { stat = readFileSync(`/proc/${pid}/stat`, "utf8"); } catch { continue; }
    // comm can contain spaces/parens: fields start after the LAST ')'.
    const close = stat.lastIndexOf(")");
    const f = stat.slice(close + 2).split(" ");
    // After ')': state(0) ppid(1) … utime(11) stime(12) cutime(13) cstime(14)
    // … starttime(19) … rss(21) — in the post-comm indexing used here.
    const ppid = Number(f[1]);
    const ticks = Number(f[11]) + Number(f[12]);
    const childTicks = Number(f[13]) + Number(f[14]);
    const startTicks = Number(f[19]);
    const rssBytes = Number(f[21]) * pageSize;
    all.set(pid, { ppid, ticks, childTicks, rssBytes, startTicks });
  }
  // Keep only root + descendants.
  const keep = new Set<number>([root]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [pid, p] of all) {
      if (!keep.has(pid) && keep.has(p.ppid)) { keep.add(pid); grew = true; }
    }
  }
  const procs = new Map<number, ProcSample>();
  for (const pid of keep) { const p = all.get(pid); if (p) procs.set(pid, p); }
  return { procs, uptimeTicks: uptime };
}

/**
 * Clock ticks the tree consumed between snapshots `a` and `b`. Pairing pids
 * present in both was the whole story before, so a tool child that started
 * AND did its work inside the 400 ms window contributed nothing — a tree
 * burning most of a core read 0% (#554). Now:
 *  - a pid in both: its own delta plus the delta of children it reaped;
 *  - a pid only in `b` that STARTED after `a` was taken: everything it has
 *    (all of it happened inside the window); a pre-existing process that
 *    merely joined the tree (reparented) is skipped — its split is unknown;
 *  - a pid only in `a` (exited): its post-`a` CPU reaches an ancestor's
 *    cutime/cstime once reaped and is counted there, so its PRE-window ticks
 *    (what it had at `a`) are taken back out — once, never below zero.
 */
export function treeCpuTicks(a: TreeSnapshot, b: TreeSnapshot): number {
  let own = 0;
  let reaped = 0;
  for (const [pid, pb] of b.procs) {
    const pa = a.procs.get(pid);
    if (pa) {
      own += Math.max(0, pb.ticks - pa.ticks);
      reaped += Math.max(0, pb.childTicks - pa.childTicks);
    } else if (pb.startTicks >= a.uptimeTicks) {
      own += pb.ticks;
      reaped += pb.childTicks;
    }
  }
  let preWindow = 0;
  for (const [pid, pa] of a.procs) if (!b.procs.has(pid)) preWindow += pa.ticks;
  return own + Math.max(0, reaped - preWindow);
}

async function linuxStats(root: number): Promise<ProcessTreeStats | null> {
  const a = linuxTree(root);
  if (a.procs.size === 0) return null;
  const t0 = Date.now();
  await new Promise((r) => setTimeout(r, SAMPLE_MS));
  const b = linuxTree(root);
  const t1 = Date.now();
  const dTicks = treeCpuTicks(a, b);
  const seconds = Math.max(0.001, (t1 - t0) / 1000);
  const cpuPercent = (dTicks / clockTicksPerSecond() / seconds) * 100;
  let rssBytes = 0;
  for (const p of b.procs.values()) rssBytes += p.rssBytes;
  return { cpuPercent: Math.round(cpuPercent * 10) / 10, rssBytes, processCount: b.procs.size, sampledAt: t1 };
}

function psStats(root: number): Promise<ProcessTreeStats | null> {
  return new Promise((resolve) => {
    execFile("ps", ["-Ao", "pid=,ppid=,%cpu=,rss="], { timeout: 4000 }, (err, stdout) => {
      if (err) { resolve(null); return; }
      const rows = new Map<number, { ppid: number; cpu: number; rssKb: number }>();
      for (const line of stdout.split("\n")) {
        const m = line.trim().split(/\s+/);
        if (m.length < 4) continue;
        rows.set(Number(m[0]), { ppid: Number(m[1]), cpu: Number(m[2]), rssKb: Number(m[3]) });
      }
      if (!rows.has(root)) { resolve(null); return; }
      const keep = new Set<number>([root]);
      let grew = true;
      while (grew) {
        grew = false;
        for (const [pid, p] of rows) if (!keep.has(pid) && keep.has(p.ppid)) { keep.add(pid); grew = true; }
      }
      let cpu = 0, rss = 0;
      for (const pid of keep) { const p = rows.get(pid)!; cpu += p.cpu; rss += p.rssKb * 1024; }
      resolve({ cpuPercent: Math.round(cpu * 10) / 10, rssBytes: rss, processCount: keep.size, sampledAt: Date.now() });
    });
  });
}

/** Stats for `root` and its descendants, or null when the pid is gone. */
export async function processTreeStats(root: number | undefined): Promise<ProcessTreeStats | null> {
  if (!root || !Number.isFinite(root)) return null;
  try {
    return platform() === "linux" ? await linuxStats(root) : await psStats(root);
  } catch {
    return null;
  }
}
