// Tiny synchronous shell helper shared by session/registry (tmux invocations).
import { spawnSync } from "child_process";

export function run(...args: string[]): { ok: boolean; out: string } {
  const [cmd, ...rest] = args;
  const r = spawnSync(cmd, rest, { stdio: ["ignore", "pipe", "pipe"] });
  return { ok: r.status === 0, out: (r.stdout?.toString() ?? "").trim() };
}
