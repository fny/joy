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
import type { DeliverySource } from "../domain/receipts";
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

  // The queue is OURS: one prompt in flight, the rest waiting in order.
  #queue: QueuedMessage[] = [];
  #inFlight: QueuedMessage | null = null;
  #proc: ChildProcess | null = null;
  #turnSeq = 0;
  // Per-boot nonce in every record id: a recovered session restarts #turnSeq
  // at 0, and the relay dedupes by runtime event id — so "t1" again would
  // be swallowed as a replay (codex review, 2026-09-04).
  readonly #boot = randomUUID().slice(0, 8);
  #turn: string | null = null;
  #sawResult = false;
  // agent_response text arrives as deltas per step_index; emitted once per
  // step at DONE (one clean row per response, not a re-render storm).
  #textByStep = new Map<number, string>();
  #titled = false;
  #titleLocked = false;

  constructor(init: AgyInit, deps: SessionDeps) {
    this.id = init.id;
    this.cwd = init.cwd;
    this.model = init.model;
    this.currentModel = init.model;
    this.#conversationId = init.conversationId;
    this.#continueLast = init.continueLast === true;
    this.status = init.status;
    this.#startedAt = init.startedAt;
    this.#deps = deps;
    this.#titleLocked = loadWindowRecord(init.id)?.titleLockedByUser === true;
  }

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
    saveWindowRecord(this.id, {
      launchCwd: this.cwd, agent: "agy",
      agySettings: { model: this.currentModel ?? this.model, conversationId: this.#conversationId },
    });
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
    const args = [
      "--print", item.text,
      "--output-format", "stream-json",
      "--dangerously-skip-permissions",
      "--add-dir", this.cwd,
      "--print-timeout", PRINT_TIMEOUT,
    ];
    if (this.#conversationId) args.push("--conversation", this.#conversationId);
    else if (this.#continueLast) args.push("--continue");
    const model = this.currentModel ?? this.model;
    if (model) args.push("--model", model);

    this.#turn = `agy:${this.id}:${this.#boot}:t${++this.#turnSeq}`;
    this.#sawResult = false;
    this.#textByStep.clear();
    this.#relay?.send(encodeTurnStart({ turn: this.#turn }), `${this.#turn}:start`);
    this.#relay?.setThinking(true);

    let proc: ChildProcess;
    try {
      // JOY_SESSION_ID is how the joy CLI knows WHO is talking: without it a
      // `joy send` from inside this session was stamped "cli". Same two
      // variables the claude launch line exports.
      proc = spawn("agy", args, { cwd: this.cwd, env: { ...process.env, JOY_SESSION_ID: this.id, JOY_DAEMON_FILE: daemonFilePath() }, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      this.#finishTurn("failed", `spawn failed: ${e}`);
      return;
    }
    this.#proc = proc;
    this.pid = proc.pid;
    proc.stderr?.on("data", (c: Buffer) => {
      const s = String(c).trim();
      if (s) process.stderr.write(`[agy ${this.id}] ${s.slice(0, 500)}\n`);
    });
    const rl = createInterface({ input: proc.stdout! });
    rl.on("line", (line) => {
      if (!line.trim()) return;
      try { this.#onEvent(JSON.parse(line) as AgyEvent); }
      catch { process.stderr.write(`[agy ${this.id}] unparseable event: ${line.slice(0, 200)}\n`); }
    });
    proc.on("error", (e) => {
      process.stderr.write(`[agy ${this.id}] process error: ${e}\n`);
      this.#finishTurn("failed", String(e));
    });
    proc.on("exit", (code) => {
      // A clean run already ended the turn on `result`; anything else is a
      // failure the stream did not announce (killed, crashed, timed out).
      if (!this.#sawResult) this.#finishTurn(code === 0 ? "completed" : "failed", code === null ? "terminated" : `exit ${code}`);
      else this.#afterTurn();
    });
  }

  #onEvent(e: AgyEvent): void {
    const turn = this.#turn;
    if (!turn) return;
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
            this.#textByStep.set(idx, (this.#textByStep.get(idx) ?? "") + s.text_delta);
          }
          if (s.state === "DONE") {
            const text = (this.#textByStep.get(idx) ?? "").trim();
            this.#textByStep.delete(idx);
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
        this.#sawResult = true;
        const r = e.result;
        if (r?.conversation_id && r.conversation_id !== this.#conversationId) {
          this.#conversationId = r.conversation_id;
          this.#persistRecord();
        }
        // The stream may end the last agent_response step only implicitly:
        // flush any text still buffered before closing the turn.
        for (const [idx, buf] of this.#textByStep) {
          const text = buf.trim();
          if (text) this.#relay?.send(encodeTextEvent(text, { turn }), `${turn}:text:${idx}`);
        }
        this.#textByStep.clear();
        const u = r?.usage;
        if (u && (u.input_tokens ?? 0) > 0) void this.#relay?.updateContext(u.input_tokens ?? 0);
        this.#endTurn(r?.status === "SUCCESS" ? "completed" : "failed");
        break;
      }
      default: break;
    }
  }

  #endTurn(status: "completed" | "failed" | "cancelled"): void {
    const turn = this.#turn;
    if (!turn) return;
    this.#relay?.send(encodeTurnEnd(status, { turn }), `${turn}:end`);
    this.#turn = null;
  }

  #finishTurn(status: "completed" | "failed", why: string): void {
    if (status === "failed") {
      process.stderr.write(`[agy ${this.id}] turn failed: ${why}\n`);
      this.#relay?.send(encodeUserMessage(`⚠ agy: ${why}`, Date.now()));
    }
    this.#endTurn(status);
    this.#afterTurn();
  }

  #afterTurn(): void {
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

  enqueue(text: string, opts?: { source?: DeliverySource; mirrorToRelay?: boolean; seq?: number; visible?: boolean; requireDurable?: boolean }): QueuedMessage {
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
    if (mirror) this.#relay!.send(encodeUserMessage(text, at), `agy:in:${this.id}:${item.id}`);
    this.#queue.push(item);
    this.#maybeTitle(text);
    this.#broadcastQueue();
    this.#drain();
    return item;
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
    q.text = text; this.#broadcastQueue(); return true;
  }
  cancelQueued(id: string): boolean {
    const i = this.#queue.findIndex((m) => m.id === id);
    if (i < 0) return false;
    this.#queue.splice(i, 1); this.#broadcastQueue(); return true;
  }
  reorderQueued(id: string, toIndex: number): boolean {
    const i = this.#queue.findIndex((m) => m.id === id);
    if (i < 0) return false;
    const [m] = this.#queue.splice(i, 1);
    this.#queue.splice(Math.max(0, Math.min(toIndex, this.#queue.length)), 0, m);
    this.#broadcastQueue(); return true;
  }

  async abort(): Promise<{ ok: true }> {
    const proc = this.#proc;
    if (proc && proc.exitCode === null) {
      this.#sawResult = true; // the exit handler must not report "failed"
      try { proc.kill("SIGTERM"); } catch { /* gone */ }
      this.#endTurn("cancelled");
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
  setHandoff(info: import("../relay/relay").JoyHandoffInfo | null): void { void this.#relay?.updateHandoff(info); }
  markCompacting(): void { /* agy manages its own context */ }

  // ── teardown ──────────────────────────────────────────────────────────────

  end(reason: "killed" | "process_exited" | "restart"): boolean {
    if (this.status === "ended") return false;
    this.status = "ended";
    this.endReason = reason;
    if (this.#proc && this.#proc.exitCode === null) {
      this.#sawResult = true;
      try { this.#proc.kill("SIGTERM"); } catch { /* already gone */ }
    }
    this.#proc = null;
    this.#inFlight = null;
    this.#endTurn("cancelled");
    this.#relay?.setThinking(false);
    if (reason === "process_exited") {
      void this.#relay?.updateJoyState("detached");
      this.#relay?.pausePull();
    } else {
      if (this.#relay && reason !== "restart") this.#archivePromise = this.#relay.archive(); // restart keeps the card
      this.#relay?.stop();
      if (reason !== "restart") deleteWindowRecord(this.id);
    }
    this.#deps.broadcast("session_update", this.toJSON());
    return true;
  }

  forceKill(): boolean {
    if (this.status === "ended") {
      if (this.#relay) this.#archivePromise = this.#relay.archive();
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
