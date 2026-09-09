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
export interface TreeSnapshot {
  procs: Map<number, ProcSample>;
  uptimeTicks: number;
  /** EVERY process on the host at that instant (the tree included) — the
   *  observation that tells a descendant which left the tree but is still
   *  alive (reparented) from one that exited and was reaped. Optional for
   *  hand-built snapshots. */
  all?: Map<number, ProcSample>;
}

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
  return { procs, uptimeTicks: uptime, all };
}

/**
 * Clock ticks the tree consumed between snapshots `a` and `b`. Pairing pids
 * present in both was the whole story before, so a tool child that started
 * AND did its work inside the 400 ms window contributed nothing — a tree
 * burning most of a core read 0% (#554). Now:
 *  - a pid in both WITH the same start time: its own delta plus the delta of
 *    children it reaped. A different start time is a REUSED pid — a new
 *    process that happens to wear a departed one's number — and is treated
 *    as one new process plus one exited process;
 *  - a pid only in `b` that STARTED after `a` was taken: everything it has
 *    (all of it happened inside the window); a pre-existing process that
 *    merely joined the tree (reparented) is skipped — its split is unknown;
 *  - a pid only in `a` (departed): once reaped, its ancestor's cutime/cstime
 *    grows by the departed process's OWN ticks plus everything IT had already
 *    reaped (Linux folds the child's cutime/cstime in too). Both are
 *    cumulative since that process started, so its pre-window subtree
 *    accounting (own ticks + childTicks at `a`) is taken back out of the
 *    reaped delta of the SURVIVING ancestor that absorbed it — never below
 *    zero, per ancestor. Subtracting only the own ticks charged a departed
 *    child's historic reaped time as fresh work (an idle child with 100 old
 *    ticks read as 250% of a core); subtracting EVERY departed pid from one
 *    undifferentiated total assumed each was reaped into this tree, and a
 *    grandchild that outlived its parent — reparented outside the tree,
 *    still running — erased the real work of a sibling (#554 regression).
 *    A departed pid still alive in the host-wide table (`b.all`) was not
 *    reaped by anyone here and subtracts nothing. Without that table, a
 *    departed pid whose parent departed too cannot be placed (reaped by
 *    that parent before it died, or orphaned) and is treated as not reaped.
 */
export function treeCpuTicks(a: TreeSnapshot, b: TreeSnapshot): number {
  let total = 0;
  const sameProcess = (pa: ProcSample, pb: ProcSample) => pa.startTicks === pb.startTicks;
  // Survivors: own delta now; reaped delta once the departed are attributed.
  const reapedDelta = new Map<number, number>();
  for (const [pid, pb] of b.procs) {
    const pa = a.procs.get(pid);
    if (pa && sameProcess(pa, pb)) {
      total += Math.max(0, pb.ticks - pa.ticks);
      reapedDelta.set(pid, Math.max(0, pb.childTicks - pa.childTicks));
    } else if (pb.startTicks >= a.uptimeTicks) {
      total += pb.ticks + pb.childTicks;
    }
  }
  // Departed: charge each one's pre-window subtree accounting to the nearest
  // surviving ancestor — the process whose cutime/cstime absorbed it.
  const baseline = new Map<number, number>();
  for (const [pid, pa] of a.procs) {
    if (reapedDelta.has(pid)) continue;
    const elsewhere = b.all?.get(pid);
    if (elsewhere && sameProcess(pa, elsewhere)) continue; // alive, reparented out: not reaped
    let anc = pa.ppid;
    if (!b.all && !reapedDelta.has(anc)) continue;         // no liveness data: cannot be placed
    for (let hops = 0; !reapedDelta.has(anc); hops++) {
      const p = a.procs.get(anc);
      if (!p || hops > a.procs.size) { anc = -1; break; }
      anc = p.ppid;
    }
    if (anc < 0) continue;                                 // reaped outside the tree
    baseline.set(anc, (baseline.get(anc) ?? 0) + pa.ticks + pa.childTicks);
  }
  for (const [pid, delta] of reapedDelta) total += Math.max(0, delta - (baseline.get(pid) ?? 0));
  return total;
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


// ── Per-process listing (the session's Processes page) ─────────────────────
//
// The aggregate above answers "how much is this session burning". The list
// answers "which of its processes" — every descendant of the agent with its
// own CPU right now, resident memory, age and command line, in tree order so
// a subagent's tool shell sits under the subagent.

export interface ProcessRow {
  pid: number;
  ppid: number;
  /** Distance from the root: 0 for the agent, 1 for its direct children… */
  depth: number;
  /** Executable name (comm). */
  name: string;
  /** Full command line where readable; else the name. */
  args: string;
  /** Percent of one core, this process alone, over the sample window. */
  cpuPercent: number;
  rssBytes: number;
  /** Seconds since the process started. */
  elapsedSeconds: number | null;
}

export interface ProcessTreeList {
  root: number;
  sampledAt: number;
  totals: { cpuPercent: number; rssBytes: number; processCount: number };
  processes: ProcessRow[];
}

/** DFS from `root` over a parent map: pids in tree order with their depth. */
export function treeOrder(ppidOf: Map<number, number>, root: number): Array<{ pid: number; depth: number }> {
  const children = new Map<number, number[]>();
  for (const [pid, ppid] of ppidOf) {
    if (pid === root) continue;
    const list = children.get(ppid) ?? [];
    list.push(pid); children.set(ppid, list);
  }
  const out: Array<{ pid: number; depth: number }> = [];
  const seen = new Set<number>();
  const walk = (pid: number, depth: number) => {
    if (seen.has(pid)) return;
    seen.add(pid);
    out.push({ pid, depth });
    for (const c of (children.get(pid) ?? []).sort((x, y) => x - y)) walk(c, depth + 1);
  };
  if (ppidOf.has(root)) walk(root, 0);
  return out;
}

/** Each surviving pid's own CPU over the window, percent of one core. A pid
 *  born inside the window gets everything it has; a reused pid (same number,
 *  different start) is the new process. */
export function perProcessCpu(a: TreeSnapshot, b: TreeSnapshot, seconds: number, ticksPerSecond: number): Map<number, number> {
  const out = new Map<number, number>();
  const denom = Math.max(0.001, seconds) * ticksPerSecond;
  for (const [pid, pb] of b.procs) {
    const pa = a.procs.get(pid);
    let d: number;
    if (pa && pa.startTicks === pb.startTicks) d = Math.max(0, pb.ticks - pa.ticks);
    else if (pb.startTicks >= a.uptimeTicks) d = pb.ticks;
    else d = 0; // joined the tree mid-window: its split is unknown
    out.set(pid, Math.round((d / denom) * 1000) / 10);
  }
  return out;
}

/** `[[dd-]hh:]mm:ss` from ps etime → seconds. */
export function parseEtime(s: string): number | null {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(s.trim());
  if (!m) return null;
  const [, d, h, mi, se] = m;
  return (Number(d ?? 0) * 86_400) + (Number(h ?? 0) * 3600) + Number(mi) * 60 + Number(se);
}

function readProcName(pid: number): { name: string; args: string } {
  let name = "";
  try { name = readFileSync(`/proc/${pid}/comm`, "utf8").trim(); } catch { /* gone */ }
  let args = "";
  try { args = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean).join(" "); } catch { /* gone or kernel thread */ }
  return { name: name || args.split(" ")[0] || String(pid), args: args || name };
}

async function linuxList(root: number): Promise<ProcessTreeList | null> {
  const a = linuxTree(root);
  if (a.procs.size === 0) return null;
  const t0 = Date.now();
  await new Promise((r) => setTimeout(r, SAMPLE_MS));
  const b = linuxTree(root);
  const t1 = Date.now();
  if (b.procs.size === 0) return null;
  const cpu = perProcessCpu(a, b, (t1 - t0) / 1000, clockTicksPerSecond());
  const ppidOf = new Map<number, number>();
  for (const [pid, p] of b.procs) ppidOf.set(pid, p.ppid);
  const processes: ProcessRow[] = treeOrder(ppidOf, root).map(({ pid, depth }) => {
    const p = b.procs.get(pid)!;
    const { name, args } = readProcName(pid);
    return {
      pid, ppid: p.ppid, depth, name, args,
      cpuPercent: cpu.get(pid) ?? 0, rssBytes: p.rssBytes,
      elapsedSeconds: Math.max(0, Math.round((b.uptimeTicks - p.startTicks) / clockTicksPerSecond())),
    };
  });
  return {
    root, sampledAt: t1,
    totals: { cpuPercent: Math.round(processes.reduce((n, r) => n + r.cpuPercent, 0) * 10) / 10, rssBytes: processes.reduce((n, r) => n + r.rssBytes, 0), processCount: processes.length },
    processes,
  };
}

function psList(root: number): Promise<ProcessTreeList | null> {
  return new Promise((resolve) => {
    // args last: it is the one column with spaces in it.
    execFile("ps", ["-Ao", "pid=,ppid=,%cpu=,rss=,etime=,comm=,args="], { timeout: 4000, maxBuffer: 8 << 20 }, (err, stdout) => {
      if (err) { resolve(null); return; }
      const rows = new Map<number, { ppid: number; cpu: number; rssKb: number; etime: string; comm: string; args: string }>();
      for (const line of stdout.split("\n")) {
        const m = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(\S+)\s*(.*)$/.exec(line);
        if (!m) continue;
        rows.set(Number(m[1]), { ppid: Number(m[2]), cpu: Number(m[3]), rssKb: Number(m[4]), etime: m[5], comm: m[6].split("/").pop() ?? m[6], args: m[7] || m[6] });
      }
      if (!rows.has(root)) { resolve(null); return; }
      const keep = new Set<number>([root]);
      let grew = true;
      while (grew) { grew = false; for (const [pid, p] of rows) if (!keep.has(pid) && keep.has(p.ppid)) { keep.add(pid); grew = true; } }
      const ppidOf = new Map<number, number>();
      for (const pid of keep) ppidOf.set(pid, rows.get(pid)!.ppid);
      const processes: ProcessRow[] = treeOrder(ppidOf, root).map(({ pid, depth }) => {
        const p = rows.get(pid)!;
        return { pid, ppid: p.ppid, depth, name: p.comm, args: p.args, cpuPercent: Math.round(p.cpu * 10) / 10, rssBytes: p.rssKb * 1024, elapsedSeconds: parseEtime(p.etime) };
      });
      resolve({
        root, sampledAt: Date.now(),
        totals: { cpuPercent: Math.round(processes.reduce((n, r) => n + r.cpuPercent, 0) * 10) / 10, rssBytes: processes.reduce((n, r) => n + r.rssBytes, 0), processCount: processes.length },
        processes,
      });
    });
  });
}

/** Every process under `root`, in tree order, or null when the pid is gone. */
export async function processTreeList(root: number | undefined): Promise<ProcessTreeList | null> {
  if (!root || !Number.isFinite(root)) return null;
  try { return platform() === "linux" ? await linuxList(root) : await psList(root); } catch { return null; }
}
