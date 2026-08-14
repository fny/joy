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
//   mirrored into queueState(). Send path: busy → steer, idle → prompt.
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";

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

export interface PiInit {
  id: string;
  cwd: string;
  model?: string;          // pi --model spec (see src/pi/models.ts)
  status: SessionStatus;
  startedAt: number;
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

export class PiSession implements AgentSession {
  readonly agentFlavor = "pi" as const;
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
  readonly tmuxWindow = ""; // no tmux window — capability absent

  #startedAt: number;
  #deps: SessionDeps;
  #proc: ChildProcess | null = null;
  #relay: RelaySession | null = null;
  #started = false;
  #thinking = false;
  #archivePromise: Promise<boolean> | null = null;
  // Monotonic turn counter — pi's turn_start carries no id; the bracket ids
  // only need to be unique within this process (no reconcile in bare v1).
  #turnSeq = 0;
  #turn: string | null = null;
  // pi-owned queues, mirrored from queue_update events.
  #queuedInHarness = 0;
  #titled = false;
  #titleLocked = false;

  constructor(init: PiInit, deps: SessionDeps) {
    this.id = init.id;
    this.cwd = init.cwd;
    this.model = init.model;
    this.status = init.status;
    this.#startedAt = init.startedAt;
    this.#deps = deps;
    this.#titleLocked = loadWindowRecord(init.id)?.titleLockedByUser === true;
  }

  get relayAttached(): boolean { return this.#relay !== null; }

  // ── lifecycle ──────────────────────────────────────────────────────────────

  attachRelay(rs: RelaySession, allowEnded = false): boolean {
    if (this.status === "ended" && !allowEnded) return false;
    this.#relay = rs;
    this.relaySessionId = rs.relaySessionId;
    if (this.status === "ended") rs.pausePull();
    rs.onMessage = async (text, seq) => { this.enqueue(text, { seq, mirrorToRelay: false }); };
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
      const args = ["--mode", "rpc", "--no-session"];
      if (this.model) args.push("--model", this.model);
      const proc = spawn(piBinary(), args, {
        cwd: this.cwd,
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      this.#proc = proc;
      this.pid = proc.pid;
      proc.on("exit", () => { if (this.status !== "ended") this.end("process_exited"); });
      proc.on("error", (e) => {
        process.stderr.write(`[pi ${this.id}] spawn error: ${e}\n`);
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
    } catch (e) {
      process.stderr.write(`[pi ${this.id}] start failed: ${e}\n`);
      this.end("process_exited");
    }
  }

  #persistRecord(): void {
    saveWindowRecord(this.id, { launchCwd: this.cwd, agent: "pi", piSettings: { model: this.currentModel ?? this.model } });
  }

  #send(cmd: Record<string, unknown>): void {
    const proc = this.#proc;
    if (!proc?.stdin?.writable) return;
    proc.stdin.write(JSON.stringify(cmd) + "\n");
  }

  // ── event stream → relay ──────────────────────────────────────────────────

  #onEvent(e: Record<string, unknown>): void {
    const type = String(e.type ?? "");
    switch (type) {
      case "response": {
        if (e.command === "get_state" && e.success) {
          const model = (e.data as { model?: { id?: string } } | undefined)?.model;
          if (model?.id && model.id !== this.currentModel) {
            this.currentModel = model.id;
            void this.#relay?.updateModelCode(model.id);
            this.#persistRecord();
          }
        }
        break;
      }
      case "turn_start": {
        this.#turn = `pi:${this.id}:t${++this.#turnSeq}`;
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
              if (text) this.#relay?.send(encodeTextEvent(text, { turn }), `${turn}:text:${randomUUID().slice(0, 8)}`);
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
        const turn = this.#turn ?? `pi:${this.id}:t${this.#turnSeq}`;
        this.#relay?.send(encodeToolCallStart({
          call: String(e.toolCallId ?? randomUUID()),
          name: String(e.toolName ?? "PiTool"),
          input: e.args ?? null,
          turn,
        }), `${turn}:tool:${String(e.toolCallId ?? "")}:start`);
        break;
      }
      case "tool_execution_end": {
        const turn = this.#turn ?? `pi:${this.id}:t${this.#turnSeq}`;
        this.#relay?.send(encodeToolCallEnd(String(e.toolCallId ?? ""), { turn }), `${turn}:tool:${String(e.toolCallId ?? "")}:end`);
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

  #setThinking(value: boolean): void {
    if (this.#thinking === value) return;
    this.#thinking = value;
    this.#relay?.setThinking(value);
  }

  // ── AgentSession surface ───────────────────────────────────────────────────

  busy(): boolean { return this.#thinking; }

  enqueue(text: string, opts?: { source?: DeliverySource; mirrorToRelay?: boolean; seq?: number; visible?: boolean; requireDurable?: boolean }): QueuedMessage {
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
      return { id: String(opts?.seq ?? at), text, createdAt: at };
    }
    // Mirror the user row FIRST (positional turn pairing needs user-before-
    // turn-start; see the codex CH7 lesson), then hand pi the message: its
    // native queue handles busy — steer mid-turn, prompt when idle.
    if ((opts?.mirrorToRelay ?? true) && this.#relay) this.#relay.send(encodeUserMessage(text, at), `pi:in:${this.id}:${opts?.seq ?? at}`);
    this.#send(this.#thinking ? { type: "steer", message: text } : { type: "prompt", message: text });
    this.#maybeTitle(text);
    return { id: String(opts?.seq ?? at), text, createdAt: at };
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
    return { queue: [], pendingCount: this.#queuedInHarness, hidden: [], inFlight: this.#turn, paused: false };
  }

  resumeQueue(): void { /* pi drains its own queues */ }
  editQueued(): boolean { return false; }
  cancelQueued(): boolean { return false; }
  reorderQueued(): boolean { return false; }

  async abort(): Promise<{ ok: true }> {
    this.#send({ type: "abort" });
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
  markCompacting(): void { /* pi compacts itself */ }
  reassertLifecycle(): void { void this.#relay?.updateJoyState(this.status === "ended" ? "detached" : "running"); }

  // ── teardown ──────────────────────────────────────────────────────────────

  end(reason: "killed" | "process_exited"): boolean {
    if (this.status === "ended") return false;
    this.status = "ended";
    this.endReason = reason;
    const relaySessionId = this.#relay?.relaySessionId ?? this.relaySessionId;
    if (this.#proc && this.#proc.exitCode === null) {
      try { this.#proc.kill("SIGTERM"); } catch { /* already gone */ }
    }
    this.#proc = null;
    if (this.#turn) {
      this.#relay?.send(encodeTurnEnd("cancelled", { turn: this.#turn }), `${this.#turn}:end`);
      this.#turn = null;
    }
    this.#setThinking(false);
    if (reason === "process_exited") {
      void this.#relay?.updateJoyState("detached");
      this.#relay?.pausePull();
    } else {
      void this.#relay?.updateJoyState("archived");
      if (this.#deps.relayClient && relaySessionId) this.#archivePromise = this.#deps.relayClient.archiveSession(relaySessionId);
      this.#relay?.stop();
      deleteWindowRecord(this.id);
    }
    this.#deps.broadcast("session_update", this.toJSON());
    return true;
  }

  forceKill(): boolean {
    if (this.status === "ended") {
      const relaySessionId = this.relaySessionId;
      if (this.#deps.relayClient && relaySessionId) this.#archivePromise = this.#deps.relayClient.archiveSession(relaySessionId);
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
