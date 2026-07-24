// CodexSession — the AgentSession implementation for OpenAI's codex, driven via
// the app-server (JSON-RPC over a per-session unix socket) instead of a claude
// TUI + transcript. It reproduces the SAME wire output the claude Session emits
// (via CodexNormalizer) so the app renders both identically.
//
// M1 scope: spawn app-server, connect, start/resume a thread, deliver app
// messages via turn/start, mirror codex notifications to the relay, thinking,
// interrupt, kill/archive. Codex's native turn queueing replaces claude's
// pane-dispatch queue, so the daemon-side queue is trivial here (the app-side
// draft queue is agent-agnostic and unchanged).

import { randomUUID } from "crypto";
import { type ChildProcess } from "child_process";
import { mkdirSync, chmodSync } from "fs";
import { join, dirname } from "path";
import { tmux } from "../tmux/driver";
import { joyStateDir } from "../paths";
import { saveWindowRecord } from "../domain/windowRecord";
import {
  createRelaySession, encodeUserMessage, encodeTurnEnd,
  type RelaySession,
} from "../relay/relay";
import type { SessionDeps, SessionStatus, SessionRecord, QueuedMessage, QueueState } from "../claude/session";
import type { DeliverySource } from "../domain/receipts";
import type { AgentSession } from "../domain/agentSession";
import { spawnCodexAppServer, CodexAppServerClient } from "./appServerClient";
import { CodexNormalizer, type CodexNotification } from "./normalize";
import { buildCodexAttachCommand } from "./attach";

export interface CodexInit {
  id: string;
  tmuxWindow: string;
  cwd: string;
  model?: string;
  effort?: string;
  permissionMode?: string;
  status: SessionStatus;
  startedAt: number;
  /** Resume an existing thread (recovery). */
  codexThreadId?: string;
  developerInstructions?: string;
}

export class CodexSession implements AgentSession {
  readonly id: string;
  readonly cwd: string;
  readonly model?: string;
  readonly effort?: string;
  status: SessionStatus;
  endReason?: string;
  claudeSessionId?: string = undefined; // n/a for codex
  transcriptPath?: string;              // the rollout path once known
  relaySessionId?: string;
  summary?: string;
  currentModel?: string;
  pid?: number;                          // app-server pid

  readonly tmuxWindow: string;
  #permissionMode: string;
  #startedAt: number;
  #deps: SessionDeps;

  #socketPath: string;
  #client: CodexAppServerClient | null = null;
  #proc: ChildProcess | null = null;
  #relay: RelaySession | null = null;
  #norm: CodexNormalizer;
  #threadId: string | null = null;
  #resumeThreadId?: string;
  #developerInstructions?: string;
  #thinking = false;
  #activeTurnId: string | null = null;
  #started = false;
  #archivePromise: Promise<boolean> | null = null;

  constructor(init: CodexInit, deps: SessionDeps) {
    this.id = init.id;
    this.cwd = init.cwd;
    this.model = init.model;
    this.effort = init.effort;
    this.status = init.status;
    this.tmuxWindow = init.tmuxWindow;
    this.#permissionMode = init.permissionMode ?? "yolo";
    this.#startedAt = init.startedAt;
    this.#deps = deps;
    this.#resumeThreadId = init.codexThreadId;
    this.#developerInstructions = init.developerInstructions;
    this.#socketPath = join(joyStateDir(), `codex-${init.id}.sock`);
    this.#norm = new CodexNormalizer();
  }

  get relayAttached(): boolean { return this.#relay !== null; }

  // ── lifecycle ──────────────────────────────────────────────────────────────

  attachRelay(rs: RelaySession, allowEnded = false): boolean {
    if (this.status === "ended" && !allowEnded) return false;
    this.#relay = rs;
    this.relaySessionId = rs.relaySessionId;
    if (this.status === "ended") rs.pausePull();
    // Inbound app messages → deliver to codex via turn/start.
    rs.onMessage = async (text, seq) => { await this.#onRelayMessage(text, seq); };
    // Output receipts persist through the same sink shape as claude.
    rs.setReceiptSink(() => { /* M1: receipts are informational; outbound rows
      are already exactly-once via localId dedup at the append layer. */ });
    this.#deps.onRelayAttached?.(this, rs);
    rs.start();
    void rs.updateJoyState(this.status === "ended" ? "detached" : "running");
    return true;
  }

  /** Start the app-server + thread AFTER the relay is attached. */
  beginWatching(): void {
    if (this.#started) return;
    this.#started = true;
    void this.#start();
  }

  async #start(): Promise<void> {
    try {
      // The app-server unix socket exposes danger-full-access execution — its
      // directory must be 0700 so other UIDs can't dial it (review #8).
      const dir = dirname(this.#socketPath);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      try { chmodSync(dir, 0o700); } catch { /* best effort (umask) */ }
      this.#proc = spawnCodexAppServer({ socketPath: this.#socketPath });
      this.#proc.stderr?.on("data", () => { /* swallow the bubblewrap notice */ });
      // spawn failures (e.g. missing codex binary) are ASYNC — not caught by
      // this try/catch — so handle them explicitly (review #9).
      this.#proc.on("error", (e) => { process.stderr.write(`[codex ${this.id}] app-server spawn error: ${e}\n`); if (this.status !== "ended") this.end("process_exited"); });
      this.#proc.on("exit", () => { if (this.status !== "ended") this.end("process_exited"); });
      this.pid = this.#proc.pid;

      // Give the server a moment to bind the socket, then connect (with retry).
      const client = new CodexAppServerClient();
      client.onNotification((n) => this.#onNotification(n));
      client.onServerRequest(() => ({ decision: "accept" })); // yolo: nothing should ask
      await this.#connectWithRetry(client);
      this.#client = client;

      if (this.#resumeThreadId) {
        const r = await client.threadResume(this.#resumeThreadId, { cwd: this.cwd, permissionMode: this.#permissionMode, developerInstructions: this.#developerInstructions });
        this.#threadId = r.threadId;
      } else {
        const r = await client.threadStart({ cwd: this.cwd, permissionMode: this.#permissionMode, model: this.model, developerInstructions: this.#developerInstructions });
        this.#threadId = r.threadId;
        this.transcriptPath = r.rolloutPath ?? undefined;
        // Mirror the effective model the thread resolved to (thread/start's
        // top-level `model` — there is no thread.model on notifications).
        if (r.model) { this.currentModel = r.model; void this.#relay?.updateModelCode(r.model); }
      }
      saveWindowRecord(this.id, { launchCwd: this.cwd, agent: "codex", codexThreadId: this.#threadId ?? undefined, codexSocketPath: this.#socketPath });
      if (this.status === "starting") this.status = "active";
      this.#deps.broadcast("session_update", this.toJSON());
      // Best-effort: launch the attach TUI in the tmux window (poll rollout →
      // codex --remote resume). Non-fatal if it can't attach.
      this.#launchAttach();
    } catch (e) {
      process.stderr.write(`[codex ${this.id}] start failed: ${e}\n`);
      this.end("process_exited");
    }
  }

  async #connectWithRetry(client: CodexAppServerClient): Promise<void> {
    let lastErr: unknown;
    for (let i = 0; i < 30; i++) {
      try { await client.connect(this.#socketPath); return; }
      catch (e) { lastErr = e; await new Promise((r) => setTimeout(r, 200)); }
    }
    throw new Error(`could not connect to app-server: ${lastErr}`);
  }

  #launchAttach(): void {
    if (!this.#threadId) return;
    const cmd = buildCodexAttachCommand(this.#socketPath, this.#threadId);
    void tmux.literal(this.tmuxWindow, cmd).then(() => tmux.key(this.tmuxWindow, "Enter")).catch(() => {});
  }

  // ── delivery (inbound app → codex) ──────────────────────────────────────────

  async #onRelayMessage(text: string, _seq: number): Promise<void> {
    if (this.status === "ended") return;
    await this.#deliver(text, { mirror: true });
  }

  async #deliver(text: string, opts: { mirror: boolean }): Promise<void> {
    const client = this.#client;
    if (!client || !this.#threadId) return;
    const clientId = randomUUID();
    if (opts.mirror) this.#relay?.send(encodeUserMessage(text, Date.now()));
    try {
      // Do NOT pass model/effort on every turn — that would overwrite a model
      // the user picked in the attached TUI (review #4). The thread setting
      // persists; a deliberate joy-side model change (M2) would send it once.
      await client.turnStart(this.#threadId, text, {
        clientUserMessageId: clientId,
        permissionMode: this.#permissionMode,
      });
    } catch (e) {
      process.stderr.write(`[codex ${this.id}] turn/start failed: ${e}\n`);
    }
  }

  // ── output (codex notifications → relay wire) ────────────────────────────────

  #onNotification(n: CodexNotification): void {
    // Only the ROOT thread's traffic drives this session. Subagents, reviews,
    // and forks run on their own thread ids on the same server and must not
    // contaminate the transcript / active turn (review #6).
    if (this.#threadId) {
      const p = n.params ?? {};
      const nThread = n.method === "thread/started"
        ? (p.thread as Record<string, unknown> | undefined)?.id
        : p.threadId;
      if (typeof nThread === "string" && nThread !== this.#threadId) return;
    }
    if (n.method === "turn/started") {
      const turn = (n.params?.turn ?? {}) as Record<string, unknown>;
      if (typeof turn.id === "string") this.#activeTurnId = turn.id;
    } else if (n.method === "turn/completed") {
      this.#activeTurnId = null;
    }
    for (const eff of this.#norm.handle(n)) {
      switch (eff.kind) {
        case "wire": this.#relay?.send(eff.record); break;
        case "thinking": this.#thinking = eff.value; this.#relay?.setThinking(eff.value); break;
        case "receipt": this.#relay?.stampReceiptOnLastQueued({ uuid: eff.uuid, turn: eff.turn }); break;
        case "model": this.currentModel = eff.code; void this.#relay?.updateModelCode(eff.code); break;
        case "context": void this.#relay?.updateContext(eff.tokens); break;
        case "confirmDispatch": /* delivery confirmed (app-side draft queue owns release) */ break;
      }
    }
  }

  // ── app-facing intake / queue (codex queues turns natively) ──────────────────

  busy(): boolean { return this.#thinking; }

  enqueue(text: string, opts?: { source?: DeliverySource; mirrorToRelay?: boolean; seq?: number; visible?: boolean; requireDurable?: boolean }): QueuedMessage {
    const id = String(Date.now());
    void this.#deliver(text, { mirror: opts?.mirrorToRelay ?? true });
    return { id, text, createdAt: Date.now() };
  }

  queueState(): QueueState {
    // Codex delivers immediately (native queueing); no daemon-side dispatch queue.
    return { queue: [], pendingCount: 0, hidden: [], inFlight: null, paused: false };
  }

  resumeQueue(): void { /* no dispatch queue to resume */ }
  editQueued(): boolean { return false; }
  cancelQueued(): boolean { return false; }
  reorderQueued(): boolean { return false; }

  async abort(): Promise<{ ok: true }> {
    if (this.#client && this.#threadId && this.#activeTurnId) {
      try { await this.#client.turnInterrupt(this.#threadId, this.#activeTurnId); } catch { /* best effort */ }
    }
    return { ok: true };
  }

  // ── pane / control (the tmux window hosts the attached TUI) ───────────────────

  async pane(color = false): Promise<{ ok: true; text: string }> {
    const r = await tmux.captureFresh(this.tmuxWindow, { color });
    return { ok: true, text: r.ok ? r.out : "" };
  }

  async resize(cols: number, rows: number): Promise<{ ok: boolean }> {
    const r = await tmux.command(["resize-window", "-t", this.tmuxWindow, "-x", String(cols), "-y", String(rows)]);
    return { ok: r.ok };
  }

  async sendRawKeys(script: string, opts?: { literal?: boolean }): Promise<{ ok: boolean; segments: number; error?: string }> {
    // Forward raw keys to the attached TUI (manual-intervention escape hatch).
    const r = opts?.literal ? await tmux.literal(this.tmuxWindow, script) : await tmux.key(this.tmuxWindow, script);
    return { ok: r.ok, segments: 1, error: r.ok ? undefined : "send failed" };
  }

  detectPermissionMode(): string | null { return this.#permissionMode; }

  async setPermissionMode(target: string): Promise<{ ok: boolean; mode?: string; error?: string }> {
    // Applied per-turn on the next turn/start (no pane cycling needed).
    this.#permissionMode = target;
    return { ok: true, mode: target };
  }

  transcript(): { lines: unknown[] } { return { lines: [] }; }

  // ── claude-hook surface (no-op for codex) ─────────────────────────────────────
  onHookEvent(): { ok: boolean } { return { ok: true }; }
  markCompacting(): void { /* codex compaction is server-side */ }
  reassertLifecycle(): void { void this.#relay?.updateJoyState(this.status === "ended" ? "detached" : "running"); }

  // ── teardown ──────────────────────────────────────────────────────────────

  end(reason: "killed" | "process_exited"): boolean {
    if (this.status === "ended") return false;
    this.status = "ended";
    this.endReason = reason;
    const relaySessionId = this.#relay?.relaySessionId ?? this.relaySessionId;
    try { this.#client?.close(); } catch { /* ignore */ }
    this.#client = null;
    try { this.#proc?.kill(); } catch { /* ignore */ }
    this.#proc = null;
    // Synthesize a cancellation ONLY for a genuinely open turn (a turn-start
    // was materialized with no terminal event) — using the real codex turn id
    // so it matches the normalizer's turn-start (review #6).
    if (this.#activeTurnId) {
      try { this.#relay?.send(encodeTurnEnd("cancelled", { turn: this.#activeTurnId })); } catch { /* ignore */ }
      this.#activeTurnId = null;
    }
    if (this.#relay) this.#relay.setThinking(false);
    tmux.untrack(this.tmuxWindow);
    if (reason === "process_exited") {
      void this.#relay?.updateJoyState("detached");
      this.#relay?.pausePull();
    } else {
      void this.#relay?.updateJoyState("archived");
      if (this.#deps.relayClient && relaySessionId) this.#archivePromise = this.#deps.relayClient.archiveSession(relaySessionId);
      try { void tmux.command(["kill-window", "-t", this.tmuxWindow]); } catch { /* ignore */ }
      this.#relay?.stop();
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

  /** Create + attach a relay for this codex session (used by registry). */
  async createAndAttachRelay(): Promise<void> {
    if (!this.#deps.relayClient) return;
    const rs = await createRelaySession(this.#deps.relayClient, { tag: `joy-tmux-${this.id}`, cwd: this.cwd, id: this.id });
    this.attachRelay(rs);
  }
}
