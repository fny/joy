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

function linuxTree(root: number): Map<number, { ppid: number; ticks: number; rssBytes: number }> {
  const all = new Map<number, { ppid: number; ticks: number; rssBytes: number }>();
  const pageSize = 4096;
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    let stat: string;
    try { stat = readFileSync(`/proc/${pid}/stat`, "utf8"); } catch { continue; }
    // comm can contain spaces/parens: fields start after the LAST ')'.
    const close = stat.lastIndexOf(")");
    const f = stat.slice(close + 2).split(" ");
    // After ')': state(0) ppid(1) … utime(11) stime(12) … rss(21) — in the
    // post-comm indexing used here.
    const ppid = Number(f[1]);
    const ticks = Number(f[11]) + Number(f[12]);
    const rssBytes = Number(f[21]) * pageSize;
    all.set(pid, { ppid, ticks, rssBytes });
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
  const out = new Map<number, { ppid: number; ticks: number; rssBytes: number }>();
  for (const pid of keep) { const p = all.get(pid); if (p) out.set(pid, p); }
  return out;
}

function clockTicksPerSecond(): number {
  // Linux userland CLK_TCK is 100 on every mainstream distro; getconf is the
  // authority but a subprocess per sample is not worth it.
  return 100;
}

async function linuxStats(root: number): Promise<ProcessTreeStats | null> {
  const a = linuxTree(root);
  if (a.size === 0) return null;
  const t0 = Date.now();
  await new Promise((r) => setTimeout(r, SAMPLE_MS));
  const b = linuxTree(root);
  const t1 = Date.now();
  let dTicks = 0;
  for (const [pid, pb] of b) {
    const pa = a.get(pid);
    if (pa) dTicks += Math.max(0, pb.ticks - pa.ticks);
  }
  const seconds = Math.max(0.001, (t1 - t0) / 1000);
  const cpuPercent = (dTicks / clockTicksPerSecond() / seconds) * 100;
  let rssBytes = 0;
  for (const p of b.values()) rssBytes += p.rssBytes;
  return { cpuPercent: Math.round(cpuPercent * 10) / 10, rssBytes, processCount: b.size, sampledAt: t1 };
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
