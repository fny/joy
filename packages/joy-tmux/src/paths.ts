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
