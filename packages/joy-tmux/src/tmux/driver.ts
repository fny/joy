// The ONE seam for all tmux interaction. Session calls these methods instead of
// run("tmux", …) directly, so the transport can change in one place. (Registry
// still calls run() directly — its rare lifecycle ops are Phase 4.)
//
// Phase 0 (here): a thin SYNCHRONOUS wrapper over the spawn helper (run) — no
// behavior change, every Session tmux call just routed through this object.
//
// Later phases add a persistent control-mode client (tmux -C attach-session) as a
// private delegate: captureCached() reads a %output-invalidated snapshot,
// captureFresh() awaits a control command, send/resize become writes — all with
// this spawn path kept as the reconnect/while-disconnected fallback. Callers never
// touch run("tmux") or spawn, and never branch on which transport is active.
//
// See CONTROL-MODE-MIGRATION.md for the full plan.
import { run } from "./shell";
import { TmuxControlClient } from "./controlClient";
import { tmuxCommand } from "./serialize";

/** Shared result shape. `error` carries a %error / disconnect reason (control mode). */
export interface TmuxResult { ok: boolean; out: string; error?: string }

// Phase 1: opt-in. Off (default) → every method is the spawn path = Phase 0 behavior.
const CONTROL = process.env.JOY_TMUX_CONTROL === "1";
const SNAPSHOT_REFRESH_MS = 1000; // periodic backstop refresh of tracked windows
const OUTPUT_DEBOUNCE_MS = 75;    // coalesce %output bursts before re-snapshotting

export class TmuxDriver {
  // Control-mode delegate + per-window snapshot cache (control mode only). The spawn
  // methods below are the disconnected/while-unready fallback and the only path when
  // the flag is off — so callers never branch on transport.
  #client: TmuxControlClient | null = null;
  #snapshots = new Map<string, { text: string; ts: number }>();
  #targets = new Set<string>();
  #outputTimer: ReturnType<typeof setTimeout> | null = null;
  #refreshInFlight = false;   // a sweep is currently running
  #refreshRequested = false;  // another %output/tick landed mid-sweep → run once more

  constructor() {
    if (CONTROL) {
      const session = process.env.TMUX_SESSION ?? "joy";
      this.#client = new TmuxControlClient(session, { onOutput: () => this.#onOutput() });
      const t = setInterval(() => { void this.#refreshTracked(); }, SNAPSHOT_REFRESH_MS);
      t.unref?.();
    }
  }

  // ── Spawn path (flag-off + reconnect fallback + bootstrap/teardown) ──────────

  /** Capture a pane's visible text. color=true keeps ANSI SGR (the app's colour view). */
  capture(target: string, opts?: { color?: boolean }): TmuxResult {
    return opts?.color
      ? run("tmux", "capture-pane", "-p", "-e", "-t", target)
      : run("tmux", "capture-pane", "-p", "-t", target);
  }

  /**
   * Explicit SPAWN, never control mode — for the bootstrap/teardown ops that bracket
   * the control connection's lifetime and inherently can't go through it: has-session
   * (gates creation), new-session (creates the very session the client attaches to),
   * kill-session (destroys it), and recover()'s startup scan (runs before attach).
   */
  runSync(...args: string[]): TmuxResult {
    return run("tmux", ...args);
  }

  // ── Control-mode writes (NON-IDEMPOTENT keystrokes), spawn only when not connected ─
  // A keystroke must never be replayed: if control drops AFTER a send-keys is on the
  // wire we can't know whether it landed, so a spawn retry could DOUBLE-type. Policy:
  // route to control ONLY when connected at call entry and return its result verbatim
  // (no spawn fallback after a control attempt). Spawn ONLY when the flag is off or the
  // client isn't connected — there, nothing was ever sent over control, so it's safe.

  /** Send one or more NAMED keys (e.g. "C-u", "Escape", "Enter", "BTab"). */
  async key(target: string, ...names: string[]): Promise<TmuxResult> {
    return this.#sendKeys(["send-keys", "-t", target, "--", ...names]);
  }

  /** Send LITERAL text verbatim (send-keys -l --) — no key-name interpretation. */
  async literal(target: string, text: string): Promise<TmuxResult> {
    return this.#sendKeys(["send-keys", "-l", "-t", target, "--", text]);
  }

  async #sendKeys(args: string[]): Promise<TmuxResult> {
    if (this.#client?.connected) {
      let line: string;
      try { line = tmuxCommand(args); }
      catch (e) { return { ok: false, out: "", error: String(e) }; } // un-encodable (newline/NUL)
      return this.#client.command(line); // verbatim result — NO spawn retry (non-idempotent)
    }
    return run("tmux", ...args); // flag off / not connected → spawn (nothing went over control)
  }

  // ── Control-mode generic command (IDEMPOTENT: resize/display/list/kill/has/hook) ──
  // Safe to retry, so on any control failure (or while disconnected) we fall back to
  // spawn. Returns data (list-windows / display-message) as well as ok/fail.

  /** Run an arbitrary tmux command — control when connected, spawn fallback otherwise. */
  async command(args: string[]): Promise<TmuxResult> {
    if (this.#client?.connected) {
      let line: string;
      try { line = tmuxCommand(args); } catch { return run("tmux", ...args); }
      const r = await this.#client.command(line);
      if (r.ok) return r;
      // %error / disconnect → idempotent, fall through to a spawn retry
    }
    return run("tmux", ...args);
  }

  // ── Control-mode reads (snapshot cache + fresh command), spawn fallback ──────

  /**
   * SYNC read of the latest known pane text — for status/watcher paths (#pollThinking,
   * startup, trust) where a slightly stale read is fine. Control mode: the cached
   * snapshot (filled by a one-off spawn the first time, then kept fresh by the
   * periodic + %output refresh). Flag off / disconnected / color: a plain spawn
   * capture. (Colour is spawn-only — snapshots are plain text.)
   */
  captureCached(target: string, opts?: { color?: boolean }): TmuxResult {
    if (this.#client?.connected && !opts?.color) {
      this.#targets.add(target);
      const s = this.#snapshots.get(target);
      if (s) return { ok: true, out: s.text };
      const r = this.capture(target); // no snapshot yet → spawn once, then refresh takes over
      if (r.ok) this.#snapshots.set(target, { text: r.out, ts: nowMs() });
      return r;
    }
    return this.capture(target, opts);
  }

  /**
   * FRESH awaited capture — for the decisions where a stale read causes data loss
   * (the dispatch gate's empty-box check, abort, clear). Control mode: a capture-pane
   * command over the connection; updates the cache. Falls back to a spawn capture on
   * disconnect/error or when the flag is off.
   */
  async captureFresh(target: string, opts?: { color?: boolean }): Promise<TmuxResult> {
    if (this.#client?.connected && !opts?.color) {
      this.#targets.add(target);
      const r = await this.#client.command(tmuxCommand(["capture-pane", "-p", "-t", target]));
      if (r.ok) { this.#snapshots.set(target, { text: r.out, ts: nowMs() }); return r; }
      // disconnect / %error → fall through to spawn
    }
    return this.capture(target, opts);
  }

  #onOutput(): void {
    if (this.#outputTimer) return; // debounce a burst into one refresh
    const t = setTimeout(() => { this.#outputTimer = null; void this.#refreshTracked(); }, OUTPUT_DEBOUNCE_MS);
    t.unref?.();
    this.#outputTimer = t;
  }

  // Re-snapshot every tracked window over the connection (no spawn). Phase 1 refreshes
  // ALL tracked windows on any %output (simple, correct; Phase 1.5 can map pane→window
  // to refresh only the one that changed). A window that's gone stops being tracked.
  //
  // Coalesced: the %output debounce and the 1s ticker both call this, and each sweep
  // awaits N capture commands — so without a guard they'd interleave into 2N+ queued
  // commands. At most ONE sweep runs; anything that fires mid-sweep sets a flag that
  // triggers exactly one more sweep when the current finishes (so the final state is
  // never missed, but bursts collapse to a single trailing refresh).
  async #refreshTracked(): Promise<void> {
    if (this.#refreshInFlight) { this.#refreshRequested = true; return; }
    this.#refreshInFlight = true;
    try {
      if (!this.#client?.connected) return;
      for (const target of [...this.#targets]) {
        const r = await this.#client.command(tmuxCommand(["capture-pane", "-p", "-t", target]));
        if (r.ok) this.#snapshots.set(target, { text: r.out, ts: nowMs() });
        else if (r.error && /can't find/i.test(r.error)) { this.#targets.delete(target); this.#snapshots.delete(target); }
      }
    } finally {
      this.#refreshInFlight = false;
      if (this.#refreshRequested) { this.#refreshRequested = false; void this.#refreshTracked(); }
    }
  }
}

function nowMs(): number { return Date.now(); }

/** Process-wide driver. Flag off = spawn. Flag on = control client + spawn fallback. */
export const tmux = new TmuxDriver();
