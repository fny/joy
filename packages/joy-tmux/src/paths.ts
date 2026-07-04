import { homedir } from "os";
import { join } from "path";

/**
 * The Happy home directory — $HAPPY_HOME_DIR (with a leading ~ expanded) or
 * ~/.happy. Single source of truth so the CLI, the daemon (server.ts), and the
 * relay all agree on where credentials and daemon state live.
 */
export function happyHomeDir(): string {
  const env = process.env.HAPPY_HOME_DIR;
  return env ? env.replace(/^~/, homedir()) : join(homedir(), ".happy");
}

/** Where the daemon keeps its state: daemon.json, daemon.lock, daemon.log. */
export function joyStateDir(): string {
  return join(happyHomeDir(), "joy-tmux-state");
}

/** Per-session home for everything session-related the daemon/agent persists
 *  outside the project cwd — display images (joy-img media/), future drafts,
 *  exports. The readFile RPC allows this directory as a second root scoped to
 *  exactly the session being asked (each session reaches only its own folder). */
export function joySessionDir(sessionId: string): string {
  return join(homedir(), ".joy", "sessions", sessionId);
}
