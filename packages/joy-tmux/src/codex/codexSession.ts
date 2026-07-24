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
import { mkdirSync, chmodSync, rmSync, existsSync } from "fs";
import { join, dirname } from "path";
import { tmux } from "../tmux/driver";
import { joyStateDir } from "../paths";
import { saveWindowRecord, loadWindowRecord } from "../domain/windowRecord";
import {
  createRelaySession, encodeUserMessage, encodeTurnEnd,
  type RelaySession,
} from "../relay/relay";
import type { SessionDeps, SessionStatus, SessionRecord, QueuedMessage, QueueState } from "../claude/session";
import type { DeliverySource } from "../domain/receipts";
import type { AgentSession } from "../domain/agentSession";
import { spawnCodexAppServer, CodexAppServerClient, JsonRpcError } from "./appServerClient";
import { CodexNormalizer, type CodexNotification } from "./normalize";
import { buildCodexAttachCommand } from "./attach";
import { loadCodexInbound, saveCodexInbound, clearCodexInbound, type CodexInboundItem } from "./codexInboundStore";
import { loadDeliveredTurns, saveDeliveredTurns, clearDeliveredTurns } from "./codexCheckpointStore";

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
  // Durable inbound spool (review #1): app messages persisted before delivery.
  #inbound: CodexInboundItem[] = [];
  // Turns whose output was fully delivered — skipped wholesale on reconcile
  // (item ids differ live vs history, but turn ids are stable — review #2).
  #deliveredTurns = new Set<string>();

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
      const client = new CodexAppServerClient();
      client.onNotification((n) => this.#onNotification(n));
      client.onServerRequest((req) => this.#onServerRequest(req));

      // Orphan rejoin (review #5): if a live app-server already answers on our
      // socket — it survived a daemon crash — reuse it (rejoining the live
      // thread + any in-flight turn) instead of spawning a duplicate.
      let rejoined = false;
      if (existsSync(this.#socketPath)) {
        try {
          await client.connect(this.#socketPath);
          rejoined = true;
          const rec = loadWindowRecord(this.id);
          if (rec?.codexServerPid) this.pid = rec.codexServerPid; // so end() can kill it
          process.stderr.write(`[codex ${this.id}] rejoined orphan app-server\n`);
        } catch { /* not alive — spawn a fresh one below */ }
      }

      if (!rejoined) {
        // The app-server unix socket exposes danger-full-access execution — its
        // directory must be 0700 so other UIDs can't dial it (review #8).
        const dir = dirname(this.#socketPath);
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        try { chmodSync(dir, 0o700); } catch { /* best effort (umask) */ }
        try { rmSync(this.#socketPath, { force: true }); } catch { /* ignore */ } // remove stale socket file
        this.#proc = spawnCodexAppServer({ socketPath: this.#socketPath });
        this.#proc.stderr?.on("data", () => { /* swallow the bubblewrap notice */ });
        // spawn failures (e.g. missing codex binary) are ASYNC — not caught by
        // this try/catch — so handle them explicitly (review #9).
        this.#proc.on("error", (e) => { process.stderr.write(`[codex ${this.id}] app-server spawn error: ${e}\n`); if (this.status !== "ended") this.end("process_exited"); });
        this.#proc.on("exit", () => { if (this.status !== "ended") this.end("process_exited"); });
        this.pid = this.#proc.pid;
        await this.#connectWithRetry(client);
      }
      this.#client = client;

      if (this.#resumeThreadId) {
        // Recover the persisted inbound spool + delivered-turn checkpoint BEFORE
        // reconciling — the checkpoint tells reconcile which turns to skip, and
        // reconcile's userMessage echoes remove delivered inbound entries.
        this.#inbound = loadCodexInbound(this.id);
        this.#deliveredTurns = loadDeliveredTurns(this.id);
        const r = await client.threadResume(this.#resumeThreadId, { cwd: this.cwd, permissionMode: this.#permissionMode, developerInstructions: this.#developerInstructions });
        this.#threadId = r.threadId;
        this.#norm.setThreadId(r.threadId);
        // Reconcile missed output: replay thread history through the SAME
        // normalizer. Deterministic localIds make re-sent rows idempotent at
        // the relay append layer, so already-delivered events are deduped.
        await this.#reconcileHistory(client);
      } else {
        // Fresh conversation: no prior inbound / checkpoint belongs to it.
        clearCodexInbound(this.id);
        clearDeliveredTurns(this.id);
        this.#inbound = [];
        this.#deliveredTurns = new Set();
        const r = await client.threadStart({ cwd: this.cwd, permissionMode: this.#permissionMode, model: this.model, developerInstructions: this.#developerInstructions });
        this.#threadId = r.threadId;
        this.#norm.setThreadId(r.threadId);
        this.transcriptPath = r.rolloutPath ?? undefined;
        // Mirror the effective model the thread resolved to (thread/start's
        // top-level `model` — there is no thread.model on notifications).
        if (r.model) { this.currentModel = r.model; void this.#relay?.updateModelCode(r.model); }
      }
      // Deliver anything spooled (queued during startup, or undelivered after
      // a resume+reconcile).
      await this.#drainInbound();
      saveWindowRecord(this.id, {
        launchCwd: this.cwd, agent: "codex",
        codexThreadId: this.#threadId ?? undefined,
        codexSocketPath: this.#socketPath,
        codexServerPid: this.#proc?.pid,
        codexSettings: { model: this.model, effort: this.effort, permissionMode: this.#permissionMode, developerInstructions: this.#developerInstructions },
      });
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
    // Persist BEFORE anything else and THROW on failure so the relay's
    // confirmed cursor does not advance past an unpersisted message (a lost
    // inbound message is worse than a redelivered one — review #1).
    const item: CodexInboundItem = { clientId: randomUUID(), text, state: "queued", at: Date.now() };
    this.#inbound.push(item);
    if (!saveCodexInbound(this.id, this.#inbound)) {
      this.#inbound.pop();
      throw new Error("codex inbound persist failed");
    }
    if (this.#relay) this.#relay.send(encodeUserMessage(text, item.at));
    await this.#deliverItem(item);
  }

  /** turn/start a spooled item with its STABLE clientUserMessageId. On success
   *  → 'sentUnknown' (the echo confirms delivery, not this return). On failure
   *  leave it 'queued' and do NOT resend now (resending could double). */
  async #deliverItem(item: CodexInboundItem): Promise<void> {
    const client = this.#client;
    if (!client || !this.#threadId) return; // not ready yet — drained after start
    try {
      // Do NOT pass model/effort on every turn — that would overwrite a model
      // the user picked in the attached TUI (review #4).
      await client.turnStart(this.#threadId, item.text, {
        clientUserMessageId: item.clientId,
        permissionMode: this.#permissionMode,
      });
      if (item.state === "queued") { item.state = "sentUnknown"; saveCodexInbound(this.id, this.#inbound); }
    } catch (e) {
      process.stderr.write(`[codex ${this.id}] turn/start failed: ${e}\n`);
    }
  }

  /** A userMessage echo (live or from history replay) confirms delivery —
   *  remove the spooled entry. */
  #onDispatchEchoed(clientId: string): void {
    const before = this.#inbound.length;
    this.#inbound = this.#inbound.filter((i) => i.clientId !== clientId);
    if (this.#inbound.length !== before) saveCodexInbound(this.id, this.#inbound);
  }

  /** Deliver every still-spooled item. Called after the thread is ready (fresh
   *  start) and after resume+reconcile (where echoed items were already
   *  removed, so the remainder is genuinely undelivered). */
  async #drainInbound(): Promise<void> {
    for (const item of [...this.#inbound]) await this.#deliverItem(item);
  }

  // ── server→client requests (approvals / elicitations) ───────────────────────
  // v1 is yolo (approvalPolicy 'never'), so ordinary command/patch approvals
  // shouldn't fire — but respond with the CORRECT per-method shape if they do,
  // and JSON-RPC-error anything we can't answer rather than sending an invalid
  // {decision:'accept'} to every method (review #3). Non-yolo approval cards in
  // the app are M2.
  #onServerRequest(req: { id: number | string; method: string; params?: Record<string, unknown> }): unknown {
    switch (req.method) {
      // v2 command/patch approval families — accept under yolo.
      case "item/commandExecution/requestApproval":
      case "item/fileChange/requestApproval":
        return { decision: "accept" };
      // Legacy-named approval methods still in the 0.144.6 schema.
      case "execCommandApproval":
      case "applyPatchApproval":
        return { decision: "approved" };
      // Can't answer meaningfully in v1 — reject so the server proceeds/cancels
      // rather than wedging on a wrong-shaped success.
      case "item/tool/requestUserInput":
      case "mcpServer/elicitation/request":
      case "item/permissions/requestApproval":
        throw new JsonRpcError(-32601, `joy v1 cannot answer ${req.method}`);
      // We don't own ChatGPT tokens; surface as unanswerable, not fake creds.
      case "account/chatgptAuthTokens/refresh":
        throw new JsonRpcError(-32601, "joy does not manage codex auth tokens");
      default:
        throw new JsonRpcError(-32601, `unhandled server request: ${req.method}`);
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
      const turn = (n.params?.turn ?? {}) as Record<string, unknown>;
      // A completed turn's output is fully delivered — checkpoint it so a
      // future reconcile skips it (its items won't be double-shown).
      if (typeof turn.id === "string") { this.#deliveredTurns.add(turn.id); saveDeliveredTurns(this.id, this.#deliveredTurns); }
      this.#activeTurnId = null;
    }
    this.#applyEffects(this.#norm.handle(n));
  }

  #applyEffects(effects: ReturnType<CodexNormalizer["handle"]>): void {
    for (const eff of effects) {
      switch (eff.kind) {
        case "wire": this.#relay?.send(eff.record, eff.localId); break;
        case "thinking": this.#thinking = eff.value; this.#relay?.setThinking(eff.value); break;
        case "receipt": this.#relay?.stampReceiptOnLastQueued({ uuid: eff.uuid, turn: eff.turn }); break;
        case "model": this.currentModel = eff.code; void this.#relay?.updateModelCode(eff.code); break;
        case "context": void this.#relay?.updateContext(eff.tokens); break;
        case "confirmDispatch": this.#onDispatchEchoed(eff.clientId); break;
      }
    }
  }

  /** Replay thread history through the SAME normalizer on resume. Deterministic
   *  localIds make re-sent rows idempotent (the relay append layer dedupes what
   *  the app already has); only output missed during downtime is delivered. */
  async #reconcileHistory(client: CodexAppServerClient): Promise<void> {
    if (!this.#threadId) return;
    try {
      const res = await client.threadRead(this.#threadId);
      const thread = ((res.thread ?? res) as Record<string, unknown>);
      const turns = Array.isArray(thread.turns) ? thread.turns as Record<string, unknown>[] : [];
      for (const turn of turns) {
        const tid = String(turn.id ?? "");
        if (!tid) continue;
        // Already delivered before the restart — skip wholesale (its item ids
        // in history differ from the live ones, so replaying would double-show).
        if (this.#deliveredTurns.has(tid)) continue;
        this.#applyEffects(this.#norm.handle({ method: "turn/started", params: { turn: { id: tid } } }));
        const items = Array.isArray(turn.items) ? turn.items as Record<string, unknown>[] : [];
        for (const item of items) {
          const t = String(item.type ?? "");
          // Tool items produce start+end; feed both so localIds match the live path.
          if (t === "commandExecution" || t === "fileChange" || t === "mcpToolCall") {
            this.#applyEffects(this.#norm.handle({ method: "item/started", params: { turnId: tid, item } }));
          }
          this.#applyEffects(this.#norm.handle({ method: "item/completed", params: { turnId: tid, item } }));
        }
        this.#applyEffects(this.#norm.handle({ method: "turn/completed", params: { turn: { id: tid, status: turn.status ?? "completed" } } }));
        // A replayed (previously-undelivered) completed turn is now delivered.
        if ((turn.status ?? "completed") !== "inProgress") { this.#deliveredTurns.add(tid); }
      }
      saveDeliveredTurns(this.id, this.#deliveredTurns);
    } catch (e) {
      process.stderr.write(`[codex ${this.id}] history reconcile failed: ${e}\n`);
    }
  }

  // ── app-facing intake / queue (codex queues turns natively) ──────────────────

  busy(): boolean { return this.#thinking; }

  enqueue(text: string, opts?: { source?: DeliverySource; mirrorToRelay?: boolean; seq?: number; visible?: boolean; requireDurable?: boolean }): QueuedMessage {
    const item: CodexInboundItem = { clientId: randomUUID(), text, state: "queued", at: Date.now() };
    this.#inbound.push(item);
    if (!saveCodexInbound(this.id, this.#inbound) && opts?.requireDurable) {
      this.#inbound.pop();
      throw new Error("codex inbound persist failed");
    }
    if ((opts?.mirrorToRelay ?? true) && this.#relay) this.#relay.send(encodeUserMessage(text, item.at));
    void this.#deliverItem(item);
    return { id: String(item.at), text, createdAt: item.at };
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
    // Kill the app-server: our own child, or (when we rejoined an orphan) the
    // recovered pid.
    try { if (this.#proc) this.#proc.kill(); else if (this.pid) process.kill(this.pid); } catch { /* ignore */ }
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
      clearCodexInbound(this.id); // a killed session will never deliver — drop the spool
      clearDeliveredTurns(this.id);
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
