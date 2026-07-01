// The ONE seam for all tmux interaction. Session + Registry call these methods
// instead of run("tmux", …) directly, so the transport lives in one place.
//
// A persistent control-mode client (tmux -C attach-session) is the DEFAULT and only
// transport: captureCached() reads a %output-invalidated snapshot, captureFresh()
// awaits a control command, key/literal/command become control writes. The spawn
// methods (run) remain as the reconnect/while-disconnected fallback and for the
// bootstrap/teardown ops (runSync) that bracket the connection's lifetime. Callers
// never touch run("tmux") or spawn directly and never branch on which is active.
//
// See CONTROL-MODE-MIGRATION.md for the history.
import { run } from "./shell";
import { TmuxControlClient } from "./controlClient";
import { tmuxCommand } from "./serialize";

/** Shared result shape. `error` carries a %error / disconnect reason (control mode). */
export interface TmuxResult { ok: boolean; out: string; error?: string }

// Control mode is on in production. The only place it's skipped is the unit-test
// runner (vitest), where there's no tmux server to attach to and we don't want to
// spawn real subprocesses — the driver then uses its spawn methods, which the
// pure-function tests don't exercise. (Not a feature flag: the daemon never runs
// under vitest, so production is always control mode.)
const ENABLE_CONTROL = process.env.VITEST !== "true";
// Slow FULL-sweep backstop. %output-driven refreshes are pane-scoped (below), so
// this only exists to catch content changes with no %output (resize/redraw, a
// pane whose id mapping we missed). 1s full sweeps were the daemon's dominant
// idle cost: N capture commands/sec through the FIFO control channel.
const SNAPSHOT_REFRESH_MS = 5000;
const OUTPUT_DEBOUNCE_MS = 75;    // coalesce %output bursts before re-snapshotting

export class TmuxDriver {
  // Control-mode delegate + per-window snapshot cache. The spawn methods below are the
  // disconnected/while-unready fallback (and the bootstrap path), so callers never
  // branch on transport.
  #client: TmuxControlClient | null = null;
  #snapshots = new Map<string, { text: string; ts: number }>();
  #targets = new Set<string>();
  // pane-id ↔ target mapping so a %output only re-captures the window that
  // actually changed, instead of sweeping the whole fleet on every burst.
  #paneToTarget = new Map<string, string>();
  #targetToPane = new Map<string, string>();
  #dirty = new Set<string>();
  #outputTimer: ReturnType<typeof setTimeout> | null = null;
  #refreshInFlight = false;   // a sweep is currently running
  #refreshRequested = false;  // another %output/tick landed mid-sweep → run once more

  constructor() {
    if (ENABLE_CONTROL) {
      const session = process.env.TMUX_SESSION ?? "joy";
      this.#client = new TmuxControlClient(session, { onOutput: (paneId) => this.#onOutput(paneId) });
      const t = setInterval(() => {
        for (const target of this.#targets) {
          this.#dirty.add(target);
          if (!this.#targetToPane.has(target)) void this.#resolvePane(target);
        }
        void this.#refreshTracked();
      }, SNAPSHOT_REFRESH_MS);
      t.unref?.();
    }
  }

  /** Stop snapshot-tracking a window (session ended/killed): removes it from the
   *  periodic sweep so dead sessions stop costing captures. A later captureCached/
   *  captureFresh on the same target re-tracks it. */
  untrack(target: string): void {
    this.#targets.delete(target);
    this.#snapshots.delete(target);
    this.#dirty.delete(target);
    const pane = this.#targetToPane.get(target);
    if (pane) this.#paneToTarget.delete(pane);
    this.#targetToPane.delete(target);
  }

  #track(target: string): void {
    if (this.#targets.has(target)) return;
    this.#targets.add(target);
    void this.#resolvePane(target);
  }

  /** Resolve the target's pane id so %output events can be scoped to it. */
  async #resolvePane(target: string): Promise<void> {
    if (!this.#client?.connected) return;
    const r = await this.#client.command(tmuxCommand(["display-message", "-p", "-t", target, "#{pane_id}"]));
    const paneId = r.ok ? r.out.trim() : "";
    if (paneId.startsWith("%") && this.#targets.has(target)) {
      // Drop a stale reverse mapping if the window was recreated with a new pane.
      const old = this.#targetToPane.get(target);
      if (old && old !== paneId) this.#paneToTarget.delete(old);
      this.#targetToPane.set(target, paneId);
      this.#paneToTarget.set(paneId, target);
    }
  }

  // ── Spawn path (reconnect/while-disconnected fallback + bootstrap/teardown) ──

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

  // ── Control-mode NON-IDEMPOTENT writes (keystrokes, new-window) ──────────────
  // These must never be replayed: if control drops AFTER the command is on the wire we
  // can't know whether it landed, so a spawn retry could DOUBLE-apply (double-type, or
  // create a duplicate window). Policy: route to control ONLY when connected at call
  // entry and return its result verbatim — NO spawn fallback after a control attempt.
  // Spawn ONLY when not connected (nothing ever went over control, so it's safe).
  // Callers MUST check .ok and not assume the write landed.

  /** Send one or more NAMED keys (e.g. "C-u", "Escape", "Enter", "BTab"). */
  async key(target: string, ...names: string[]): Promise<TmuxResult> {
    return this.commandOnce(["send-keys", "-t", target, "--", ...names]);
  }

  /** Send LITERAL text verbatim (send-keys -l --) — no key-name interpretation. */
  async literal(target: string, text: string): Promise<TmuxResult> {
    return this.commandOnce(["send-keys", "-l", "-t", target, "--", text]);
  }

  /** Run a NON-IDEMPOTENT tmux command (keystrokes, new-window) with the no-retry policy above. */
  async commandOnce(args: string[]): Promise<TmuxResult> {
    if (this.#client?.connected) {
      let line: string;
      try { line = tmuxCommand(args); }
      catch (e) { return { ok: false, out: "", error: String(e) }; } // un-encodable (newline/NUL)
      return this.#client.command(line); // verbatim result — NO spawn retry (non-idempotent)
    }
    return run("tmux", ...args); // not connected → spawn (nothing went over control)
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
   * periodic + %output refresh). Disconnected / color: a plain spawn capture.
   * (Colour is uncached — snapshots are plain text.)
   */
  captureCached(target: string, opts?: { color?: boolean }): TmuxResult {
    if (this.#client?.connected && !opts?.color) {
      this.#track(target);
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
   * disconnect/error (or under the test runner, where there's no client).
   */
  async captureFresh(target: string, opts?: { color?: boolean }): Promise<TmuxResult> {
    if (this.#client?.connected) {
      this.#track(target);
      // -e keeps ANSI for the app's colour pane view; that text must NOT pollute the
      // plain-text snapshot cache (the watchers read plain), so colour reads go over
      // control but stay UNcached. Plain reads update the cache as before.
      const args = opts?.color
        ? ["capture-pane", "-p", "-e", "-t", target]
        : ["capture-pane", "-p", "-t", target];
      const r = await this.#client.command(tmuxCommand(args));
      if (r.ok) { if (!opts?.color) this.#snapshots.set(target, { text: r.out, ts: nowMs() }); return r; }
      // disconnect / %error → fall through to spawn
    }
    return this.capture(target, opts);
  }

  #onOutput(paneId: string): void {
    // Scope the refresh to the window that actually produced output. An unknown
    // pane (mapping not resolved yet, or a non-joy window in the session) is
    // ignored — the slow backstop sweep covers stragglers.
    const target = this.#paneToTarget.get(paneId);
    if (!target) return;
    this.#dirty.add(target);
    if (this.#outputTimer) return; // debounce a burst into one refresh
    const t = setTimeout(() => { this.#outputTimer = null; void this.#refreshTracked(); }, OUTPUT_DEBOUNCE_MS);
    t.unref?.();
    this.#outputTimer = t;
  }

  // Re-snapshot the DIRTY windows over the connection (no spawn). %output marks
  // just the emitting window dirty; the slow ticker marks everything (backstop
  // for resize/redraw and missed mappings). A gone window stops tracking.
  //
  // Coalesced: the %output debounce and the ticker both call this, and each sweep
  // awaits N capture commands — so without a guard they'd interleave into 2N+ queued
  // commands. At most ONE sweep runs; anything that fires mid-sweep sets a flag that
  // triggers exactly one more sweep when the current finishes (so the final state is
  // never missed, but bursts collapse to a single trailing refresh).
  async #refreshTracked(): Promise<void> {
    if (this.#refreshInFlight) { this.#refreshRequested = true; return; }
    this.#refreshInFlight = true;
    try {
      if (!this.#client?.connected) return;
      const dirty = [...this.#dirty];
      this.#dirty.clear();
      for (const target of dirty) {
        if (!this.#targets.has(target)) continue; // untracked mid-sweep
        const r = await this.#client.command(tmuxCommand(["capture-pane", "-p", "-t", target]));
        if (r.ok) this.#snapshots.set(target, { text: r.out, ts: nowMs() });
        else if (r.error && /can't find/i.test(r.error)) this.untrack(target);
      }
    } finally {
      this.#refreshInFlight = false;
      if (this.#refreshRequested) { this.#refreshRequested = false; void this.#refreshTracked(); }
    }
  }
}

function nowMs(): number { return Date.now(); }

/** Process-wide driver: control client + spawn fallback (spawn-only under vitest). */
export const tmux = new TmuxDriver();
