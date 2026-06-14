// Tiny synchronous shell helper shared by session/registry (tmux invocations).
export function run(...args: string[]): { ok: boolean; out: string } {
  const r = Bun.spawnSync(args, { stderr: "pipe" });
  return { ok: r.exitCode === 0, out: new TextDecoder().decode(r.stdout).trim() };
}
