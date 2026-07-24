// Pane-attach wrapper for the codex TUI. The daemon owns the app-server (over a
// unix socket); the tmux window runs a REAL codex TUI attached to the same
// thread via `codex --remote`, so the user can watch/intervene. The thread
// can't be resumed until its first turn has flushed a rollout, so the wrapper
// polls for the rollout, then execs the TUI; it loops so it re-attaches if the
// TUI exits (e.g. after an app-server restart). Best-effort — the app-server
// drive works headless regardless.

import { join } from "path";
import { joyStateDir } from "../paths";

/** A one-line shell command the tmux window runs: wait for the socket, then
 *  attach a `codex --remote` TUI resumed onto the thread, retrying on exit. */
export function buildCodexAttachCommand(socketPath: string, threadId: string): string {
  const bin = process.env.JOY_CODEX_BIN ?? "codex";
  // Poll until the app-server socket exists, then attach; loop on exit.
  return [
    `while [ ! -S '${socketPath}' ]; do sleep 0.3; done;`,
    `while true; do`,
    ` ${bin} --remote 'unix://${socketPath}' -c check_for_update_on_startup=false resume '${threadId}' || true;`,
    ` sleep 1;`,
    `done`,
  ].join(" ");
}

/** Per-session app-server socket path. */
export function codexSocketPath(id: string): string {
  return join(joyStateDir(), `codex-${id}.sock`);
}
