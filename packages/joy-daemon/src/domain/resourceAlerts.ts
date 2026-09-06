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

/**
 * Edge-trigger + cooldown gate, one state per alert key. `check` answers
 * whether a push should go out NOW for this sample. The two conditions are
 * independent (#565): a push needs the key to be ARMED (it dipped under REARM
 * since the last push — or never fired) AND the cooldown since the last push
 * to have elapsed. The old combined test `armed===false && inCooldown` let a
 * 95→80→95 sequence push twice in ten minutes (the dip re-armed, so the
 * cooldown was never consulted) and a box pinned at 95% push again every
 * four hours with no downward crossing at all.
 */
export class AlertGate {
  #armed: Record<string, boolean> = {};   // false = fired and no dip under REARM since
  #lastPush: Record<string, number> = {};

  check(key: string, percent: number | null, now: number = Date.now()): boolean {
    if (percent == null) return false;
    if (percent < REARM) { this.#armed[key] = true; return false; }
    if (percent < HOT) return false;
    if (this.#armed[key] === false) return false;                        // still hot since the last push
    const last = this.#lastPush[key];
    if (last !== undefined && now - last < PUSH_COOLDOWN_MS) return false; // re-armed, but too soon
    this.#armed[key] = false;
    this.#lastPush[key] = now;
    return true;
  }
}

type Fire = (key: string, percent: number | null, title: string, body: string) => void;
interface LimitsDeps {
  fetchClaudeLimits: typeof fetchClaudeLimits;
  readCodexLimits: typeof readCodexLimits;
  host: string;
}

/**
 * One scheduled quota check. NEVER rejects: it runs from a timer whose
 * caller discards the promise, and an escaped rejection terminates Node
 * under the default policy. The usage endpoint answered 200 with a JSON
 * `null` body once — `ok:true, limits:null` — and `limits.five_hour` threw
 * outside the only try/catch (#566). Every quota object is validated before
 * it is dereferenced, and the whole body is caught as a last resort.
 */
export async function runLimitsCheck(fire: Fire, deps: LimitsDeps): Promise<void> {
  const { host } = deps;
  try {
    const claude = await deps.fetchClaudeLimits().catch(() => null);
    const limits = claude?.ok && claude.limits && typeof claude.limits === "object" ? claude.limits : null;
    if (limits) {
      const buckets: Array<[string, unknown]> = [["5-hour", limits.five_hour], ["weekly", limits.seven_day]];
      for (const [name, raw] of buckets) {
        const b = raw && typeof raw === "object" ? raw as { utilization?: unknown; resets_at?: unknown } : null;
        if (typeof b?.utilization !== "number") continue;
        const resets = typeof b.resets_at === "string" && Number.isFinite(Date.parse(b.resets_at)) ? new Date(b.resets_at).toLocaleTimeString() : "soon";
        fire(`claude-${name}`, b.utilization, `Claude ${name} limit at ${Math.round(b.utilization)}%`, `resets ${resets} (${host})`);
      }
    }
  } catch { /* a malformed quota response must not take the daemon down */ }
  try {
    const codex = deps.readCodexLimits();
    if (codex.ok && codex.limits && typeof codex.limits === "object") {
      for (const [name, w] of [["primary", codex.limits.primary], ["secondary", codex.limits.secondary]] as const) {
        if (typeof w?.used_percent !== "number") continue;
        fire(`codex-${name}`, w.used_percent, `Codex limit at ${Math.round(w.used_percent)}%`,
          `${typeof w.window_minutes === "number" && w.window_minutes > 5000 ? "weekly" : "5h"} window (${host})`);
      }
    }
  } catch { /* same */ }
}

export function startResourceAlerts(pusher: Pusher): void {
  const gate = new AlertGate();
  const host = hostname();

  const fire: Fire = (key, percent, title, body) => {
    if (!gate.check(key, percent)) return;
    void pusher.sendPush(title, body).catch(() => { /* best-effort */ });
  };

  const hostCheck = () => {
    fire("ram", ramUsedPercent(), `RAM high on ${host}`, `${ramUsedPercent()}% used — sessions may queue or misbehave`);
    fire("disk", diskUsedPercent(), `Disk high on ${host}`, `${diskUsedPercent()}% full — transcripts and caches may start failing`);
  };
  const limitsCheck = () => runLimitsCheck(fire, { fetchClaudeLimits, readCodexLimits, host });

  setInterval(hostCheck, HOST_CHECK_MS).unref();
  setTimeout(hostCheck, 60_000).unref();
  // Belt and braces (#566): runLimitsCheck already contains its failures, but
  // a timer callback must never hand the loop an unhandled rejection.
  setInterval(() => { limitsCheck().catch(() => {}); }, LIMITS_CHECK_MS).unref();
  setTimeout(() => { limitsCheck().catch(() => {}); }, 90_000).unref();
}
