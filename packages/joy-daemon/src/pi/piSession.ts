// PiSession — bare adapter for the vanilla pi coding agent (@earendil-works/
// pi-coding-agent) driven headless over `--mode rpc` (JSONL on stdio).
// See docs/plans/pi-family-adapter-design.md for the probed protocol.
//
// Bare v1 scope (deliberate gaps, documented there):
// - No resume/reconcile: a daemon restart loses pi's local context; the app
//   keeps relay history, the pi process starts fresh. No recovery path.
// - No pane (opencode-style stubs), no permission modes (pi default policy),
//   no effort wiring, no per-session model switching.
// - Queue: pi owns steer/follow-up queues natively; `queue_update` events are
//   mirrored into queueState(). Send path: busy → steer, idle → prompt. Every
//   prompt is a ledger command first (accepted = committed), the stdin write
//   is a ledger attempt, and pi's RPC `response` settles it — so a daemon
//   restart re-sends what pi never confirmed instead of losing it with pi's
//   in-process queue.
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { daemonFilePath } from "../claude/hooks";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";

import {
  createRelaySession, encodeUserMessage, encodeTurnEnd,
  encodeTurnStart, encodeTextEvent, encodeToolCallStart, encodeToolCallEnd,
  type RelaySession,
} from "../relay/relay";
import type { AgentSession } from "../domain/agentSession";
import type { DeliverySource } from "../domain/agentSession";
import type { SessionStatus, SessionRecord, QueuedMessage, QueueState, SessionDeps } from "../claude/session";
import { saveWindowRecord, deleteWindowRecord, loadWindowRecord } from "../domain/windowRecord";
import { ledgerFor, type Ledger, LedgerWriteError, StaleCommandError, StaleGenerationError } from "../domain/ledger";
import { titleFromPrompt } from "../opencode/opencodeSession";
import { joyPromptReinjection } from "../domain/agentTagsPrompt";

export interface PiInit {
  id: string;
  cwd: string;
  model?: string;          // pi --model spec (see src/pi/models.ts)
  status: SessionStatus;
  startedAt: number;
  /** pi's own session id (`pi --session-id`): chosen by the daemon for a
   *  fresh session, reused to resume; persisted in the window record. */
  piSessionId?: string;
  /** `pi -c`: continue pi's newest session for this cwd (no id known yet). */
  continueLast?: boolean;
}

/** Locate the pi binary: PATH first, then the pnpm-global shim. */
function piBinary(): string {
  for (const p of (process.env.PATH ?? "").split(":")) {
    if (p && existsSync(join(p, "pi"))) return join(p, "pi");
  }
  const pnpmShim = join(homedir(), ".local", "share", "pnpm", "pi");
  if (existsSync(pnpmShim)) return pnpmShim;
  return "pi"; // last resort — spawn resolves via PATH or fails loudly
}

/** Flatten pi's ToolResult (`{content:[{type:"text",text}…], details}`), a
 *  bare string, or anything else into the text the app's tool card shows (#578). */
function toolResultText(r: unknown): string | undefined {
  if (r == null) return undefined;
  if (typeof r === "string") return r;
  const content = (r as { content?: unknown }).content;
  if (Array.isArray(content)) {
    const parts = content
      .map((p) => (p && typeof p === "object" && (p as { type?: unknown }).type === "text" ? String((p as { text?: unknown }).text ?? "") : ""))
      .filter(Boolean);
    if (parts.length) return parts.join("\n");
  }
  try { return JSON.stringify(r, null, 2); } catch { return String(r); }
}

export class PiSession implements AgentSession {
  readonly agentFlavor = "pi" as const;
  readonly id: string;
  readonly cwd: string;
  #piSessionId: string | undefined;
  #continueLast: boolean;
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
  readonly tmuxWindow = ""; // no tmux window — capability absent

  #startedAt: number;
  #deps: SessionDeps;
  #proc: ChildProcess | null = null;
  /** The process end() sent SIGTERM to, for awaitExit. */
  #dying: ChildProcess | null = null;
  #relay: RelaySession | null = null;
  #started = false;
  #thinking = false;
  #archivePromise: Promise<boolean> | null = null;
  // Monotonic turn counter — pi's turn_start carries no id.
  #turnSeq = 0;
  // Per-process nonce in every turn id (#575): a restart under the same joy
  // id starts #turnSeq at 0 again, and the relay dedupes by runtime event
  // id — so a second `pi:<id>:t1` was swallowed as a replay of the old
  // process's turn and the new answer hung off the old bracket.
  readonly #boot = randomUUID().slice(0, 8);
  #turn: string | null = null;
  // prompt/steer commands awaiting pi's `response` row, by request id (#577):
  // a `success:false` used to be ignored along with every non-get_state
  // response, so a rejected prompt vanished without a trace. Each carries
  // the ledger command + attempt the response settles (#456).
  #pending = new Map<string, { kind: "prompt" | "steer"; text: string; commandId: string; attemptId: string }>();
  #ledger: Ledger;
  #generation: number;
  // pi-owned queues, mirrored from queue_update events.
  #queuedInHarness = 0;
  #titled = false;
  #titleLocked = false;

  constructor(init: PiInit, deps: SessionDeps) {
    this.id = init.id;
    this.cwd = init.cwd;
    this.model = init.model;
    this.#piSessionId = init.piSessionId;
    this.#continueLast = init.continueLast === true;
    this.status = init.status;
    this.#startedAt = init.startedAt;
    this.#deps = deps;
    this.#titleLocked = loadWindowRecord(init.id)?.titleLockedByUser === true;
    // A new generation: whatever the previous process had in flight is an
    // explicit unknown, re-sent by #resendPending once pi is up (pi's own
    // queue died with it; the conversation is resumed by --session-id).
    this.#ledger = deps.ledger ?? ledgerFor();
    this.#generation = this.#ledger.openGeneration(init.id, "pi");
  }

  /** Test/diagnostic access to the session's ledger generation. */
  get ledgerGeneration(): number { return this.#generation; }

  get relayAttached(): boolean { return this.#relay !== null; }
  /** pi's own session id (the session file's id) — what a fork copies. */
  get piSessionId(): string | undefined { return this.#piSessionId; }

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
    return true;
  }

  beginWatching(): void {
    if (this.#started) return;
    this.#started = true;
    this.#start();
  }

  #start(): void {
    try {
      const args = ["--mode", "rpc"];
      if (this.model) args.push("--model", this.model);
      // Sessions persist in ~/.pi/agent/sessions/<cwd>/… so they can be
      // resumed: an explicit id (ours or --resume's) via --session-id, or
      // pi's newest for the cwd via -c.
      if (this.#piSessionId) args.push("--session-id", this.#piSessionId);
      else if (this.#continueLast) args.push("-c");
      // Provider keys come from the sealed store, applied to process.env by
      // the registry right before this spawn (domain/envStore.ts).
      // JOY_SESSION_ID tells the joy CLI who is talking (a `joy send` from a
      // pi session was stamped "cli" without it); JOY_DAEMON_FILE lets it
      // find the daemon. Same pair the claude launch line exports.
      const env = { ...process.env, JOY_SESSION_ID: this.id, JOY_DAEMON_FILE: daemonFilePath() };
      const proc = spawn(piBinary(), args, {
        cwd: this.cwd,
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      this.#proc = proc;
      this.pid = proc.pid;
      proc.on("exit", () => { if (this.status !== "ended") this.end("process_exited"); });
      proc.on("error", (e) => {
        process.stderr.write(`[pi ${this.id}] spawn error: ${e}\n`);
        if (this.status !== "ended") this.end("process_exited");
      });
      // A write into a pipe pi has already closed (it died, or shut its
      // stdin) emits `error: EPIPE` on stdin; with no listener that is an
      // uncaught exception that killed the whole daemon (issue #46).
      proc.stdin?.on("error", (e) => {
        process.stderr.write(`[pi ${this.id}] stdin error: ${e instanceof Error ? e.message : e}\n`);
        if (this.status !== "ended") this.end("process_exited");
      });
      proc.stderr?.on("data", (c: Buffer) => {
        const s = String(c).trim();
        if (s) process.stderr.write(`[pi ${this.id}] ${s.slice(0, 500)}\n`);
      });
      const rl = createInterface({ input: proc.stdout! });
      rl.on("line", (line) => {
        if (!line.trim()) return;
        try { this.#onEvent(JSON.parse(line) as Record<string, unknown>); }
        catch { process.stderr.write(`[pi ${this.id}] unparseable event: ${line.slice(0, 200)}\n`); }
      });
      // Learn the RESOLVED model (fuzzy specs pick variants — surface truth).
      this.#send({ type: "get_state" });
      this.#persistRecord();
      if (this.status === "starting") this.status = "active";
      this.#deps.broadcast("session_update", this.toJSON());
      this.#resendPending();
    } catch (e) {
      process.stderr.write(`[pi ${this.id}] start failed: ${e}\n`);
      this.end("process_exited");
    }
  }

  #persistRecord(): void {
    if (this.status === "ended") return; // a retired/killed generation must not recreate a deleted record (#52)
    saveWindowRecord(this.id, { launchCwd: this.cwd, agent: "pi", piSettings: { model: this.currentModel ?? this.model, sessionId: this.#piSessionId } });
  }

  /** Hand every command the ledger still holds for this session to pi: rows
   *  queued before the process was up, and rows a previous generation left
   *  unconfirmed (unknown → at-least-once; the process that had them died). */
  #resendPending(): void {
    if (this.status === "ended" || !this.#proc) return;
    for (const row of this.#ledger.listPending(this.id, ["queued", "unknown"])) {
      if (row.state === "unknown" && !this.#ledger.requeueCommand(row.id)) continue;
      this.#dispatch(this.#thinking ? "steer" : "prompt", row.text, row.id);
    }
  }

  /** True when the command was handed to pi's stdin. */
  #send(cmd: Record<string, unknown>): boolean {
    const proc = this.#proc;
    if (!proc?.stdin?.writable || proc.stdin.destroyed) return false;
    try { proc.stdin.write(JSON.stringify(cmd) + "\n"); return true; }
    catch (e) { process.stderr.write(`[pi ${this.id}] write failed: ${e instanceof Error ? e.message : e}\n`); return false; }
  }

  // ── event stream → relay ──────────────────────────────────────────────────

  #onEvent(e: Record<string, unknown>): void {
    const type = String(e.type ?? "");
    switch (type) {
      case "response": {
        const reqId = typeof e.id === "string" ? e.id : undefined;
        const pending = reqId ? this.#pending.get(reqId) : undefined;
        if (pending && reqId) {
          this.#pending.delete(reqId);
          if (!e.success) {
            const error = String((e as { error?: unknown }).error ?? "unknown error");
            this.#settleRejected(pending.commandId, pending.attemptId, error);
            this.#rejected(pending.kind, pending.text, error);
            break;
          }
          // pi took it: the command is delivered (#456 — the response carries the request id).
          try { this.#ledger.confirmDelivery(pending.commandId, [], { attemptId: pending.attemptId, generation: this.#generation }); }
          catch (err) { process.stderr.write(`[pi ${this.id}] ledger confirm for ${pending.commandId} failed: ${err instanceof Error ? err.message : err}\n`); }
        }
        if (e.command === "get_state" && e.success) {
          const data = e.data as { model?: { id?: string }; sessionId?: string } | undefined;
          const model = data?.model;
          if (model?.id && model.id !== this.currentModel) {
            this.currentModel = model.id;
            void this.#relay?.updateModelCode(model.id);
            this.#persistRecord();
          }
          // The session pi actually opened (#576): with `-c` (or no id at all)
          // the daemon never learned which conversation it was in, so resume
          // and fork after a restart had nothing to point at.
          if (typeof data?.sessionId === "string" && data.sessionId && data.sessionId !== this.#piSessionId) {
            this.#piSessionId = data.sessionId;
            this.#continueLast = false;
            this.#persistRecord();
          }
        }
        break;
      }
      case "turn_start": {
        this.#turn = this.#turnId(++this.#turnSeq);
        this.#relay?.send(encodeTurnStart({ turn: this.#turn }), `${this.#turn}:start`);
        this.#setThinking(true);
        break;
      }
      case "turn_end": {
        const turn = this.#turn;
        if (turn) {
          // Emit the assistant text from the FINAL message (deltas skipped in
          // bare v1 — one clean row per turn beats a re-render storm).
          const msg = e.message as { content?: Array<Record<string, unknown>>; usage?: { input?: number; cacheRead?: number } } | undefined;
          for (const part of msg?.content ?? []) {
            if (String(part.type ?? "") === "text") {
              const text = String(part.text ?? "").trim();
              if (text) {
                this.#relay?.send(encodeTextEvent(text, { turn }), `${turn}:text:${randomUUID().slice(0, 8)}`);
                // Live turn_end only (no replay path) — mirror directly into
                // the daemon chat log for the debug page + v2 nucleus lane.
                this.#deps.addChatMessage({ role: "assistant", content: text, source: "cli", session_id: this.id });
              }
            }
          }
          const u = msg?.usage;
          if (u && (u.input ?? 0) > 0) void this.#relay?.updateContext((u.input ?? 0) + (u.cacheRead ?? 0));
          this.#relay?.send(encodeTurnEnd("completed", { turn }), `${turn}:end`);
        }
        this.#turn = null;
        break;
      }
      case "agent_end": {
        // The run has fully settled (all queued steering delivered).
        this.#setThinking(false);
        break;
      }
      case "tool_execution_start": {
        const turn = this.#turn ?? this.#turnId(this.#turnSeq);
        this.#relay?.send(encodeToolCallStart({
          call: String(e.toolCallId ?? randomUUID()),
          name: String(e.toolName ?? "PiTool"),
          input: e.args ?? null,
          turn,
        }), `${turn}:tool:${String(e.toolCallId ?? "")}:start`);
        break;
      }
      case "tool_execution_end": {
        const turn = this.#turn ?? this.#turnId(this.#turnSeq);
        const call = String(e.toolCallId ?? "");
        // Carry the OUTPUT and the failure flag (#578): the record held only
        // the call id, so a permission-denied or crashed tool rendered exactly
        // like a successful one and its diagnostics were lost.
        const result = toolResultText(e.result);
        const isError = e.isError === true;
        this.#relay?.send(encodeToolCallEnd(call, { turn, ...(result ? { result: result.slice(0, 48_000) } : {}), ...(isError ? { isError: true } : {}) }), `${turn}:tool:${call}:end`);
        break;
      }
      case "queue_update": {
        const steering = Array.isArray(e.steering) ? e.steering.length : 0;
        const followUp = Array.isArray(e.followUp) ? e.followUp.length : 0;
        this.#queuedInHarness = steering + followUp;
        break;
      }
      case "error": {
        const msg = String((e as { message?: unknown }).message ?? JSON.stringify(e).slice(0, 200));
        this.#relay?.send(encodeUserMessage(`⚠ pi error: ${msg}`, Date.now()));
        if (this.#turn) {
          this.#relay?.send(encodeTurnEnd("failed", { turn: this.#turn }), `${this.#turn}:end`);
          this.#turn = null;
        }
        this.#setThinking(false);
        break;
      }
      default: break; // ready, message_start/update/end, agent_start — ignored in bare v1
    }
  }

  #turnId(n: number): string { return `pi:${this.id}:${this.#boot}:t${n}`; }

  /** Hand a prompt/steer to pi and track it until pi answers (#577). The
   *  attempt is committed BEFORE the stdin write: a crash between the write
   *  and pi's response is an explicit unknown the next generation re-sends. */
  #dispatch(kind: "prompt" | "steer", text: string, commandId: string): void {
    if (!this.#proc) return; // not up yet: #resendPending sends it once pi is
    const id = randomUUID().slice(0, 8);
    let attemptId: string;
    try {
      attemptId = this.#ledger.recordAttempt(commandId, this.#generation, id, kind).id;
    } catch (e) {
      if (e instanceof StaleGenerationError || e instanceof StaleCommandError) return; // retired, or cancelled/delivered meanwhile
      if (e instanceof LedgerWriteError) {
        // Not sent: the row stays queued and is retried once the ledger accepts writes.
        process.stderr.write(`[pi ${this.id}] could not commit the ${kind} attempt for ${commandId}: ${e.message} — holding\n`);
        setTimeout(() => this.#resendPending(), 2_000).unref();
        return;
      }
      throw e;
    }
    this.#pending.set(id, { kind, text, commandId, attemptId });
    if (!this.#send({ id, type: kind, message: text })) {
      this.#pending.delete(id);
      this.#settleRejected(commandId, attemptId, "pi stdin is not writable");
      this.#rejected(kind, text, "pi stdin is not writable");
    }
  }

  #settleRejected(commandId: string, attemptId: string, error: string): void {
    try { this.#ledger.settleAttempt(attemptId, "rejected", { detail: error.slice(0, 200), generation: this.#generation }); }
    catch (e) { process.stderr.write(`[pi ${this.id}] ledger settle for ${commandId} failed: ${e instanceof Error ? e.message : e}\n`); }
  }

  /** Surface a prompt/steer pi refused (or never received) instead of
   *  acknowledging an unchecked stdin write (#577). */
  #rejected(kind: string, text: string, error: string): void {
    const note = `⚠ pi: ${kind} rejected — ${error}`;
    process.stderr.write(`[pi ${this.id}] ${kind} rejected: ${error} (${text.slice(0, 80).replace(/\n/g, " ")})\n`);
    this.#relay?.send(encodeUserMessage(note, Date.now()));
    // The daemon chat log is the lane's cross-adapter activity signal: without
    // a row here a rejected prompt left the relay turn parked in the start
    // gate for the whole 180 s no_agent_activity deadline.
    this.#deps.addChatMessage({ role: "event", content: note, source: "cli", session_id: this.id, event_type: "pi_rejected", event_status: "error" });
  }

  #setThinking(value: boolean): void {
    if (this.#thinking === value) return;
    this.#thinking = value;
    this.#relay?.setThinking(value);
  }

  // ── AgentSession surface ───────────────────────────────────────────────────

  busy(): boolean { return this.#thinking; }

  enqueue(text: string, opts?: { source?: DeliverySource; mirrorToRelay?: boolean; seq?: number; visible?: boolean }): QueuedMessage {
    const at = Date.now();
    // /title — joy-level, never forwarded (mirrors the opencode contract).
    const titleCmd = /^\/title(?:\s+(.*))?$/s.exec(text.trim());
    if (titleCmd) {
      const t = (titleCmd[1] ?? "").trim();
      if (t) {
        this.#titleLocked = true;
        saveWindowRecord(this.id, { launchCwd: this.cwd, titleLockedByUser: true });
        this.summary = t;
        void this.#relay?.updateSummary(t);
      } else {
        this.#titleLocked = false;
        saveWindowRecord(this.id, { launchCwd: this.cwd, titleLockedByUser: false });
      }
      this.#deps.broadcast("session_update", this.toJSON());
      if ((opts?.mirrorToRelay ?? true) && this.#relay) this.#relay.send(encodeUserMessage(text, at), `pi:in:${this.id}:${opts?.seq ?? at}`);
      // Nothing reaches pi: a lane that owns a relay turn must terminalize it
      // now, not wait 180 s for agent activity that never comes (#115).
      return { id: String(opts?.seq ?? at), text, createdAt: at, handled: "command" };
    }
    // /joy-prompt — deliver the CURRENT joy instructions in-band. Pi has no
    // launch-time preamble (bare v1), so this is how a pi session learns the
    // tag vocabulary at all. Body goes out unmirrored; only the /joy-prompt
    // row (when mirror) appears in chat. Relay sends route through enqueue
    // (rs.onMessage), so this one interception covers both paths.
    if (/^\/joy-prompt(?:\s|$)/.test(text.trim())) {
      if ((opts?.mirrorToRelay ?? true) && this.#relay) this.#relay.send(encodeUserMessage(text, at), `pi:in:${this.id}:${opts?.seq ?? at}`);
      this.enqueue(joyPromptReinjection(), { mirrorToRelay: false });
      return { id: String(opts?.seq ?? at), text, createdAt: at, handled: "command" }; // (#115)
    }
    // Acceptance = the ledger commit (throws when it cannot commit, or when
    // the session has ended — #553); a redelivered seq dedupes there.
    const accepted = this.#ledger.acceptCommand({
      sessionId: this.id, id: opts?.seq != null ? `pi-in:${this.id}:${opts.seq}` : undefined, text,
      origin: opts?.seq != null ? "relay" : "local", source: opts?.source ?? "rpc", seq: opts?.seq,
      visible: opts?.visible ?? false, mirrorToRelay: opts?.mirrorToRelay ?? true, createdAt: at,
    });
    if (accepted.deduped !== "none") return { id: accepted.id, text, createdAt: accepted.row?.createdAt ?? at };
    // Mirror the user row FIRST (positional turn pairing needs user-before-
    // turn-start; see the codex CH7 lesson), then hand pi the message: its
    // native queue handles busy — steer mid-turn, prompt when idle.
    if ((opts?.mirrorToRelay ?? true) && this.#relay) this.#relay.send(encodeUserMessage(text, at), `pi:in:${this.id}:${opts?.seq ?? at}`);
    this.#dispatch(this.#thinking ? "steer" : "prompt", text, accepted.id);
    this.#maybeTitle(text);
    return { id: accepted.id, text, createdAt: at };
  }

  /** Delivery state of one command: pi's `response` is the proof (#456). */
  queueItemState(id: string): "pending" | "delivered" | "cancelled" | "failed" | "unknown" {
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
    if (title) {
      this.summary = title;
      void this.#relay.updateSummary(title);
    }
  }

  queueState(): QueueState {
    // pi's own steer/follow-up queues, plus commands not yet handed to it
    // (accepted before the process was up).
    const notYetSent = this.#ledger.listPending(this.id, ["queued"]).length;
    return { queue: [], pendingCount: this.#queuedInHarness + notYetSent, hidden: [], inFlight: this.#turn, paused: false };
  }

  resumeQueue(): void { this.#resendPending(); }
  editQueued(): boolean { return false; }
  /** Only a command pi has not been handed yet can be plucked. */
  cancelQueued(id: string): boolean {
    const row = this.#ledger.getCommand(id);
    if (!row || row.sessionId !== this.id || row.state !== "queued") return false;
    try { return this.#ledger.requestCancel(id)?.state === "cancelled"; } catch { return false; }
  }
  reorderQueued(): boolean { return false; }

  async abort(): Promise<{ ok: boolean; error?: string }> {
    if (!this.#send({ type: "abort" })) return { ok: false, error: "pi stdin is not writable" }; // nothing was interrupted (#8)
    if (this.#turn) {
      this.#relay?.send(encodeTurnEnd("cancelled", { turn: this.#turn }), `${this.#turn}:end`);
      this.#turn = null;
    }
    this.#setThinking(false);
    return { ok: true };
  }

  // No tmux window: pane surface degrades gracefully (opencode precedent).
  async pane(): Promise<{ ok: true; text: string }> { return { ok: true, text: "(pi session — no terminal pane)" }; }
  async resize(): Promise<{ ok: boolean }> { return { ok: true }; }
  async sendRawKeys(): Promise<{ ok: boolean; segments: number; error?: string }> { return { ok: false, segments: 0, error: "no pane for pi sessions" }; }
  detectPermissionMode(): string | null { return null; }
  async setPermissionMode(): Promise<{ ok: boolean; mode?: string; error?: string }> { return { ok: false, error: "not supported for pi (bare v1)" }; }
  transcript(): { lines: unknown[] } { return { lines: [] }; }
  onHookEvent(): { ok: boolean } { return { ok: true }; }
  /** Card snapshot for the nucleus lane's v2 publish (see AgentSession). */
  cardMetadata(): Record<string, unknown> | null {
    return this.#relay?.metadataSnapshot ?? null;
  }

  setV2Link(link: { sessionId: string; relay: string; keyEnvelope: string }): void {
    // localSessionId lets the app address this session's MACHINE plane
    // (/v2/sessions/<local id>/…) through the sealed tunnel.
    void this.#relay?.mergeMetadata({ v2: { ...link, localSessionId: this.id } });
  }

  setHandoff(info: import("../relay/relay").JoyHandoffInfo | null): void { saveWindowRecord(this.id, { handoff: info }); void this.#relay?.updateHandoff(info); }
  markCompacting(): void { /* pi compacts itself */ }

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
    if (this.#proc && this.#proc.exitCode === null) {
      this.#dying = this.#proc;
      try { this.#proc.kill("SIGTERM"); } catch { /* already gone */ }
    }
    this.#proc = null;
    this.#pending.clear(); // the process that would have answered is gone (#577)
    // Its unanswered attempts become explicit unknowns for the next generation
    // to re-send; queued rows survive a restart / process exit, never a kill.
    try { this.#ledger.closeGeneration(this.id, this.#generation, reason, { keepQueued: reason !== "killed" }); }
    catch (e) { process.stderr.write(`[pi ${this.id}] ledger closeGeneration failed: ${e instanceof Error ? e.message : e}\n`); }
    if (this.#turn) {
      this.#relay?.send(encodeTurnEnd("cancelled", { turn: this.#turn }), `${this.#turn}:end`);
      this.#turn = null;
    }
    this.#setThinking(false);
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
      busy: this.#thinking,
    };
  }

  async createAndAttachRelay(): Promise<void> {
    if (!this.#deps.relayClient) return;
    const rs = await createRelaySession(this.#deps.relayClient, { tag: `joy-daemon-${this.id}`, cwd: this.cwd, id: this.id });
    this.attachRelay(rs);
  }
}
