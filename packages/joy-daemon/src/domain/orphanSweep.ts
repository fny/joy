// The orphan sweep of per-session tmux servers (#55).
//
// A per-session server (`tmux -L joy-<8 hex>`) that outlives its window
// record — a crash between server-spawn and record write — is a leak, and
// recover() retires it. "Ours" used to be decided by the socket name alone,
// and "known" by THIS state dir's records: a second daemon universe on the
// same box (the e2e stack under ~/.joy-test, any JOY_HOME_DIR checkout, a
// per-relay daemon) uses the same label scheme and the same /tmp/tmux-<uid>,
// and its live sessions are known to nobody here. They were protected only
// while that daemon's control client was attached; the moment it was stopped
// or restarting, a boot of the other daemon kill-server'd its live agents.
//
// Now every server the daemon spawns is stamped, in its global environment,
// with the state dir of the daemon that owns it, and the sweep retires only
// servers stamped with OUR state dir. A server with no stamp (spawned before
// this) or another universe's stamp is left alone and logged.
import { existsSync, readdirSync } from "fs";
import { run as defaultRun } from "../tmux/shell";
import { joyStateDir } from "../paths";

/** The tmux global-environment variable carrying the owner's state dir. */
export const TMUX_OWNER_VAR = "JOY_OWNER_STATE_DIR";

/** Only OUR per-session label shapes (`joy-<8 hex>` and the legacy
 *  `joy-<relayKey>-s-<8 hex>`): the shared server's socket is
 *  `joy-<relayKey>` and must never be swept. */
export const PER_SESSION_SOCKET = /^joy-[0-9a-f]{8}$|-s-[0-9a-f]{8}$/;

/** This daemon's identity as stamped on its servers. */
export function tmuxOwnerStamp(): string { return joyStateDir(); }

/** Stamp a freshly spawned per-session server as ours. */
export function stampTmuxServerOwner(drv: { runSync(...args: string[]): { ok: boolean; out: string } }, stamp = tmuxOwnerStamp()): void {
  drv.runSync("set-environment", "-g", TMUX_OWNER_VAR, stamp);
}

/** The owner stamp a `show-environment -g` answer carries, or null. */
export function parseOwnerStamp(out: string): string | null {
  const m = new RegExp(`^${TMUX_OWNER_VAR}=(.*)$`, "m").exec(out);
  return m ? m[1].trim() || null : null;
}

export interface SweepIO {
  /** The tmux socket directory (`$TMUX_TMPDIR` or /tmp/tmux-<uid>). */
  dir: string;
  /** Sockets our window records name — never swept. */
  known: ReadonlySet<string>;
  /** This daemon's stamp; defaults to the state dir. */
  owner?: string;
  run?: (...args: string[]) => { ok: boolean; out: string };
  log?: (line: string) => void;
  listDir?: (dir: string) => string[];
}

/** Retire our stamped, recordless, client-less per-session servers. Returns
 *  the socket names killed. */
export function sweepOrphanTmuxServers(io: SweepIO): string[] {
  const run = io.run ?? defaultRun;
  const log = io.log ?? (() => {});
  const owner = io.owner ?? tmuxOwnerStamp();
  const names = io.listDir ? io.listDir(io.dir) : (existsSync(io.dir) ? readdirSync(io.dir) : []);
  const killed: string[] = [];
  for (const name of names) {
    if (!PER_SESSION_SOCKET.test(name) || io.known.has(name)) continue;
    if (!run("tmux", "-L", name, "has-session").ok) continue; // dead socket file; tmux cleans it
    const stamp = parseOwnerStamp(run("tmux", "-L", name, "show-environment", "-g", TMUX_OWNER_VAR).out);
    if (stamp !== owner) {
      log(`leaving tmux server ${name} alone: ${stamp ? `owned by another daemon (${stamp})` : "no owner stamp"}`);
      continue;
    }
    const clients = run("tmux", "-L", name, "list-clients").out.trim();
    if (clients) continue; // a human is attached — leave it alone
    run("tmux", "-L", name, "kill-server");
    killed.push(name);
    log(`retired orphan tmux server ${name} (no record, no clients)`);
  }
  return killed;
}
