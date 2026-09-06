// AgySession — adapter for Google's Antigravity CLI (`agy`), driven headless:
// ONE `agy --print --output-format stream-json` process PER TURN, against a
// persistent conversation (`--conversation <id>`; the id arrives in the first
// turn's `init` event and is persisted in the window record).
//
// Why per-turn rather than a long-lived TUI in a tmux pane: the headless
// stream is a clean protocol — `init` (conversation id, tools), `step_update`
// (user_input | agent_response with text_delta | tool with name/parameters/
// output, each ACTIVE→DONE), `result` (status, usage) — so there is nothing to
// scrape, and with no resident process a session survives daemon restarts
// for free: the next prompt just resumes the conversation. (Probed live
// 2026-09-03 on agy 1.0.12: docs/plans has the captured stream.)
//
// The daemon owns the queue (the session coordinator: one prompt in flight,
// the rest FIFO), so edit / cancel / reorder work for real; this session is
// the agy DRIVER (agyDriver.ts): a submission spawns the turn's process. `--add-dir <cwd>` is REQUIRED: without it a
// headless run treats the folder as untrusted and writes land in agy's own
// scratch dir (~/.gemini/antigravity-cli/scratch) instead of the repo.
// Permissions: `--dangerously-skip-permissions` — the daemon's bypass default;
// a headless agy cannot prompt anyway (it soft-denies and carries on).
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { daemonFilePath } from "../claude/hooks";

import {
  createRelaySession, encodeUserMessage, encodeTurnEnd,
  encodeTurnStart, encodeTextEvent, encodeToolCallStart, encodeToolCallEnd,
  type RelaySession,
} from "../relay/relay";
import type { AgentSession } from "../domain/agentSession";
import { ledgerFor, type Ledger } from "../domain/ledger";
import { coordinatorFor, type SessionCoordinator, type CommandView, type HandledCommand, type AttemptRef } from "../domain/coordinator";
import { AgyDriver, type AgyRuntimePort } from "./agyDriver";
import type { SessionStatus, SessionRecord, SessionDeps } from "../claude/session";
import { saveWindowRecord, deleteWindowRecord, loadWindowRecord } from "../domain/windowRecord";
import { titleFromPrompt } from "../opencode/opencodeSession";
import { joyPromptReinjection } from "../domain/agentTagsPrompt";

export interface AgyInit {
  id: string;
  cwd: string;
  /** `agy --model` — a display name from `agy models` (see src/agy/models.ts). */
  model?: string;
  status: SessionStatus;
  startedAt: number;
  /** Antigravity conversation id: resume it. Absent = the first turn creates one. */
  conversationId?: string;
  /** `agy --continue`: resume the CLI's most recent conversation (id unknown yet). */
  continueLast?: boolean;
}

/** The `agySettings` blob as THIS adapter writes it. `continueLast` (#468)
 *  and `title` (#469) ride beside the fields windowRecord.ts declares: its
 *  type has neither yet (out of this fix's scope), and saveWindowRecord
 *  stores the object as given, so both survive a daemon/session restart. */
interface AgySettingsRecord { model?: string; conversationId?: string; continueLast?: boolean; title?: string }

/** One wire event from `--output-format stream-json`. */
interface AgyEvent {
  event?: string;
  conversation_id?: string;
  init?: { cwd?: string; tools?: string[] };
  step_update?: {
    conversation_id?: string; step_index?: number;
    state?: "ACTIVE" | "DONE" | string;
    step_type?: "user_input" | "agent_response" | "tool" | string;
    text_delta?: string; tool_name?: string;
    tool_info?: { name?: string; parameters?: unknown; output?: unknown };
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  result?: { conversation_id?: string; status?: string; response?: string; usage?: { input_tokens?: number; output_tokens?: number } };
}

const PRINT_TIMEOUT = "30m";

/** One turn's execution: the child, its wire turn id and every piece of
 *  per-turn parser state, so handlers bind to the run they belong to (#466). */
interface AgyRun {
  turn: string;
  proc: ChildProcess | null;
  /** The stream announced its own end (`result`), or abort/end pre-empted it. */
  sawResult: boolean;
  /** The turn-end row went out (exactly once). */
  turnEnded: boolean;
  /** Exit observed (code null = signal). */
  exit: { code: number | null } | null;
  /** stdout reached EOF and readline emitted every line. */
  stdoutDone: boolean;
  /** Settled: the coordinator was told (or the run was retired). */
  finalized: boolean;
  /** The ledger command this run executes, and the attempt the spawn made. */
  commandId: string;
  attemptId: string;
  /** abort()/end() pre-empted the run: its terminal is `cancelled`. */
  cancelled: boolean;
  // agent_response text arrives as deltas per step_index; emitted once per
  // step at DONE (one clean row per response, not a re-render storm).
  textByStep: Map<number, string>;
}

export class AgySession implements AgentSession {
  readonly agentFlavor = "agy" as const;
  readonly id: string;
  readonly cwd: string;
  readonly model?: string;
  readonly effort?: string = undefined;
  status: SessionStatus;
  endReason?: string;
  claudeSessionId?: string = undefined;
  transcriptPath?: string = undefined;
  relaySessionId?: string;
  summary?: string;
  currentModel?: string;
  pid?: number;
  readonly tmuxWindow = ""; // headless — no pane

  #conversationId: string | undefined;
  #continueLast: boolean;
  #startedAt: number;
  #deps: SessionDeps;
  #relay: RelaySession | null = null;
  #started = false;
  #archivePromise: Promise<boolean> | null = null;

  // The queue is the coordinator's: one prompt in flight, the rest waiting
  // in order as ledger rows (accepted = committed; a restart's replacement
  // takes them, #49).
  #ledger: Ledger;
  #generation: number;
  #coordinator: SessionCoordinator;
  #driver: AgyDriver;
  #unsubscribeQueue: () => void = () => {};
  #proc: ChildProcess | null = null;
  /** The process end() sent SIGTERM to, for awaitExit. */
  #dying: ChildProcess | null = null;
  #turnSeq = 0;
  // Per-boot nonce in every record id: a recovered session restarts #turnSeq
  // at 0, and the relay dedupes by runtime event id — so "t1" again would
  // be swallowed as a replay (codex review, 2026-09-04).
  readonly #boot = randomUUID().slice(0, 8);
  // The turn currently being run: its process, its wire turn id and its
  // per-turn parser state, as ONE object every handler closes over (#466).
  // Handlers used to read shared `#turn` / `#sawResult` / `#textByStep`
  // fields, so events still draining out of child 1's stdout after its `exit`
  // fired were applied to turn 2 (its answer landed on the wrong turn, its
  // `result` closed the wrong turn, and the real second answer was dropped).
  #run: AgyRun | null = null;
  #titled = false;
  #titleLocked = false;

  constructor(init: AgyInit, deps: SessionDeps) {
    this.id = init.id;
    this.cwd = init.cwd;
    this.model = init.model;
    this.currentModel = init.model;
    this.#conversationId = init.conversationId;
    const rec = loadWindowRecord(init.id);
    const saved = rec?.agySettings as AgySettingsRecord | undefined;
    // A restart before the first prompt used to forget `--continue` (#468):
    // only model + conversationId were persisted, so the replacement launched
    // a FRESH conversation instead of the CLI's most recent one. The pending
    // flag is restored until a concrete conversation id has been learned.
    this.#continueLast = init.continueLast === true || (!init.conversationId && saved?.continueLast === true);
    this.status = init.status;
    this.#startedAt = init.startedAt;
    this.#deps = deps;
    this.#titleLocked = rec?.titleLockedByUser === true;
    // The lock survived restarts but the title it protected did not (#469):
    // the replacement card came up untitled AND #maybeTitle refused to fill
    // it. Restore the persisted title together with its lock.
    if (this.#titleLocked && saved?.title) this.summary = saved.title;
    // A new generation: rows queued for a previous one are still ours; a
    // turn it had in flight (one process per turn — it died with the daemon)
    // is an explicit unknown, re-run at-least-once.
    this.#ledger = deps.ledger ?? ledgerFor();
    this.#generation = this.#ledger.openGeneration(init.id, "agy");
    this.#coordinator = deps.coordinator ?? coordinatorFor(this.#ledger);
    this.#driver = new AgyDriver(this.#runtimePort(), this.#generation);
    this.#coordinator.adopt(this.id, this.#driver);
    this.#unsubscribeQueue = this.#coordinator.subscribe((ev) => {
      if (ev.type !== "session" && ev.type !== "command") return;
      if (ev.sessionId !== this.id || !this.#relay) return;
      void this.#relay.updateQueue(this.#coordinator.snapshot(this.id));
    });
    const restored = this.status !== "ended" ? this.#ledger.listPending(init.id).length : 0;
    if (restored) process.stderr.write(`[agy ${this.id}] ${restored} prompt(s) from the ledger await this generation\n`);
  }

  #runtimePort(): AgyRuntimePort {
    return {
      sessionId: this.id,
      startTurn: (text, attempt) => this.#startTurn(text, attempt),
      abortTurn: (turn) => this.#abortTurn(turn),
      handleCommand: (text, opts) => this.#handleCommand(text, opts),
      mirrorAccepted: (cmd) => this.#mirrorAccepted(cmd),
    };
  }

  /** Test/diagnostic access to the session's ledger generation. */
  get ledgerGeneration(): number { return this.#generation; }
  get coordinator(): SessionCoordinator { return this.#coordinator; }

  get relayAttached(): boolean { return this.#relay !== null; }
  get conversationId(): string | undefined { return this.#conversationId; }

  // ── lifecycle ──────────────────────────────────────────────────────────────

  attachRelay(rs: RelaySession, allowEnded = false): boolean {
    if (this.status === "ended" && !allowEnded) return false;
    this.#relay = rs;
    this.relaySessionId = rs.relaySessionId;
    if (this.status === "ended") rs.pausePull();
    rs.setReceiptSink(() => { /* localId dedupe covers exactly-once */ });
    this.#deps.onRelayAttached?.(this, rs);
    rs.start();
    void rs.updateJoyState(this.status === "ended" ? "detached" : "running");
    if (this.currentModel) void rs.updateModelCode(this.currentModel);
    // createRelaySession builds the card's metadata without a summary: a
    // /title restored from the record must be pushed onto the new card (#469).
    if (this.summary) void rs.updateSummary(this.summary);
    return true;
  }

  /** No resident process: "watching" just means the session is live and the
   *  queue will drain. Idempotent. */
  beginWatching(): void {
    if (this.#started) return;
    this.#started = true;
    if (this.status === "starting") this.status = "active";
    this.#persistRecord();
    this.#deps.broadcast("session_update", this.toJSON());
    // Live: the coordinator re-runs what a previous daemon left in flight
    // (one process per turn — it died with it) and pumps the queued rows.
    this.#driver.emit({ kind: "ready" });
  }

  #persistRecord(): void {
    if (this.status === "ended") return; // a retired/killed generation must not recreate a deleted record (#52)
    const agySettings: AgySettingsRecord = {
      model: this.currentModel ?? this.model,
      conversationId: this.#conversationId,
      // Only while no id is known: once `init` names the conversation the
      // flag is spent and `--conversation` takes over (#468).
      continueLast: this.#continueLast && !this.#conversationId ? true : undefined,
      // Only the user's explicit title is worth keeping; a prompt-derived one
      // is recomputed on the next prompt anyway (#469).
      title: this.#titleLocked && this.summary ? this.summary : undefined,
    };
    saveWindowRecord(this.id, { launchCwd: this.cwd, agent: "agy", agySettings });
  }

  // ── one process per turn ───────────────────────────────────────────────────

  /** Spawn the turn's process for a submission and hand it the prompt. The
   *  coordinator committed the attempt BEFORE this call (a crash between the
   *  spawn and the result is an explicit unknown the next generation
   *  re-runs); the process taking the prompt is the delivery. */
  #startTurn(text: string, attempt: AttemptRef): { ok: true; turn: string } | { ok: false; error: string } {
    if (this.status === "ended") return { ok: false, error: "session ended" };
    if (this.#run) return { ok: false, error: `turn ${this.#run.turn} is still running` };
    const turn = `agy:${this.id}:${this.#boot}:t${++this.#turnSeq}`;
    // The prompt goes over stdin, not argv (#56): argv is readable by every
    // local uid via /proc/<pid>/cmdline for the whole turn (prompts carry
    // pasted secrets, handoff notes, joy-messages from other sessions), and a
    // single argument over Linux's MAX_ARG_STRLEN (128 KiB) failed the spawn
    // with E2BIG — and #drain then failed every queued prompt behind it the
    // same way. agy 1.0.12 has no `--print -` / `--input-file`; what it has is
    // `--input-format stream-json`: one NDJSON `{"event":"user","message":
    // {"role":"user","content":…}}` per stdin line runs one turn, and stdin
    // EOF ends the process after it (probed live 2026-09-06). `--print` is a
    // string flag, so it is passed empty. No temp file: nothing hits disk.
    const args = [
      "--print", "",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--dangerously-skip-permissions",
      "--add-dir", this.cwd,
      "--print-timeout", PRINT_TIMEOUT,
    ];
    if (this.#conversationId) args.push("--conversation", this.#conversationId);
    else if (this.#continueLast) args.push("--continue");
    const model = this.currentModel ?? this.model;
    if (model) args.push("--model", model);

    const run: AgyRun = { turn, proc: null, sawResult: false, turnEnded: false, exit: null, stdoutDone: false, finalized: false, textByStep: new Map(), commandId: attempt.commandId, attemptId: attempt.attemptId, cancelled: false };
    this.#run = run;
    this.#relay?.send(encodeTurnStart({ turn }), `${turn}:start`);
    this.#relay?.setThinking(true);

    let proc: ChildProcess;
    try {
      // JOY_SESSION_ID is how the joy CLI knows WHO is talking: without it a
      // `joy send` from inside this session was stamped "cli". Same two
      // variables the claude launch line exports.
      proc = spawn("agy", args, { cwd: this.cwd, env: { ...process.env, JOY_SESSION_ID: this.id, JOY_DAEMON_FILE: daemonFilePath() }, stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      // Nothing ran: the turn ends failed on the wire and the submission is
      // a permanent rejection (the row fails instead of reading as delivered).
      run.finalized = true; run.turnEnded = true;
      this.#run = null;
      this.#relay?.send(encodeTurnEnd("failed", { turn }), `${turn}:end`);
      this.#relay?.setThinking(false);
      return { ok: false, error: `spawn failed: ${e}` };
    }
    run.proc = proc;
    this.#proc = proc;
    this.pid = proc.pid;
    proc.stderr?.on("data", (c: Buffer) => {
      const s = String(c).trim();
      if (s) process.stderr.write(`[agy ${this.id}] ${s.slice(0, 500)}\n`);
    });
    // Every handler below is bound to THIS run (#466): a line from this child's
    // stdout is applied to this turn even if it drains after `exit` fired and
    // another turn has since started.
    const rl = createInterface({ input: proc.stdout! });
    rl.on("line", (line) => {
      if (!line.trim()) return;
      try { this.#onEvent(run, JSON.parse(line) as AgyEvent); }
      catch { process.stderr.write(`[agy ${this.id}] unparseable event: ${line.slice(0, 200)}\n`); }
    });
    // The queue advances only once BOTH the exit status is known AND stdout is
    // fully consumed (readline 'close' = EOF reached and every line emitted).
    // `exit` alone is too early: Node delivers it while the pipe can still hold
    // unread events, which is exactly the window the misattribution lived in.
    rl.on("close", () => { run.stdoutDone = true; this.#maybeFinalize(run); });
    proc.on("error", (e) => {
      // Spawn/kill failure: there may never be an exit, and stdout may never
      // open — settle now. Idempotent, so a later exit/close is harmless.
      process.stderr.write(`[agy ${this.id}] process error: ${e}\n`);
      this.#finalize(run, "failed", String(e));
    });
    proc.on("exit", (code) => { run.exit = { code }; this.#maybeFinalize(run); });
    // EPIPE (agy died before reading its prompt) must not become an uncaught
    // exception that takes the daemon down; exit/close settle the run.
    proc.stdin?.on("error", (e) => process.stderr.write(`[agy ${this.id}] stdin error: ${e instanceof Error ? e.message : e}\n`));
    proc.stdin?.end(JSON.stringify({ event: "user", message: { role: "user", content: text } }) + "\n");
    // The prompt is with the harness: delivered (the driver reports the
    // echo). Its RESULT is the turn's outcome — #finalize reports it.
    return { ok: true, turn };
  }

  /** Kill the named turn's process (or the current one): the run settles as
   *  cancelled once its exit and stdout EOF arrive (#466) — the coordinator
   *  waits for that terminal before the next turn may start. */
  #abortTurn(turn: string | null): "sent" | "noop" {
    const run = this.#run;
    const proc = run?.proc;
    if (!run || !proc || proc.exitCode !== null) return "noop";
    if (turn && run.turn !== turn) return "noop";
    run.sawResult = true; // the exit handler must not report "failed"
    run.cancelled = true;
    try { proc.kill("SIGTERM"); } catch { /* gone */ }
    this.#endTurn(run, "cancelled");
    return "sent";
  }

  /** Settle a run once its exit status AND its stdout EOF have both arrived. */
  #maybeFinalize(run: AgyRun): void {
    if (!run.exit || !run.stdoutDone) return;
    const code = run.exit.code;
    // A clean run already ended the turn on `result`; anything else is a
    // failure the stream did not announce (killed, crashed, timed out).
    if (!run.sawResult) this.#finalize(run, code === 0 ? "completed" : "failed", code === null ? "terminated" : `exit ${code}`);
    else this.#finalize(run, "completed", "");
  }

  #onEvent(run: AgyRun, e: AgyEvent): void {
    if (run.finalized) return; // a settled run's stragglers touch nothing
    const turn = run.turn;
    switch (e.event) {
      case "init": {
        const cid = e.conversation_id;
        if (cid && cid !== this.#conversationId) {
          this.#conversationId = cid;
          this.#continueLast = false;
          this.#persistRecord();
        }
        break;
      }
      case "step_update": {
        const s = e.step_update;
        if (!s) break;
        const idx = typeof s.step_index === "number" ? s.step_index : -1;
        if (s.step_type === "agent_response") {
          if (typeof s.text_delta === "string" && s.text_delta) {
            run.textByStep.set(idx, (run.textByStep.get(idx) ?? "") + s.text_delta);
          }
          if (s.state === "DONE") {
            const text = (run.textByStep.get(idx) ?? "").trim();
            run.textByStep.delete(idx);
            if (text) {
              this.#relay?.send(encodeTextEvent(text, { turn }), `${turn}:text:${idx}`);
              this.#deps.addChatMessage({ role: "assistant", content: text, source: "cli", session_id: this.id });
            }
            const u = s.usage;
            if (u && (u.input_tokens ?? 0) > 0) void this.#relay?.updateContext(u.input_tokens ?? 0);
          }
        } else if (s.step_type === "tool") {
          const call = `${turn}:tool:${idx}`;
          const name = s.tool_info?.name ?? s.tool_name ?? "tool";
          if (s.state === "ACTIVE") {
            this.#relay?.send(encodeToolCallStart({ call, name, input: s.tool_info?.parameters ?? null, turn }), `${call}:start`);
          } else if (s.state === "DONE") {
            const out = s.tool_info?.output;
            const result = out == null ? undefined : typeof out === "string" ? out : JSON.stringify(out, null, 2);
            this.#relay?.send(encodeToolCallEnd(call, { turn, result: result?.slice(0, 48_000) }), `${call}:end`);
          }
        }
        break;
      }
      case "result": {
        run.sawResult = true;
        const r = e.result;
        if (r?.conversation_id && r.conversation_id !== this.#conversationId) {
          this.#conversationId = r.conversation_id;
          this.#persistRecord();
        }
        // The stream may end the last agent_response step only implicitly;
        // #endTurn flushes whatever is still buffered (#467).
        const u = r?.usage;
        if (u && (u.input_tokens ?? 0) > 0) void this.#relay?.updateContext(u.input_tokens ?? 0);
        this.#endTurn(run, r?.status === "SUCCESS" ? "completed" : "failed");
        break;
      }
      default: break;
    }
  }

  /** Publish any agent_response text still buffered for a run — to the relay
   *  AND the local chat log — deleting each entry so it goes out exactly once.
   *  Runs before EVERY turn end (#467): a crash, timeout, cancel or kill used
   *  to drop text the daemon had already received, and the next run's fresh
   *  map made it unrecoverable — only the failure notice reached either sink. */
  #flushText(run: AgyRun): void {
    for (const [idx, buf] of run.textByStep) {
      const text = buf.trim();
      if (!text) continue;
      this.#relay?.send(encodeTextEvent(text, { turn: run.turn }), `${run.turn}:text:${idx}`);
      this.#deps.addChatMessage({ role: "assistant", content: text, source: "cli", session_id: this.id });
    }
    run.textByStep.clear();
  }

  /** Emit the turn-end row for a run exactly once. */
  #endTurn(run: AgyRun, status: "completed" | "failed" | "cancelled"): void {
    if (run.turnEnded) return;
    run.turnEnded = true;
    this.#flushText(run); // received text precedes the end row, whatever the status (#467)
    this.#relay?.send(encodeTurnEnd(status, { turn: run.turn }), `${run.turn}:end`);
  }

  /** Terminal settlement of a run — IDEMPOTENT (#466): exit, stdout close and
   *  a process error can each arrive, in any order, and only the first one
   *  settles the run. Ends the turn (if the stream did not), and advances the
   *  queue only when this run is still the session's current one. */
  #finalize(run: AgyRun, status: "completed" | "failed", why: string): void {
    if (run.finalized) return;
    run.finalized = true;
    if (status === "failed" && !run.turnEnded) {
      this.#flushText(run); // what was generated, then why it stopped (#467)
      process.stderr.write(`[agy ${this.id}] turn failed: ${why}\n`);
      this.#relay?.send(encodeUserMessage(`⚠ agy: ${why}`, Date.now()));
    }
    this.#endTurn(run, status);
    if (this.#run !== run) return; // retired by end() / superseded — not ours to settle
    this.#run = null;
    this.#proc = null;
    this.#relay?.setThinking(false);
    this.#deps.broadcast("session_update", this.toJSON());
    // The run's settlement IS the command's terminal: the coordinator ends
    // the command that rode this turn and starts the next one.
    this.#driver.emit({ kind: "turn_ended", runtimeTurnId: run.turn, status: run.cancelled ? "cancelled" : status, detail: why || undefined });
  }

  // ── AgentSession surface ───────────────────────────────────────────────────

  busy(): boolean { return this.#run !== null || this.#coordinator.busy(this.id); }

  /** Joy-owned slash commands the harness executes itself; the coordinator
   *  completes their row at accept time.
   *   - /title: joy-level, never forwarded; the title is persisted with its lock (#469);
   *   - /joy-prompt: re-deliver the current joy instructions in-band (agy has
   *     no launch-time preamble; this is how it learns the tag vocabulary). */
  #handleCommand(text: string, opts: { source: string; mirrorToRelay: boolean; seq?: number | null }): HandledCommand | null {
    const at = Date.now();
    const mirror = opts.mirrorToRelay && this.#relay;
    const localId = `agy:in:${this.id}:${opts.seq ?? at}`;
    const titleCmd = /^\/title(?:\s+(.*))?$/s.exec(text.trim());
    if (titleCmd) {
      const t = (titleCmd[1] ?? "").trim();
      this.#titleLocked = !!t;
      saveWindowRecord(this.id, { launchCwd: this.cwd, titleLockedByUser: !!t });
      if (t) { this.summary = t; void this.#relay?.updateSummary(t); }
      this.#persistRecord(); // the title is persisted with its lock (#469)
      this.#deps.broadcast("session_update", this.toJSON());
      if (mirror) this.#relay!.send(encodeUserMessage(text, at), localId);
      return { handled: true };
    }
    if (/^\/joy-prompt(?:\s|$)/.test(text.trim())) {
      if (mirror) this.#relay!.send(encodeUserMessage(text, at), localId);
      return { handled: true, reinjection: joyPromptReinjection() };
    }
    return null;
  }

  #mirrorAccepted(cmd: CommandView): void {
    if (cmd.mirrorToRelay && this.#relay) this.#relay.send(encodeUserMessage(cmd.text, cmd.createdAt), `agy:in:${this.id}:${cmd.seq ?? cmd.id}`);
    this.#maybeTitle(cmd.text);
  }

  #maybeTitle(text: string): void {
    if (this.#titled || this.#titleLocked || !this.#relay) return;
    this.#titled = true;
    const title = titleFromPrompt(text);
    if (title) { this.summary = title; void this.#relay.updateSummary(title); }
  }

  /** Stop the running turn: its command is cancelled durably and the
   *  process killed; the coordinator confirms the cancel when the run
   *  settles (exit + stdout EOF). */
  async abort(): Promise<{ ok: boolean; error?: string }> {
    return this.#coordinator.abortRunning(this.id);
  }

  // No tmux window: pane surface degrades gracefully (pi/opencode precedent).
  async pane(): Promise<{ ok: true; text: string }> { return { ok: true, text: "(antigravity session — headless, no terminal pane)" }; }
  async resize(): Promise<{ ok: boolean }> { return { ok: true }; }
  async sendRawKeys(): Promise<{ ok: boolean; segments: number; error?: string }> { return { ok: false, segments: 0, error: "no pane for antigravity sessions" }; }
  detectPermissionMode(): string | null { return "bypassPermissions"; }
  async setPermissionMode(): Promise<{ ok: boolean; mode?: string; error?: string }> { return { ok: false, error: "antigravity runs headless with permissions skipped" }; }
  transcript(): { lines: unknown[] } { return { lines: [] }; }
  onHookEvent(): { ok: boolean } { return { ok: true }; }
  cardMetadata(): Record<string, unknown> | null { return this.#relay?.metadataSnapshot ?? null; }
  setV2Link(link: { sessionId: string; relay: string; keyEnvelope: string }): void {
    void this.#relay?.mergeMetadata({ v2: { ...link, localSessionId: this.id } });
  }
  setHandoff(info: import("../relay/relay").JoyHandoffInfo | null): void { saveWindowRecord(this.id, { handoff: info }); void this.#relay?.updateHandoff(info); }
  markCompacting(): void { /* agy manages its own context */ }

  // ── teardown ──────────────────────────────────────────────────────────────


  /** Resolve once the process end() signalled is gone (SIGKILL after `ms`).
   *  The restart replacement reopens the SAME on-disk conversation; two
   *  writers on it is how history gets corrupted (codex review, 2026-09-04). */
  awaitExit(ms = 3000): Promise<void> {
    const p = this.#dying;
    if (!p || p.exitCode !== null || p.signalCode !== null) return Promise.resolve();
    return new Promise((resolve) => {
      const t = setTimeout(() => { try { p.kill("SIGKILL"); } catch { /* gone */ } resolve(); }, ms);
      p.once("exit", () => { clearTimeout(t); resolve(); });
    });
  }

  end(reason: "killed" | "process_exited" | "restart"): boolean {
    if (this.status === "ended") return false;
    this.status = "ended";
    this.endReason = reason;
    const run = this.#run;
    if (run && this.#proc && this.#proc.exitCode === null) {
      run.sawResult = true;
      this.#dying = this.#proc;
      try { this.#proc.kill("SIGTERM"); } catch { /* already gone */ }
    }
    this.#proc = null;
    if (run) { this.#endTurn(run, "cancelled"); run.finalized = true; } // stragglers from the dying child are rejected by #onEvent
    this.#run = null; // whatever the dying child still emits is not ours (#466; Astra on ddc89de1: clearing #run alone let a drained answer reach the ended session)
    // Queued rows survive a restart / process exit for the replacement (#49);
    // a kill interrupts them. The coordinator settles the in-flight run's row.
    this.#unsubscribeQueue();
    this.#coordinator.retire(this.id, reason);
    this.#relay?.setThinking(false);
    if (reason === "process_exited") {
      void this.#relay?.updateJoyState("detached");
      this.#relay?.pausePull();
    } else {
      if (this.#relay && reason !== "restart") this.#archivePromise = this.#relay.archive(); // restart keeps the card
      this.#relay?.stop();
      if (reason !== "restart") this.#recordTerminated = deleteWindowRecord(this.id);
    }
    this.#deps.broadcast("session_update", this.toJSON());
    return true;
  }

  /** #567 residual: false once an intentional kill could NOT durably commit a
   *  termination marker (the record's unlink AND its tombstone both refused).
   *  The kill op reports that instead of ok — a restart would otherwise
   *  recover the "killed" session — and the delete is retried on every record
   *  scan and on the next kill of this id. */
  #recordTerminated = true;
  recordTerminated(): boolean { return this.#recordTerminated; }

  forceKill(): boolean {
    if (this.status === "ended") {
      // A detached session killed on purpose: archive, stop the relay, mark
      // killed and delete the record — otherwise recovery resurrected it
      // (Astra on 2f803b14, #43).
      if (this.#relay) { this.#archivePromise = this.#relay.archive(); this.#relay.stop(); this.#relay = null; }
      this.endReason = "killed";
      this.#recordTerminated = deleteWindowRecord(this.id);
      this.#coordinator.retire(this.id, "killed");
      this.#deps.broadcast("session_update", this.toJSON());
      return true;
    }
    return this.end("killed");
  }

  async awaitArchive(): Promise<boolean> {
    return this.#archivePromise ? await this.#archivePromise : true;
  }

  toJSON(): SessionRecord {
    return {
      id: this.id,
      agent: this.agentFlavor,
      current_model: this.currentModel,
      pid: this.pid,
      tmux_window: this.tmuxWindow,
      cwd: this.cwd,
      model: this.model,
      effort: this.effort,
      flags: [],
      status: this.status,
      started_at: this.#startedAt,
      last_active_at: Date.now(),
      end_reason: this.endReason,
      transcript_path: this.transcriptPath,
      relay_session_id: this.relaySessionId,
      summary: this.summary,
      busy: this.busy(),
    };
  }

  async createAndAttachRelay(): Promise<void> {
    if (!this.#deps.relayClient) return;
    const rs = await createRelaySession(this.#deps.relayClient, { tag: `joy-daemon-${this.id}`, cwd: this.cwd, id: this.id, flavor: "agy" });
    this.attachRelay(rs);
  }
}
