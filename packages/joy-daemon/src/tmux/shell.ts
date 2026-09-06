// Tiny synchronous shell helper shared by session/registry (tmux invocations).
import { spawnSyncBounded } from "../domain/bounded";
import { tmuxSocketArgs } from "../paths";

/** Deadline for any synchronous helper subprocess (#594). A synchronous child
 *  blocks the whole event loop, so a tmux server that stops responding used to
 *  freeze every session, the HTTP transport and every timer for as long as it
 *  stayed wedged. The sync semantics the pane-clearing flow relies on
 *  (docs/pane-input-clearing.md) are kept; only the unbounded wait goes. Same
 *  bound as the control-mode watchdog; a healthy tmux answers in milliseconds. */
export const SYNC_RUN_TIMEOUT_MS = 8000;

/** stdout is returned as-is — NOT trimmed. A pane's leading whitespace and
 *  blank rows are content (#595): trimming shifted the first captured line
 *  left and dropped blank rows on the spawn path only, so the terminal view
 *  and the snapshot cache disagreed with control-mode captures. Callers that
 *  read a scalar (a pid, a version) trim themselves. */
export function run(...args: string[]): { ok: boolean; out: string } {
  const [cmd, ...rest] = args;
  const r = spawnSyncBounded(cmd, rest, SYNC_RUN_TIMEOUT_MS);
  if (r.timedOut) process.stderr.write(`[run] ${args.join(" ")}: no exit within ${SYNC_RUN_TIMEOUT_MS}ms — killed (#594)\n`);
  return { ok: r.ok, out: r.out };
}

/** The tmux argv prefix for THIS process's relay: plain "tmux" on the default
 *  relay, "tmux -L joy-<key>" otherwise — every tmux spawn must go through
 *  this so per-relay daemons stay on their own tmux server. */
export function tmuxArgv(): string[] {
  return ["tmux", ...tmuxSocketArgs()];
}
