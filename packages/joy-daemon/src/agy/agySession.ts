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
// The daemon owns the queue (one prompt in flight, the rest FIFO), so edit /
// cancel / reorder work for real. `--add-dir <cwd>` is REQUIRED: without it a
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
import type { DeliverySource } from "../domain/agentSession";
import { ledgerFor, type Ledger, LedgerWriteError, StaleCommandError, StaleGenerationError } from "../domain/ledger";
import type { SessionStatus, SessionRecord, QueuedMessage, QueueState, SessionDeps } from "../claude/session";
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
  /** Settled: the queue advanced (or the run was retired). */
  finalized: boolean;
  /** The ledger command this run executes, and the attempt the spawn made. */
  commandId: string;
  attemptId: string;
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

  // The queue is OURS: one prompt in flight, the rest waiting in order. The
  // in-memory array mirrors the ledger's queued rows for this session
  // (accepted = committed; a restart's replacement reloads them, #49).
  #queue: QueuedMessage[] = [];
  #inFlight: QueuedMessage | null = null;
  #ledger: Ledger;
  #generation: number;
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
    if (this.status !== "ended") {
      for (const r of this.#ledger.listPending(init.id)) {
        if (r.state !== "queued" && !this.#ledger.requeueCommand(r.id)) continue;
        this.#queue.push({ id: r.id, text: r.text, createdAt: r.createdAt });
      }
      if (this.#queue.length) process.stderr.write(`[agy ${this.id}] restored ${this.#queue.length} queued prompt(s) from the ledger\n`);
    }
  }

  /** Test/diagnostic access to the session's ledger generation. */
  get ledgerGeneration(): number { return this.#generation; }

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
    this.#drain();
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

  // ── queue → one process per turn ──────────────────────────────────────────

  #drain(): void {
    if (this.status === "ended" || this.#proc || this.#inFlight) return;
    const next = this.#queue.shift();
    if (!next) return;
    this.#inFlight = next;
    this.#broadcastQueue();
    this.#runTurn(next);
  }

  #runTurn(item: QueuedMessage): void {
    // The attempt is committed BEFORE the process is spawned: a crash between
    // the spawn and the result is an explicit unknown the next generation
    // re-runs. A row cancelled (or delivered) meanwhile is skipped here.
    const turn = `agy:${this.id}:${this.#boot}:t${++this.#turnSeq}`;
    let attemptId: string;
    try {
      attemptId = this.#ledger.recordAttempt(item.id, this.#generation, turn, "agy").id;
    } catch (e) {
      this.#inFlight = null;
      if (e instanceof StaleGenerationError) return;
      if (e instanceof StaleCommandError) { this.#broadcastQueue(); this.#drain(); return; }
      if (e instanceof LedgerWriteError) {
        // Nothing spawned: the prompt stays queued (head) until the ledger accepts writes.
        this.#queue.unshift(item);
        this.#broadcastQueue();
        process.stderr.write(`[agy ${this.id}] could not commit the attempt for ${item.id}: ${e.message} — retrying in 2s\n`);
        setTimeout(() => this.#drain(), 2_000).unref();
        return;
      }
      throw e;
    }
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

    const run: AgyRun = { turn, proc: null, sawResult: false, turnEnded: false, exit: null, stdoutDone: false, finalized: false, textByStep: new Map(), commandId: item.id, attemptId };
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
      this.#finalize(run, "failed", `spawn failed: ${e}`);
      return;
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
    proc.stdin?.end(JSON.stringify({ event: "user", message: { role: "user", content: item.text } }) + "\n");
    // The prompt is with the harness: delivered. (Its RESULT is the turn's
    // outcome, reported through the turn-end record; #finalize settles it.)
    try { this.#ledger.confirmDelivery(item.id, [], { attemptId }); }
    catch (e) { process.stderr.write(`[agy ${this.id}] ledger confirm for ${item.id} failed: ${e instanceof Error ? e.message : e}\n`); }
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
    // A spawn that never delivered the prompt (error before stdin) is a
    // rejected attempt: the row fails instead of reading as delivered.
    if (status === "failed") {
      try {
        const cmd = this.#ledger.getCommand(run.commandId);
        if (cmd && cmd.state === "submitting") this.#ledger.settleAttempt(run.attemptId, "rejected", { detail: why.slice(0, 200) });
      } catch (e) { process.stderr.write(`[agy ${this.id}] ledger settle for ${run.commandId} failed: ${e instanceof Error ? e.message : e}\n`); }
    }
    if (this.#run !== run) return; // retired by end() / superseded — not ours to advance
    this.#run = null;
    this.#proc = null;
    this.#inFlight = null;
    this.#relay?.setThinking(false);
    this.#broadcastQueue();
    this.#deps.broadcast("session_update", this.toJSON());
    this.#drain();
  }

  #broadcastQueue(): void {
    void this.#relay?.updateQueue(this.queueState());
  }

  // ── AgentSession surface ───────────────────────────────────────────────────

  busy(): boolean { return this.#proc !== null || this.#inFlight !== null || this.#queue.length > 0; }

  enqueue(text: string, opts?: { source?: DeliverySource; mirrorToRelay?: boolean; seq?: number; visible?: boolean }): QueuedMessage {
    const at = Date.now();
    const mirror = (opts?.mirrorToRelay ?? true) && this.#relay;
    const item: QueuedMessage = { id: String(opts?.seq ?? randomUUID().slice(0, 8)), text, createdAt: at };
    // /title — joy-level, never forwarded.
    const titleCmd = /^\/title(?:\s+(.*))?$/s.exec(text.trim());
    if (titleCmd) {
      const t = (titleCmd[1] ?? "").trim();
      this.#titleLocked = !!t;
      saveWindowRecord(this.id, { launchCwd: this.cwd, titleLockedByUser: !!t });
      if (t) { this.summary = t; void this.#relay?.updateSummary(t); }
      this.#persistRecord(); // the title is persisted with its lock (#469)
      this.#deps.broadcast("session_update", this.toJSON());
      if (mirror) this.#relay!.send(encodeUserMessage(text, at), `agy:in:${this.id}:${item.id}`);
      return { ...item, handled: "command" };
    }
    // /joy-prompt — re-deliver the current joy instructions in-band (agy has
    // no launch-time preamble; this is how it learns the tag vocabulary).
    if (/^\/joy-prompt(?:\s|$)/.test(text.trim())) {
      if (mirror) this.#relay!.send(encodeUserMessage(text, at), `agy:in:${this.id}:${item.id}`);
      this.enqueue(joyPromptReinjection(), { mirrorToRelay: false });
      return { ...item, handled: "command" };
    }
    // Acceptance = the ledger commit (throws when it cannot commit, or when
    // the session has ended — #553); a redelivered seq / carried id dedupes.
    const accepted = this.#ledger.acceptCommand({
      sessionId: this.id, id: item.id, text, origin: opts?.seq != null ? "relay" : "local", source: opts?.source ?? "rpc",
      seq: opts?.seq, visible: opts?.visible ?? true, mirrorToRelay: opts?.mirrorToRelay ?? true, createdAt: at,
    });
    if (accepted.deduped !== "none") {
      const dup = this.#queue.find((q) => q.id === accepted.id) ?? (this.#inFlight?.id === accepted.id ? this.#inFlight : undefined);
      if (accepted.deduped === "pending" && !dup && accepted.row) { this.#queue.push({ id: accepted.row.id, text: accepted.row.text, createdAt: accepted.row.createdAt }); this.#broadcastQueue(); this.#drain(); }
      return { id: accepted.id, text: dup?.text ?? text, createdAt: dup?.createdAt ?? at };
    }
    if (mirror) this.#relay!.send(encodeUserMessage(text, at), `agy:in:${this.id}:${item.id}`);
    this.#queue.push(item);
    this.#maybeTitle(text);
    this.#broadcastQueue();
    this.#drain();
    return item;
  }

  /** Delivery state of one command: the prompt reached the harness (delivered),
   *  never spawned (failed), or was plucked (cancelled). */
  queueItemState(id: string): "pending" | "delivered" | "cancelled" | "failed" | "unknown" {
    if (this.#queue.some((q) => q.id === id) || this.#inFlight?.id === id) return "pending";
    const row = this.#ledger.getCommand(id);
    if (!row || row.sessionId !== this.id) return "unknown";
    switch (row.state) {
      case "completed": return "delivered";
      case "failed": return "failed";
      case "cancelled": case "interrupted": return "cancelled";
      default: return "pending";
    }
  }

  #maybeTitle(text: string): void {
    if (this.#titled || this.#titleLocked || !this.#relay) return;
    this.#titled = true;
    const title = titleFromPrompt(text);
    if (title) { this.summary = title; void this.#relay.updateSummary(title); }
  }

  queueState(): QueueState {
    return { queue: [...this.#queue], pendingCount: this.#queue.length, hidden: [], inFlight: this.#inFlight?.text ?? null, paused: false };
  }

  resumeQueue(): void { this.#drain(); }
  editQueued(id: string, text: string): boolean {
    const q = this.#queue.find((m) => m.id === id);
    if (!q) return false;
    if (!this.#ledger.editCommand(id, text)) return false;
    q.text = text; this.#broadcastQueue(); return true;
  }
  cancelQueued(id: string): boolean {
    const i = this.#queue.findIndex((m) => m.id === id);
    if (i < 0) return false;
    this.#queue.splice(i, 1);
    try { this.#ledger.requestCancel(id); } catch (e) { process.stderr.write(`[agy ${this.id}] ledger cancel ${id} failed: ${e instanceof Error ? e.message : e}\n`); }
    this.#broadcastQueue(); return true;
  }
  reorderQueued(id: string, toIndex: number): boolean {
    const i = this.#queue.findIndex((m) => m.id === id);
    if (i < 0) return false;
    const [m] = this.#queue.splice(i, 1);
    const to = Math.max(0, Math.min(toIndex, this.#queue.length));
    this.#queue.splice(to, 0, m);
    this.#ledger.reorderCommand(id, to);
    this.#broadcastQueue(); return true;
  }

  async abort(): Promise<{ ok: boolean; error?: string }> {
    const run = this.#run;
    const proc = run?.proc;
    if (run && proc && proc.exitCode === null) {
      run.sawResult = true; // the exit handler must not report "failed"
      try { proc.kill("SIGTERM"); } catch { /* gone */ }
      this.#endTurn(run, "cancelled");
      try { this.#ledger.recordObservation({ sessionId: this.id, generation: this.#generation, attemptId: run.attemptId, kind: "interrupted", ref: run.turn }); } catch { /* informational */ }
    }
    return { ok: true };
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
    this.#inFlight = null;
    if (run) { this.#endTurn(run, "cancelled"); run.finalized = true; } // stragglers from the dying child are rejected by #onEvent
    this.#run = null; // whatever the dying child still emits is not ours (#466; Astra on ddc89de1: clearing #run alone let a drained answer reach the ended session)
    // Queued rows survive a restart / process exit for the replacement (#49);
    // a kill interrupts them. The in-flight run's row is already delivered.
    this.#queue = [];
    try { this.#ledger.closeGeneration(this.id, this.#generation, reason, { keepQueued: reason !== "killed" }); }
    catch (e) { process.stderr.write(`[agy ${this.id}] ledger closeGeneration failed: ${e instanceof Error ? e.message : e}\n`); }
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
      try { this.#ledger.closeGeneration(this.id, this.#generation, "killed"); } catch { /* logged by end() paths */ }
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
