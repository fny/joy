// How a daemon was launched — shared by server.ts (which records it in
// daemon.json) and cli.ts (`joy stop`, which consults it when the supervisor
// itself cannot be asked whether it owns the pid; #502 residual). Kept out of
// cli.ts so the daemon never imports the CLI module (its argv handling and
// main() run at import).
import { platform as osPlatform } from "os";

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
