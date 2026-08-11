// Tiny synchronous shell helper shared by session/registry (tmux invocations).
import { spawnSync } from "child_process";
import { tmuxSocketArgs } from "../paths";

export function run(...args: string[]): { ok: boolean; out: string } {
  const [cmd, ...rest] = args;
  const r = spawnSync(cmd, rest, { stdio: ["ignore", "pipe", "pipe"] });
  return { ok: r.status === 0, out: (r.stdout?.toString() ?? "").trim() };
}

/** The tmux argv prefix for THIS process's relay: plain "tmux" on the default
 *  relay, "tmux -L joy-<key>" otherwise — every tmux spawn must go through
 *  this so per-relay daemons stay on their own tmux server. */
export function tmuxArgv(): string[] {
  return ["tmux", ...tmuxSocketArgs()];
}
