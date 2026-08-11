import { homedir } from "os";
import { join } from "path";
import { existsSync, mkdirSync, renameSync } from "fs";

/**
 * The Happy home directory — $HAPPY_HOME_DIR (with a leading ~ expanded) or
 * ~/.happy. As of 2026-08-11 this holds ONLY what belongs to the ORIGINAL
 * relay's pairing (access.key, settings.json — shared with happy-cli daemons).
 * Everything joy-owned lives under joyHomeDir().
 */
export function happyHomeDir(): string {
  const env = process.env.HAPPY_HOME_DIR;
  return env ? env.replace(/^~/, homedir()) : join(homedir(), ".happy");
}

/** The Joy home — $JOY_HOME_DIR or ~/.joy. Daemon state, per-session dirs,
 *  and credentials for any NON-default relay all live here. */
export function joyHomeDir(): string {
  const env = process.env.JOY_HOME_DIR;
  return env ? env.replace(/^~/, homedir()) : join(homedir(), ".joy");
}

// One-shot migration: the state dir moved from ~/.happy/joy-tmux-state to
// ~/.joy/state (2026-08-11). A same-filesystem rename carries windows/queues/
// receipts across atomically; the old location is left absent so happy tools
// never see stale joy state. Lazy + cached: every entrypoint (server, cli,
// tests via env overrides) goes through joyStateDir().
let stateMigrated = false;

/** Where the daemon keeps its state: daemon.json, windows, queues, receipts. */
export function joyStateDir(): string {
  const dir = join(joyHomeDir(), "state");
  if (!stateMigrated) {
    stateMigrated = true;
    const legacy = join(happyHomeDir(), "joy-tmux-state");
    if (!existsSync(dir) && existsSync(legacy)) {
      try {
        mkdirSync(joyHomeDir(), { recursive: true });
        renameSync(legacy, dir);
        process.stderr.write(`[paths] migrated state ${legacy} -> ${dir}\n`);
      } catch (e) {
        process.stderr.write(`[paths] state migration failed (${e}) — using legacy dir\n`);
        return legacy;
      }
    }
  }
  return dir;
}

/** Credentials dir for a NON-default relay: ~/.joy/relays/<host[_port]>/
 *  (access.key + settings.json, same shapes as ~/.happy's). The DEFAULT
 *  relay's credentials stay in ~/.happy — they're shared with happy-cli. */
export function joyRelayCredsDir(serverUrl: string): string {
  const u = new URL(serverUrl);
  const key = u.port ? `${u.hostname}_${u.port}` : u.hostname;
  return join(joyHomeDir(), "relays", key);
}

/** Per-session home for everything session-related the daemon/agent persists
 *  outside the project cwd — display images (joy-img media/), future drafts,
 *  exports. The readFile RPC allows this directory as a second root scoped to
 *  exactly the session being asked (each session reaches only its own folder). */
export function joySessionDir(sessionId: string): string {
  return join(joyHomeDir(), "sessions", sessionId);
}
