// How a daemon was launched — shared by server.ts (which records it in
// daemon.json) and cli.ts (`joy stop`, which consults it when the supervisor
// itself cannot be asked whether it owns the pid; #502 residual). Kept out of
// cli.ts so the daemon never imports the CLI module (its argv handling and
// main() run at import).
import { platform as osPlatform } from "os";
import { readFileSync } from "fs";
import { spawnSync } from "child_process";

/** Under the systemd user unit, under the launchd agent, or detached (`joy
 *  start`, a self-restart of a detached daemon). */
export type DaemonLauncher = "systemd" | "launchd" | "detached";

/** Environment the supervisors stamp on what they launch: systemd's
 *  INVOCATION_ID / JOURNAL_STREAM, launchd's XPC_SERVICE_NAME. */
export const SUPERVISOR_ENV = ["INVOCATION_ID", "JOURNAL_STREAM", "XPC_SERVICE_NAME"] as const;

/** The launch mode a process can read off its own environment. launchd sets
 *  XPC_SERVICE_NAME to the job label; a shell process sees "0" or nothing. */
export function launcherFromEnv(env: Record<string, string | undefined>, platform: string = osPlatform()): DaemonLauncher {
  if (platform === "linux" && env.INVOCATION_ID) return "systemd";
  if (platform === "darwin" && env.XPC_SERVICE_NAME && env.XPC_SERVICE_NAME !== "0") return "launchd";
  return "detached";
}

/** The kernel's identity for the START of process `pid` — the thing a pid
 *  number alone is not. Once a process exits its number goes to whatever
 *  forks next, and a daemon.json that names the number then points at a
 *  stranger (#495). pid + start identity is how the OS itself tells
 *  processes apart (pidfd, systemd's MainPID checks).
 *
 *  Linux: /proc/<pid>/stat field 22 (starttime, clock ticks since boot),
 *  qualified by the boot id so a value from before a reboot cannot match one
 *  from after it. macOS: `ps -o lstart=` (the start time to the second — ps
 *  has no finer clock; two processes cannot take the same pid within the
 *  same second). null when the OS will not say. The daemon records its own
 *  at launch (daemon.json `startId`); `joy stop` requires the live pid's to
 *  match it EXACTLY before it signals. */
export function processStartId(pid: number, platform: string = osPlatform()): string | null {
  if (platform === "linux") {
    try {
      // "pid (comm) state ppid …": comm may contain spaces and parens, so
      // split after the LAST ')'. starttime is field 22 overall = index 19
      // after the comm.
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
      const ticks = fields[19];
      if (!ticks || !/^\d+$/.test(ticks)) return null;
      let boot: string;
      try { boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(); } catch {
        const btime = readFileSync("/proc/stat", "utf8").split("\n").find((l) => l.startsWith("btime "));
        if (!btime) return null;
        boot = `btime-${btime.slice(6).trim()}`;
      }
      return `linux:${boot}:${ticks}`;
    } catch { return null; }
  }
  const r = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" });
  const lstart = r.status === 0 ? (r.stdout ?? "").trim() : "";
  return lstart ? `${platform}:${lstart}` : null;
}
