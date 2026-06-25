// Persistent tmux control-mode client for ONE tmux server. Spawns
// `tmux -C attach-session -t <session>` (pipes — NOT -CC, which needs a TTY),
// parses the line protocol, serializes commands (FIFO, one outstanding), and
// surfaces %output as a snapshot-invalidation signal. Reconnects with backoff on
// EOF. Used as a private delegate of TmuxDriver behind JOY_TMUX_CONTROL.
//
// Protocol (verified live, tmux 3.4):
//   %begin <seconds> <command-number> <flags>
//   <response lines …>          (commands are NOT echoed; only their output)
//   %end|%error <seconds> <command-number> <flags>
//   %output <%pane-id> <data>   (async; never inside a block)
//   %session-changed / %window-* / %layout-change / %exit  (async notifications)
// On attach tmux emits ONE unsolicited %begin/%end (the implicit attach) before
// any command response — we use that to mark the client ready.
//
// See CONTROL-MODE-MIGRATION.md.
import { spawn, type ChildProcess } from "child_process";
import { run } from "./shell";
import type { TmuxResult } from "./driver";

/**
 * The `client-attached` hook the daemon installs. It sets `window-size latest` ONLY
 * for NON-control clients — so a real human `tmux attach` reclaims the size, but the
 * daemon's persistent CONTROL client attaching does NOT resize the app's manually
 * sized window. (`#{client_control_mode}` is 1 for a control client → the empty
 * true-branch runs; a human's is 0 → the resize runs.) Set BEFORE the control client
 * attaches so its own attach is already filtered.
 */
export const CLIENT_ATTACHED_HOOK = 'if -F "#{client_control_mode}" "" "setw window-size latest"';

/** Events the pure line-parser emits. The client correlates block-ends to commands. */
export type ControlEvent =
  | { type: "block-end"; ok: boolean; out: string }
  | { type: "output"; paneId: string }
  | { type: "exit" };

/**
 * Pure line-by-line parser for the control-mode protocol. No I/O — feed it stdout
 * lines, get events. Keeps NO command-queue knowledge; the client decides whether a
 * block-end resolves a pending command or is the unsolicited attach block.
 *
 * Correctness: a %begin opens a block keyed on its command-number; the block closes
 * ONLY on a %end/%error carrying that SAME number — because captured pane content can
 * itself contain lines that look like "%end 1 2 3".
 */
export class ControlParser {
  #inBlock = false;
  #num = "";
  #lines: string[] = [];
  #err = false;

  feed(line: string): ControlEvent[] {
    if (this.#inBlock) {
      const term = /^%(end|error) \d+ (\d+)\b/.exec(line);
      if (term && term[2] === this.#num) {
        const ev: ControlEvent = { type: "block-end", ok: term[1] === "end", out: this.#lines.join("\n") };
        this.#inBlock = false;
        this.#lines = [];
        this.#num = "";
        return [ev];
      }
      this.#lines.push(line); // ordinary block content (incl. %-looking pane text)
      return [];
    }
    const begin = /^%begin \d+ (\d+)\b/.exec(line);
    if (begin) { this.#inBlock = true; this.#num = begin[1]; this.#lines = []; return []; }
    const out = /^%output (%\d+) /.exec(line);
    if (out) return [{ type: "output", paneId: out[1] }];
    if (line.startsWith("%exit")) return [{ type: "exit" }];
    return []; // %session-changed / %window-* / %layout-change / etc. — ignored for now
  }
}

const RECONNECT_BACKOFF_MS = [250, 500, 1000, 2000, 5000];

type Pending = { resolve: (r: TmuxResult) => void };

export class TmuxControlClient {
  readonly #session: string;
  readonly #onOutput: (paneId: string) => void;
  #proc: ChildProcess | null = null;
  #parser = new ControlParser();
  #buf = "";
  // True one-active-command FIFO: at most ONE command is on the wire awaiting its
  // %end/%error (#active); everything else waits in #writeQueue. tmux processes
  // commands serially and emits %begin/%end in order, but writing them all at once
  // would let a single lost/extra block mis-pair every later response — so we write
  // the next only after the current one resolves. Commands issued before the attach
  // block (or while reconnecting) simply wait in the queue until #ready.
  #writeQueue: Array<{ cmd: string; p: Pending }> = [];
  #active: Pending | null = null; // the single command currently on the wire
  #ready = false;                 // seen the initial attach block yet?
  #attempt = 0;
  #stopped = false;

  constructor(session: string, opts: { onOutput?: (paneId: string) => void } = {}) {
    this.#session = session;
    this.#onOutput = opts.onOutput ?? (() => {});
    this.#connect();
  }

  get connected(): boolean { return this.#ready && this.#proc !== null; }

  #connect(): void {
    if (this.#stopped) return;
    this.#ready = false;
    this.#parser = new ControlParser();
    this.#buf = "";
    // Filter the client-attached hook BEFORE we attach, so our own control attach
    // doesn't resize the window. Harmless if the session doesn't exist yet (the
    // attach below then fails → reconnect once the registry has created it).
    run("tmux", "set-hook", "-t", this.#session, "client-attached", CLIENT_ATTACHED_HOOK);
    let proc: ChildProcess;
    try {
      proc = spawn("tmux", ["-C", "attach-session", "-t", this.#session], { stdio: ["pipe", "pipe", "ignore"] });
    } catch {
      this.#scheduleReconnect();
      return;
    }
    this.#proc = proc;
    proc.stdout?.setEncoding("utf8");
    proc.stdout?.on("data", (chunk: string) => this.#onData(chunk));
    proc.once("exit", () => this.#onExit());
    proc.once("error", () => this.#onExit());
    // Stream write errors (EPIPE, etc.) can surface ASYNCHRONOUSLY on stdin — without a
    // listener that's an unhandled 'error' that crashes the process, and it also leaves
    // command() promises hanging. Funnel it to #onExit (which fails active+queued and
    // reconnects), completing the resolve-only guarantee the #pump try/catch starts.
    proc.stdin?.on("error", () => this.#onExit());
  }

  #onData(chunk: string): void {
    this.#buf += chunk;
    let nl: number;
    while ((nl = this.#buf.indexOf("\n")) >= 0) {
      const line = this.#buf.slice(0, nl);
      this.#buf = this.#buf.slice(nl + 1);
      for (const ev of this.#parser.feed(line)) this.#handle(ev);
    }
  }

  #handle(ev: ControlEvent): void {
    if (ev.type === "output") { this.#onOutput(ev.paneId); return; }
    if (ev.type === "exit") { this.#onExit(); return; }
    // block-end: the response to the one active command, else the attach block.
    const active = this.#active;
    if (active) {
      this.#active = null;
      active.resolve({ ok: ev.ok, out: ev.out, error: ev.ok ? undefined : ev.out });
      this.#pump();
      return;
    }
    if (!this.#ready) {
      this.#ready = true;
      this.#attempt = 0;
      this.#pump(); // attach done → start draining anything queued meanwhile
    }
    // else: an unsolicited block with nothing active — ignore.
  }

  // Write the next queued command iff nothing is in flight and we're attached.
  #pump(): void {
    if (this.#active || !this.#ready || this.#writeQueue.length === 0) return;
    if (!this.#proc?.stdin?.writable) {
      for (const { p } of this.#writeQueue.splice(0)) p.resolve({ ok: false, out: "", error: "disconnected" });
      return;
    }
    const next = this.#writeQueue.shift()!;
    this.#active = next.p;
    try {
      this.#proc.stdin.write(next.cmd + "\n");
    } catch {
      // The write threw (EPIPE on a dying pipe). Resolve this command as disconnected
      // so command() stays RESOLVE-ONLY — a fire-and-forget `void tmux.key(...)` must
      // never surface an unhandledRejection — THEN treat it as a disconnect directly:
      // a sync write throw may not be followed by a stdin/proc 'error' event, so we
      // can't rely on that to drain the queue + reconnect, or queued commands would
      // hang. #onExit fails the rest and schedules the reconnect (its guard makes the
      // later real exit event a no-op).
      this.#active = null;
      next.p.resolve({ ok: false, out: "", error: "disconnected" });
      this.#onExit();
    }
  }

  /** Run a tmux command, await its framed response. One command on the wire at a time; buffered until ready. */
  command(cmd: string): Promise<TmuxResult> {
    if (this.#stopped) return Promise.resolve({ ok: false, out: "", error: "stopped" });
    return new Promise<TmuxResult>((resolve) => {
      this.#writeQueue.push({ cmd, p: { resolve } });
      this.#pump();
    });
  }

  #onExit(): void {
    const proc = this.#proc;
    if (!proc) return; // already torn down — the exit/error/stdin-error listeners can
                       // all fire for one proc; without this we'd schedule N reconnects
                       // (→ N control clients). First call wins; the rest no-op.
    this.#proc = null;
    proc.removeAllListeners();
    proc.stdin?.removeAllListeners();
    // Kill the abandoned client. On the normal exit path it's already dead (no-op);
    // on the SYNTHETIC path (a sync write threw but the process may still be alive)
    // this stops the old `tmux -C` from lingering as an orphan.
    try { proc.stdin?.destroy(); } catch { /* ignore */ }
    try { proc.kill(); } catch { /* ignore */ }
    this.#ready = false;
    // Fail the in-flight + every queued command so awaiters fall back instead of hanging.
    if (this.#active) { this.#active.resolve({ ok: false, out: "", error: "disconnected" }); this.#active = null; }
    for (const { p } of this.#writeQueue.splice(0)) p.resolve({ ok: false, out: "", error: "disconnected" });
    this.#scheduleReconnect();
  }

  #scheduleReconnect(): void {
    if (this.#stopped) return;
    const base = RECONNECT_BACKOFF_MS[Math.min(this.#attempt, RECONNECT_BACKOFF_MS.length - 1)];
    this.#attempt += 1;
    const jitter = Math.floor((Date.now() % 100)); // event-loop-derived; avoids Math.random in tests
    setTimeout(() => this.#connect(), base + jitter).unref?.();
  }

  stop(): void {
    this.#stopped = true;
    const proc = this.#proc;
    this.#proc = null;
    proc?.removeAllListeners();
    try { proc?.stdin?.end(); } catch { /* ignore */ }
    try { proc?.kill(); } catch { /* ignore */ }
    if (this.#active) { this.#active.resolve({ ok: false, out: "", error: "stopped" }); this.#active = null; }
    for (const { p } of this.#writeQueue.splice(0)) p.resolve({ ok: false, out: "", error: "stopped" });
  }
}
