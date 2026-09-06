// Pane-attach wrapper for the codex TUI. The daemon owns the app-server (over a
// unix socket); the tmux window runs a REAL codex TUI attached to the same
// thread via `codex --remote`, so the user can watch/intervene.
//
// A TUI attaching to the SAME live daemon-owned app-server rejoins the running
// thread immediately — it does NOT need to wait for a first-turn rollout flush
// (that restriction only applies to a NEW server resuming persisted state; the
// thread here is already live in our server). We still poll for the socket to
// exist before attaching. The loop re-attaches if the TUI exits.

import { join } from "path";
import { joyStateDir } from "../paths";

import { shellQuote as shq } from "../domain/quote"; // one quoting helper (#470 family)

/** A one-line shell command the tmux window runs: wait for the socket, then
 *  attach a `codex --remote` TUI resumed onto the thread. Loops on exit but
 *  stops after an intentional clean exit (code 0) so it doesn't respawn forever. */
export function buildCodexAttachCommand(socketPath: string, threadId: string): string {
  const bin = shq(process.env.JOY_CODEX_BIN ?? "codex");
  const sock = shq(socketPath);
  const remote = shq(`unix://${socketPath}`);
  const thread = shq(threadId);
  return [
    `while [ ! -S ${sock} ]; do sleep 0.3; done;`,
    `while true; do`,
    ` ${bin} --remote ${remote} -c check_for_update_on_startup=false resume ${thread};`,
    ` [ $? -eq 0 ] && break;`, // clean exit → stop; crash/disconnect → retry
    ` sleep 1;`,
    `done`,
  ].join(" ");
}

/** Per-session app-server socket path. */
export function codexSocketPath(id: string): string {
  return join(joyStateDir(), `codex-${id}.sock`);
}
