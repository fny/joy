// Threshold alerting — the daemon-side half of the "live activity" plan (the
// ActivityKit widget needs a native iOS build; these pushes ship the alert
// value now and will feed the activity later). Priority order per the spec:
// RAM high, disk high, claude limit ≥90%, codex limit ≥90%.
//
// Semantics: edge-triggered with hysteresis (fires crossing 90%, re-arms
// after dropping under 85%) AND rate-limited to one push per alert per 4h —
// a box that sits pinned at 95% doesn't spam every sample.

import { readFileSync, statfsSync } from "fs";
import { freemem, totalmem, platform, hostname } from "os";
import { execSync } from "child_process";
import { homedir } from "os";
import { fetchClaudeLimits, readCodexLimits } from "./limits";

const HOT = 90;
const REARM = 85;
const PUSH_COOLDOWN_MS = 4 * 60 * 60 * 1000;   // spec: refresh/alert cadence 4h
const HOST_CHECK_MS = 5 * 60 * 1000;           // ram/disk sampled locally, cheap
const LIMITS_CHECK_MS = 4 * 60 * 60 * 1000;    // claude endpoint is rate-limited

interface Pusher { sendPush(title: string, body: string): Promise<{ sent: number }> }

/** Reclaimable-aware RAM used-% (same reasoning as relay.ts availableMemBytes:
 *  freemem() ignores cache/buffers and reads ~99% on healthy boxes). */
function ramUsedPercent(): number | null {
  let avail = freemem();
  try {
    if (platform() === "linux") {
      const m = /MemAvailable:\s+(\d+)\s+kB/.exec(readFileSync("/proc/meminfo", "utf8"));
      if (m) avail = Number(m[1]) * 1024;
    } else if (platform() === "darwin") {
      const out = execSync("vm_stat", { encoding: "utf8", timeout: 2000 });
      const pageSize = Number(/page size of (\d+) bytes/.exec(out)?.[1] ?? 4096);
      const pages = (label: string) => Number(new RegExp(label + ":\\s+(\\d+)\\.").exec(out)?.[1] ?? 0);
      const used = (pages("Pages active") + pages("Pages wired down") + pages("Pages occupied by compressor")) * pageSize;
      if (used > 0) avail = Math.max(0, totalmem() - used);
    }
  } catch { /* freemem fallback */ }
  const total = totalmem();
  if (!total) return null;
  return Math.round((1 - avail / total) * 100);
}

function diskUsedPercent(): number | null {
  try {
    const s = statfsSync(homedir());
    const total = Number(s.blocks) * Number(s.bsize);
    const free = Number(s.bavail) * Number(s.bsize);
    if (!total) return null;
    return Math.round((1 - free / total) * 100);
  } catch {
    return null;
  }
}

export function startResourceAlerts(pusher: Pusher): void {
  const armed: Record<string, boolean> = {};   // true = can fire (under threshold since last alert)
  const lastPush: Record<string, number> = {};
  const host = hostname();

  const fire = (key: string, percent: number | null, title: string, body: string) => {
    if (percent == null) return;
    if (percent < REARM) { armed[key] = true; return; }
    if (percent < HOT) return;
    const now = Date.now();
    if (armed[key] === false && now - (lastPush[key] ?? 0) < PUSH_COOLDOWN_MS) return;
    armed[key] = false;
    lastPush[key] = now;
    void pusher.sendPush(title, body).catch(() => { /* best-effort */ });
  };

  const hostCheck = () => {
    fire("ram", ramUsedPercent(), `RAM high on ${host}`, `${ramUsedPercent()}% used — sessions may queue or misbehave`);
    fire("disk", diskUsedPercent(), `Disk high on ${host}`, `${diskUsedPercent()}% full — transcripts and caches may start failing`);
  };

  const limitsCheck = async () => {
    const claude = await fetchClaudeLimits().catch(() => null);
    if (claude?.ok) {
      const buckets: Array<[string, { utilization: number; resets_at: string } | null | undefined]> = [
        ["5-hour", claude.limits.five_hour],
        ["weekly", claude.limits.seven_day],
      ];
      for (const [name, b] of buckets) {
        if (b?.utilization != null) {
          fire(`claude-${name}`, b.utilization, `Claude ${name} limit at ${Math.round(b.utilization)}%`,
            `resets ${b.resets_at ? new Date(b.resets_at).toLocaleTimeString() : "soon"} (${host})`);
        }
      }
    }
    const codex = readCodexLimits();
    if (codex.ok) {
      for (const [name, w] of [["primary", codex.limits.primary], ["secondary", codex.limits.secondary]] as const) {
        if (w?.used_percent != null) {
          fire(`codex-${name}`, w.used_percent, `Codex limit at ${Math.round(w.used_percent)}%`,
            `${w.window_minutes && w.window_minutes > 5000 ? "weekly" : "5h"} window (${host})`);
        }
      }
    }
  };

  setInterval(hostCheck, HOST_CHECK_MS).unref();
  setTimeout(hostCheck, 60_000).unref();
  setInterval(() => void limitsCheck(), LIMITS_CHECK_MS).unref();
  setTimeout(() => void limitsCheck(), 90_000).unref();
}
