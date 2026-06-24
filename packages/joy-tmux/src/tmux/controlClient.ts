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
  #queue: Pending[] = [];        // FIFO of awaited commands (serial)
  #ready = false;                // seen the initial attach block yet?
  #preReady: Array<{ cmd: string; p: Pending }> = []; // commands issued before ready
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
    // block-end: resolve the head pending command, or mark ready (the attach block).
    const p = this.#queue.shift();
    if (p) { p.resolve({ ok: ev.ok, out: ev.out, error: ev.ok ? undefined : ev.out }); return; }
    if (!this.#ready) {
      this.#ready = true;
      this.#attempt = 0;
      for (const { cmd, p: pp } of this.#preReady.splice(0)) this.#write(cmd, pp);
    }
    // else: an unsolicited block with nothing pending — ignore.
  }

  #write(cmd: string, p: Pending): void {
    if (!this.#proc?.stdin?.writable) { p.resolve({ ok: false, out: "", error: "disconnected" }); return; }
    this.#queue.push(p);
    this.#proc.stdin.write(cmd + "\n");
  }

  /** Run a tmux command, await its framed response. Serialized FIFO; buffered until ready. */
  command(cmd: string): Promise<TmuxResult> {
    if (this.#stopped) return Promise.resolve({ ok: false, out: "", error: "stopped" });
    return new Promise<TmuxResult>((resolve) => {
      const p: Pending = { resolve };
      if (!this.#ready) this.#preReady.push({ cmd, p });
      else this.#write(cmd, p);
    });
  }

  #onExit(): void {
    const proc = this.#proc;
    this.#proc = null;
    proc?.removeAllListeners();
    this.#ready = false;
    // Fail every in-flight + queued command so awaiters fall back instead of hanging.
    for (const p of this.#queue.splice(0)) p.resolve({ ok: false, out: "", error: "disconnected" });
    for (const { p } of this.#preReady.splice(0)) p.resolve({ ok: false, out: "", error: "disconnected" });
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
    for (const p of this.#queue.splice(0)) p.resolve({ ok: false, out: "", error: "stopped" });
    for (const { p } of this.#preReady.splice(0)) p.resolve({ ok: false, out: "", error: "stopped" });
  }
}
