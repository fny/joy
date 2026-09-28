// Tiny shell helpers shared by session/registry (tmux invocations).
import { execFile } from "node:child_process";
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

/** Output a pane capture may return (a colour capture with scrollback is the
 *  big case). Past it the capture fails rather than buffering without bound. */
export const ASYNC_RUN_MAX_BYTES = 32 * 1024 * 1024;

/**
 * `run`, without blocking the event loop: for the frequent calls (pane
 * captures), where a synchronous child per call is what the control-mode
 * migration removed. Same deadline and the same untrimmed stdout (#595).
 */
export function runAsync(...args: string[]): Promise<{ ok: boolean; out: string }> {
  const [cmd, ...rest] = args;
  return new Promise((resolve) => {
    execFile(cmd, rest, { encoding: "utf8", timeout: SYNC_RUN_TIMEOUT_MS, killSignal: "SIGKILL", maxBuffer: ASYNC_RUN_MAX_BYTES }, (err, stdout) => {
      if (err && (err as { killed?: boolean }).killed) process.stderr.write(`[runAsync] ${args.join(" ")}: no exit within ${SYNC_RUN_TIMEOUT_MS}ms — killed (#594)\n`);
      resolve({ ok: !err, out: stdout ?? "" });
    });
  });
}

/** The tmux argv prefix for THIS process's relay: plain "tmux" on the default
 *  relay, "tmux -L joy-<key>" otherwise — every tmux spawn must go through
 *  this so per-relay daemons stay on their own tmux server. */
export function tmuxArgv(): string[] {
  return ["tmux", ...tmuxSocketArgs()];
}
