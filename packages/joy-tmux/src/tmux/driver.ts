// The ONE seam for all tmux interaction. Session and Registry call these methods
// instead of run("tmux", …) directly, so the transport can change in one place.
//
// Phase 0 (here): a thin SYNCHRONOUS wrapper over the spawn helper (run) — no
// behavior change, every tmux call just routed through this object.
//
// Later phases swap the internals for a persistent control-mode client
// (tmux -CC attach-session): captureCached() reads a %output-invalidated snapshot,
// captureFresh() awaits a control command, send/resize become writes — all with
// this spawn path kept as the reconnect/while-disconnected fallback. Callers never
// touch run("tmux") or spawn, and never branch on which transport is active.
//
// See CONTROL-MODE-MIGRATION.md for the full plan.
import { run } from "./shell";

export class TmuxDriver {
  /** Capture a pane's visible text. color=true keeps ANSI SGR (the app's colour view). */
  capture(target: string, opts?: { color?: boolean }): { ok: boolean; out: string } {
    return opts?.color
      ? run("tmux", "capture-pane", "-p", "-e", "-t", target)
      : run("tmux", "capture-pane", "-p", "-t", target);
  }

  /** Send one or more NAMED keys (e.g. "C-u", "Escape", "Enter", "BTab"). */
  key(target: string, ...names: string[]): { ok: boolean } {
    return run("tmux", "send-keys", "-t", target, ...names);
  }

  /** Send LITERAL text verbatim (send-keys -l --) — no key-name interpretation. */
  literal(target: string, text: string): { ok: boolean } {
    return run("tmux", "send-keys", "-l", "-t", target, "--", text);
  }

  /** Escape hatch for the rarer / lifecycle commands (resize, kill, display, …). */
  runSync(...args: string[]): { ok: boolean; out: string } {
    return run("tmux", ...args);
  }
}

/** Process-wide driver. Phase 0 = spawn; later phases swap the internals here. */
export const tmux = new TmuxDriver();
