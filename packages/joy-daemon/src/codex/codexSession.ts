// CodexSession — the AgentSession implementation for OpenAI's codex, driven via
// the app-server (JSON-RPC over a per-session unix socket) instead of a claude
// TUI + transcript. It reproduces the SAME wire output the claude Session emits
// (via CodexNormalizer) so the app renders both identically.
//
// M2 durability model (post gpt-5.6-sol review):
//  - INBOUND: app messages persist to a durable spool BEFORE the socket write;
//    dedupe by relay seq; deterministic clientId per seq; explicit reject →
//    requeue, ambiguous → hold. The daemon owns a FIFO — one turn/start at a
//    time (codex has no native turn queue).
//  - OUTBOUND: turn identity is the stable codex turn id; item identity is a
//    canonical (turn, type, ordinal). Reconnect replays history through the same
//    normalizer; deterministic localIds dedupe at the relay append layer. A
//    turn is checkpointed as delivered only AFTER its terminal row is ACKed.
//  - RECOVERY: rejoin a live app-server transactionally (connect+resume+read),
//    else spawn fresh and thread/resume.

import { randomUUID } from "crypto";
import { type ChildProcess } from "child_process";
import { mkdirSync, chmodSync, rmSync, existsSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { tmux as defaultTmux, disposeTmuxHandle, type TmuxDriver } from "../tmux/driver";
import { joyStateDir } from "../paths";
import { saveWindowRecord, loadWindowRecord, deleteWindowRecord } from "../domain/windowRecord";
import {
  createRelaySession, encodeUserMessage, encodeTurnEnd,
  type RelaySession,
} from "../relay/relay";
import type { SessionDeps, SessionStatus, SessionRecord, QueuedMessage, QueueState } from "../claude/session";
import type { DeliverySource } from "../domain/receipts";
import type { AgentSession } from "../domain/agentSession";
import { codexJoyInstructions, joyPromptReinjection } from "../domain/agentTagsPrompt";
import { spawnCodexAppServer, CodexAppServerClient, JsonRpcError, JsonRpcResponseError } from "./appServerClient";
import { CodexNormalizer, type CodexNotification } from "./normalize";
import { buildCodexAttachCommand } from "./attach";
import { loadCodexInbound, saveCodexInbound, clearCodexInbound, type CodexInboundItem } from "./codexInboundStore";
import {
  loadCheckpoint, saveCheckpoint, clearCheckpoint, isTurnDelivered, markTurnDelivered,
  type CodexCheckpoint,
} from "./codexCheckpointStore";

export interface CodexInit {
  id: string;
  tmuxWindow: string;
  tmux?: TmuxDriver;
  tmuxSocket?: string | null;
  cwd: string;
  model?: string;
  effort?: string;
  permissionMode?: string;
  status: SessionStatus;
  startedAt: number;
  /** Resume an existing thread (recovery). */
  codexThreadId?: string;
  developerInstructions?: string;
  /** True when this session's relay card is NEW but the thread has history
   *  (restart / resume-by-id / continue) — reconcile then replays user rows
   *  too, since no prior card carries them. */
  freshCard?: boolean;
  /** `-c key=value` config overrides for the app-server spawn (user extraArgs). */
  config?: Record<string, string>;
}

interface PendingApproval {
  info: { requestId: string; kind: "command" | "patch"; title: string; detail?: string; since: number; threadId?: string; turnId?: string; itemId?: string };
  answer: (allow: boolean) => void;
}

export class CodexSession implements AgentSession {
  readonly agentFlavor = "codex" as const;
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
  currentEffort?: string;
  pid?: number;                          // app-server pid

  readonly tmuxWindow: string;
  readonly #tmux: TmuxDriver;
  readonly #tmuxSocket: string | null;
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
  #config?: Record<string, string>;
  #thinking = false;
  // Reasoning effort to apply on the NEXT turn only, then clear — codex persists
  // a turn/start override "for this and subsequent turns", so sending once is
  // enough and avoids clobbering an effort the user later picks in the attached
  // TUI. Seeded ONLY on a fresh create (never on resume/recover — finding #8:
  // re-seeding from stale local settings would overwrite an authoritative
  // resumed/TUI value).
  #pendingEffort: string | null = null;
  // FIFO turn serialization (finding #4): codex has no native turn queue, so a
  // second turn/start during an active turn can be rejected. We dispatch one
  // queued item only while no turn is active, re-draining on turn/completed.
  #activeTurnId: string | null = null;
  #dispatching = false;
  #started = false;
  #archivePromise: Promise<boolean> | null = null;
  // True when we REJOINED a live app-server (vs spawned a fresh one). On a
  // rejoin we must NOT resend 'sentUnknown' items — the live turn may still be
  // in flight and not yet in thread/read (finding #3c) — so we hold them
  // (at-most-once). On a fresh spawn the old server (and its in-flight turn)
  // died, so unconfirmed sends are requeued (at-least-once).
  #rejoined = false;
  // /title lock (parity with claude/opencode): a user-set title beats agent
  // <joy-title> emissions. Loaded from the window record.
  #titleLocked = false;
  #freshCard = false;
  // Durable inbound spool (finding #3): app messages persisted before delivery.
  // Loaded in the constructor BEFORE the relay starts pulling (finding #3 race).
  #inbound: CodexInboundItem[] = [];
  // Delivered-turn checkpoint — advanced only on terminal-row ACK (finding #2).
  #checkpoint: CodexCheckpoint;
  // Notifications are BUFFERED from connect until reconcile finishes (finding
  // #10): the thread filter is inactive until #threadId is known, and live
  // traffic must not interleave with synthetic history replay.
  #buffering = true;
  #notifBuffer: CodexNotification[] = [];
  // Codex approval requests awaiting the app (non-yolo). Insertion-ordered Map
  // = a FIFO; the app bar always shows the HEAD (finding #6).
  #pendingApprovals = new Map<string, PendingApproval>();

  constructor(init: CodexInit, deps: SessionDeps) {
    this.id = init.id;
    this.cwd = init.cwd;
    this.model = init.model;
    this.effort = init.effort;
    this.status = init.status;
    this.tmuxWindow = init.tmuxWindow;
    this.#tmux = init.tmux ?? defaultTmux;
    this.#tmuxSocket = init.tmuxSocket ?? null;
    // Fail closed: an absent mode becomes the collaborative default, NOT yolo
    // (finding #1 — resolveCodexExecutionPolicy also fails closed).
    this.#permissionMode = init.permissionMode ?? "default";
    this.#startedAt = init.startedAt;
    this.#deps = deps;
    this.#resumeThreadId = init.codexThreadId;
    this.#developerInstructions = init.developerInstructions;
    this.#freshCard = init.freshCard === true;
    this.#titleLocked = loadWindowRecord(this.id)?.titleLockedByUser === true;
    this.#config = init.config;
    this.#socketPath = join(joyStateDir(), `codex-${init.id}.sock`);
    this.#norm = new CodexNormalizer();
    // Load durable state SYNCHRONOUSLY here, before attachRelay starts the relay
    // pull, so an inbound message can't race the load (finding #3 startup race).
    if (init.codexThreadId) {
      this.#inbound = loadCodexInbound(init.id);
      this.#checkpoint = loadCheckpoint(init.id);
      // Do NOT seed pendingEffort on resume/recover (finding #8).
    } else {
      clearCodexInbound(init.id);
      clearCheckpoint(init.id);
      this.#inbound = [];
      this.#checkpoint = { threadId: null, deliveredThroughTurnId: null };
      this.#pendingEffort = init.effort ?? null; // fresh session: apply on turn 1
    }
  }

  get relayAttached(): boolean { return this.#relay !== null; }
  /** The codex thread id, once known — used by registry.restart to resume the
   *  SAME thread even when the persisted record is absent (finding #7). */
  get codexThreadId(): string | undefined { return this.#threadId ?? this.#resumeThreadId; }

  // ── lifecycle ──────────────────────────────────────────────────────────────

  attachRelay(rs: RelaySession, allowEnded = false): boolean {
    if (this.status === "ended" && !allowEnded) return false;
    this.#relay = rs;
    this.relaySessionId = rs.relaySessionId;
    if (this.status === "ended") rs.pausePull();
    // Terminal-row receipt → advance the delivered-turn checkpoint (finding #2).
    // The receipt effect for a turn's turn-end row carries its turn id.
    rs.setReceiptSink((r) => { this.#markTurnDelivered(r.turn); });
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
    this.#buffering = true;
    try {
      // Transactional rejoin (finding #7): only trust a live orphan server after
      // connect + resume + read + validate all succeed. Any failure → fresh spawn.
      let client: CodexAppServerClient | null = null;
      if (this.#resumeThreadId && existsSync(this.#socketPath)) {
        client = await this.#tryRejoin();
      }
      if (!client) {
        client = await this.#spawnFresh();
      }
      this.#client = client;

      // Deliver anything spooled once reconcile has settled the confirmed set.
      // Fresh spawn: the old server + its in-flight turn are gone, so requeue
      // unconfirmed 'sentUnknown' items (at-least-once). Rejoin: hold them.
      if (!this.#rejoined) {
        for (const it of this.#inbound) if (it.state === "sentUnknown") it.state = "queued";
        saveCodexInbound(this.id, this.#inbound);
      }

      // Reconcile done → resume live notification flow (flush buffered).
      this.#buffering = false;
      this.#flushNotifBuffer();

      this.#pumpDispatch();
      this.#persistWindowRecord();
      if (this.status === "starting") this.status = "active";
      this.#deps.broadcast("session_update", this.toJSON());
      this.#launchAttach();
    } catch (e) {
      process.stderr.write(`[codex ${this.id}] start failed: ${e}\n`);
      this.end("process_exited");
    }
  }

  /** Attempt to rejoin a live orphaned app-server. Returns the connected client
   *  ONLY if the full transaction (connect → resume → read+validate) succeeds;
   *  otherwise tears down and returns null so the caller spawns fresh. */
  async #tryRejoin(): Promise<CodexAppServerClient | null> {
    const client = new CodexAppServerClient();
    this.#wireClient(client);
    try {
      await client.connect(this.#socketPath);
      const rec = loadWindowRecord(this.id);
      const r = await client.threadResume(this.#resumeThreadId!, {
        cwd: this.cwd, permissionMode: this.#permissionMode, developerInstructions: this.#developerInstructions,
      });
      if (r.threadId !== this.#resumeThreadId) throw new Error(`resumed wrong thread ${r.threadId} != ${this.#resumeThreadId}`);
      this.#threadId = r.threadId;
      this.#norm.setThreadId(r.threadId);
      this.#applyResumeSettings(r);
      // Mark rejoined BEFORE reconcile so it leaves any in-progress turn OPEN
      // (a live orphan whose real notifications will arrive) rather than closing
      // it (finding #5).
      this.#rejoined = true;
      await this.#reconcileHistory(client); // proves the thread is readable
      if (rec?.codexServerPid) this.pid = rec.codexServerPid; // so end() can kill it
      // Persist the (unchanged) thread binding + recovered pid immediately.
      this.#persistWindowRecord();
      process.stderr.write(`[codex ${this.id}] rejoined orphan app-server thread=${r.threadId}\n`);
      return client;
    } catch (e) {
      process.stderr.write(`[codex ${this.id}] rejoin failed (${e}) — spawning fresh\n`);
      try { client.close(); } catch { /* ignore */ }
      // Reset any partial state so the fresh path starts clean.
      this.#threadId = null;
      this.#rejoined = false;
      return null;
    }
  }

  /** Spawn a fresh app-server and thread/start (new) or thread/resume (recover).
   *  Verifies + reaps a recorded-but-unrejoinable server before unlinking. */
  async #spawnFresh(): Promise<CodexAppServerClient> {
    const client = new CodexAppServerClient();
    this.#wireClient(client);

    // If a prior server pid is recorded and is verifiably ours-and-alive but we
    // couldn't rejoin it, reap it before taking over the socket (finding #7).
    const rec = loadWindowRecord(this.id);
    if (rec?.codexServerPid && this.#isOurServer(rec.codexServerPid)) {
      try { process.kill(rec.codexServerPid); } catch { /* already gone */ }
    }

    // The app-server unix socket exposes danger-full-access execution — its
    // directory must be 0700 so other UIDs can't dial it.
    const dir = dirname(this.#socketPath);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try { chmodSync(dir, 0o700); } catch { /* best effort (umask) */ }
    try { rmSync(this.#socketPath, { force: true }); } catch { /* ignore */ }

    this.#proc = spawnCodexAppServer({ socketPath: this.#socketPath, config: this.#config, joySessionId: this.id });
    this.#proc.stderr?.on("data", () => { /* swallow the bubblewrap notice */ });
    this.#proc.on("error", (e) => { process.stderr.write(`[codex ${this.id}] app-server spawn error: ${e}\n`); if (this.status !== "ended") this.end("process_exited"); });
    this.#proc.on("exit", () => { if (this.status !== "ended") this.end("process_exited"); });
    this.pid = this.#proc.pid;
    // Persist the pid RIGHT AWAY so a crash before thread/start still leaves a
    // reapable binding (finding #7).
    this.#persistWindowRecord();

    await this.#connectWithRetry(client);

    if (this.#resumeThreadId) {
      const r = await client.threadResume(this.#resumeThreadId, {
        cwd: this.cwd, permissionMode: this.#permissionMode, developerInstructions: this.#developerInstructions,
      });
      this.#threadId = r.threadId;
      this.#norm.setThreadId(r.threadId);
      this.#persistWindowRecord(); // bind thread id immediately after the response
      this.#applyResumeSettings(r);
      await this.#reconcileHistory(client);
    } else {
      const r = await client.threadStart({ cwd: this.cwd, permissionMode: this.#permissionMode, model: this.model, developerInstructions: this.#developerInstructions });
      this.#threadId = r.threadId;
      this.#norm.setThreadId(r.threadId);
      this.transcriptPath = r.rolloutPath ?? undefined;
      this.#checkpoint = { ...this.#checkpoint, threadId: r.threadId };
      this.#persistWindowRecord();
      if (r.model) { this.currentModel = r.model; void this.#relay?.updateModelCode(r.model); }
    }
    return client;
  }

  /** Wire the notification / server-request / close handlers onto a client. */
  #wireClient(client: CodexAppServerClient): void {
    client.onNotification((n) => this.#onNotification(n));
    client.onServerRequest((req) => this.#onServerRequest(req));
    // Socket close (server died / killed) ends the session — for BOTH the
    // spawned and rejoined paths (finding #7: rejoin previously had no signal).
    client.onClose(() => { if (this.status !== "ended") this.end("process_exited"); });
  }

  /** Apply the authoritative model/effort a thread/resume returned (finding #8)
   *  — these override any stale local settings. */
  #applyResumeSettings(r: { model: string | null; reasoningEffort: string | null }): void {
    if (r.model) { this.currentModel = r.model; void this.#relay?.updateModelCode(r.model); }
    if (r.reasoningEffort) this.currentEffort = r.reasoningEffort;
    this.#checkpoint = { ...this.#checkpoint, threadId: this.#threadId };
  }

  /** Is `pid` actually one of OUR codex app-servers (not a recycled pid)? Guards
   *  process.kill from hitting an unrelated process (finding #7). */
  #isOurServer(pid: number): boolean {
    try {
      const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8");
      return cmdline.includes("app-server") && cmdline.includes(this.#socketPath);
    } catch { return false; }
  }

  async #connectWithRetry(client: CodexAppServerClient): Promise<void> {
    let lastErr: unknown;
    for (let i = 0; i < 30; i++) {
      if (this.#proc && this.#proc.exitCode !== null) throw new Error(`app-server exited during startup (code ${this.#proc.exitCode})`);
      try { await client.connect(this.#socketPath); return; }
      catch (e) { lastErr = e; await new Promise((r) => setTimeout(r, 200)); }
    }
    throw new Error(`could not connect to app-server: ${lastErr}`);
  }

  /** /joy-prompt — re-deliver the CURRENT joy instructions in-band (the
   *  thread's developerInstructions are frozen at start, and attention decays
   *  in long sessions regardless). Also refreshes the stored
   *  developerInstructions so a thread restart launches with the latest
   *  wording. The reinjection body is delivered as its own unmirrored message;
   *  only the /joy-prompt row (when mirror) appears in chat. */
  #handleJoyPrompt(text: string, mirror: boolean, seq?: number): boolean {
    if (!/^\/joy-prompt(?:\s|$)/.test(text.trim())) return false;
    this.#developerInstructions = codexJoyInstructions();
    this.#persistWindowRecord();
    if (mirror && this.#relay) this.#relay.send(encodeUserMessage(text, Date.now()), `codex:in:${this.id}:${seq ?? Date.now()}`);
    this.enqueue(joyPromptReinjection(codexJoyInstructions()), { mirrorToRelay: false });
    return true;
  }

  #persistWindowRecord(): void {
    saveWindowRecord(this.id, {
      launchCwd: this.cwd, agent: "codex",
      codexThreadId: this.#threadId ?? this.#resumeThreadId ?? undefined,
      codexSocketPath: this.#socketPath,
      codexServerPid: this.#proc?.pid ?? this.pid,
      codexSettings: { model: this.currentModel ?? this.model, effort: this.currentEffort ?? this.effort, permissionMode: this.#permissionMode, developerInstructions: this.#developerInstructions, config: this.#config },
    });
  }

  #launchAttach(): void {
    if (!this.#threadId) return;
    const cmd = buildCodexAttachCommand(this.#socketPath, this.#threadId);
    void this.#tmux.literal(this.tmuxWindow, cmd).then(() => this.#tmux.key(this.tmuxWindow, "Enter")).catch(() => {});
  }

  // ── delivery (app → codex) ──────────────────────────────────────────────────

  /** FIFO dispatch pump (finding #4). Sends ONE queued item's turn/start only
   *  when no turn is active; re-invoked on turn/completed, explicit rejection,
   *  and recovery. Single-flight via #dispatching. */
  #pumpDispatch(): void {
    if (this.status === "ended") return;
    if (this.#dispatching || this.#activeTurnId) return;
    if (!this.#client || !this.#threadId) return; // not ready — drained after start
    const item = this.#inbound.find((i) => i.state === "queued");
    if (!item) return;
    this.#dispatching = true;
    void this.#dispatch(item).finally(() => { this.#dispatching = false; });
  }

  async #dispatch(item: CodexInboundItem): Promise<void> {
    const client = this.#client;
    if (!client || !this.#threadId) return;
    // Persist 'sentUnknown' BEFORE the socket write (finding #3d): a crash after
    // codex accepts but before the response is processed must NOT leave it
    // 'queued' (which would blindly resend). Ambiguous outcomes stay sentUnknown.
    item.state = "sentUnknown";
    saveCodexInbound(this.id, this.#inbound);
    try {
      const { turnId } = await client.turnStart(this.#threadId, item.text, {
        clientUserMessageId: item.clientId,
        permissionMode: this.#permissionMode,
        effort: this.#pendingEffort ?? undefined,
      });
      this.#pendingEffort = null; // applied (codex persists it thread-side)
      this.#activeTurnId = turnId; // serialize: no further dispatch until this completes
    } catch (e) {
      if (e instanceof JsonRpcResponseError) {
        // EXPLICIT server rejection (definitely not accepted) → safe to requeue.
        // Common cause: a turn is already active — the pending turn/completed
        // (or turn/started, which sets #activeTurnId) will re-trigger the pump,
        // so we do NOT hot-loop by re-pumping here.
        item.state = "queued";
        saveCodexInbound(this.id, this.#inbound);
        process.stderr.write(`[codex ${this.id}] turn/start rejected (${e.code}) — requeued\n`);
      } else {
        // AMBIGUOUS (timeout / socket loss): it MIGHT have landed — hold as
        // sentUnknown (at-most-once) rather than risk a duplicate turn.
        process.stderr.write(`[codex ${this.id}] turn/start ambiguous failure: ${e}\n`);
      }
    }
  }

  /** A userMessage echo (live or from history replay) confirms delivery —
   *  remove the spooled entry. */
  #onDispatchEchoed(clientId: string): void {
    const before = this.#inbound.length;
    this.#inbound = this.#inbound.filter((i) => i.clientId !== clientId);
    if (this.#inbound.length !== before) saveCodexInbound(this.id, this.#inbound);
  }

  #markTurnDelivered(turnId: string): void {
    if (!turnId) return;
    const next = markTurnDelivered(this.#checkpoint, turnId);
    if (next !== this.#checkpoint) { this.#checkpoint = next; saveCheckpoint(this.id, this.#checkpoint); }
  }

  // ── server→client requests (approvals / elicitations) ───────────────────────
  #onServerRequest(req: { id: number | string; method: string; params?: Record<string, unknown> }): unknown {
    const p = req.params ?? {};
    switch (req.method) {
      case "item/commandExecution/requestApproval":
      case "execCommandApproval": {
        const cmd = Array.isArray(p.command) ? (p.command as string[]).join(" ") : String(p.command ?? "run a command");
        return this.#surfaceApproval(req, "command", cmd, typeof p.reason === "string" ? p.reason : undefined);
      }
      case "item/fileChange/requestApproval":
      case "applyPatchApproval": {
        const files = Array.isArray(p.fileChanges) ? (p.fileChanges as unknown[]).length : (Array.isArray(p.changes) ? (p.changes as unknown[]).length : 0);
        return this.#surfaceApproval(req, "patch", files ? `Apply patch to ${files} file(s)` : "Apply patch", typeof p.reason === "string" ? p.reason : undefined);
      }
      // Can't answer meaningfully — reject so the server proceeds/cancels rather
      // than wedging on a wrong-shaped success. NOTE: item/permissions,
      // requestUserInput and MCP elicitation each have DISTINCT response shapes
      // we don't yet implement, so turns needing them will fail (non-yolo
      // support is command/patch approvals only — NOT comprehensive).
      case "item/tool/requestUserInput":
      case "mcpServer/elicitation/request":
      case "item/permissions/requestApproval":
        throw new JsonRpcError(-32601, `joy cannot answer ${req.method}`);
      case "account/chatgptAuthTokens/refresh":
        throw new JsonRpcError(-32601, "joy does not manage codex auth tokens");
      default:
        throw new JsonRpcError(-32601, `unhandled server request: ${req.method}`);
    }
  }

  /** Hold a codex approval request until the app answers (or a timeout auto-
   *  declines so codex isn't wedged). FIFO: the app bar always shows the head. */
  #surfaceApproval(req: { id: number | string; method: string; params?: Record<string, unknown> }, kind: "command" | "patch", title: string, detail?: string): Promise<unknown> {
    const requestId = String(req.id);
    const legacy = req.method === "execCommandApproval" || req.method === "applyPatchApproval";
    const p = req.params ?? {};
    return new Promise((resolve) => {
      const done = (allow: boolean) => resolve(legacy ? { decision: allow ? "approved" : "denied" } : { decision: allow ? "accept" : "decline" });
      const timer = setTimeout(() => { if (this.#pendingApprovals.delete(requestId)) { this.#publishApprovalHead(); done(false); } }, 300_000);
      this.#pendingApprovals.set(requestId, {
        info: { requestId, kind, title, detail, since: Date.now(), threadId: this.#threadId ?? undefined, turnId: typeof p.turnId === "string" ? p.turnId : undefined, itemId: typeof p.itemId === "string" ? p.itemId : undefined },
        answer: (allow) => { clearTimeout(timer); this.#pendingApprovals.delete(requestId); this.#publishApprovalHead(); done(allow); },
      });
      this.#publishApprovalHead();
    });
  }

  /** Publish the current head of the approval FIFO to the app bar (or clear it
   *  when none remain) — so a second concurrent request surfaces after the
   *  first is resolved (finding #6). */
  #publishApprovalHead(): void {
    const head = this.#pendingApprovals.values().next().value as PendingApproval | undefined;
    void this.#relay?.updateCodexApproval(head ? head.info : null);
  }

  /** Every approval codex is holding, oldest first (joy approvals / check). */
  listApprovals(): Array<{ requestId: string; kind: string; title: string; detail?: string; since: number }> {
    return [...this.#pendingApprovals.values()].map((p) => ({
      requestId: p.info.requestId, kind: p.info.kind, title: p.info.title, detail: p.info.detail, since: p.info.since,
    }));
  }
  /** The app answers the head approval (POST /v2/sessions/:id/approvals over
   *  the tunnel — transports/v2.ts). */
  answerApproval(params: Record<string, unknown> | undefined): { ok: boolean } {
    const requestId = String(params?.requestId ?? "");
    const allow = params?.decision === "allow" || params?.decision === true;
    const p = this.#pendingApprovals.get(requestId);
    if (!p) return { ok: false };
    p.answer(allow);
    return { ok: true };
  }

  // ── output (codex notifications → relay wire) ────────────────────────────────

  #onNotification(n: CodexNotification): void {
    // Buffer during resume/reconcile so live traffic can't interleave with the
    // synthetic history replay and the thread filter is active before we apply
    // anything (finding #10).
    if (this.#buffering) { this.#notifBuffer.push(n); return; }
    this.#dispatchNotification(n);
  }

  #flushNotifBuffer(): void {
    const buffered = this.#notifBuffer;
    this.#notifBuffer = [];
    for (const n of buffered) this.#dispatchNotification(n);
  }

  #dispatchNotification(n: CodexNotification): void {
    // Only the ROOT thread's traffic drives this session. Subagents / reviews /
    // forks run on their own thread ids on the same server (review #6/#10).
    if (this.#threadId) {
      const p = n.params ?? {};
      const nThread = n.method === "thread/started"
        ? (p.thread as Record<string, unknown> | undefined)?.id
        : p.threadId;
      if (typeof nThread === "string" && nThread !== this.#threadId) return;
    }
    // Lifecycle: a closed/deleted ROOT thread detaches this session (finding #10).
    if (n.method === "thread/closed" || n.method === "thread/deleted") {
      if (this.status !== "ended") this.end("process_exited");
      return;
    }
    if (n.method === "serverRequest/resolved") {
      // The request was answered elsewhere (attached TUI) or cleared by an
      // interrupt. Settle our held handler AND suppress the duplicate response
      // (finding #6): tell the client to drop the outgoing reply, then resolve.
      const rid = String((n.params ?? {}).requestId ?? "");
      const p = this.#pendingApprovals.get(rid);
      if (p) { this.#client?.resolveServerRequestExternally(rid); p.answer(false); }
      return;
    }
    if (n.method === "turn/started") {
      const turn = (n.params?.turn ?? {}) as Record<string, unknown>;
      if (typeof turn.id === "string") this.#activeTurnId = turn.id;
    } else if (n.method === "turn/completed") {
      this.#activeTurnId = null;
      // Checkpoint is advanced by the terminal-row ACK (setReceiptSink), NOT
      // here (finding #2). Just re-drain the FIFO now the turn is done.
      queueMicrotask(() => this.#pumpDispatch());
    }
    this.#applyEffects(this.#norm.handle(n));
  }

  // Assistant text mirrored into the daemon chat log exactly once per localId
  // (the same ids the relay dedupes on) — feeds the debug page AND the v2
  // nucleus lane's turn observation, which were both blind to codex output.
  #chatSeen = new Set<string>();
  #mirrorChat(localId: string, text: string): void {
    if (this.#chatSeen.has(localId)) return;
    this.#chatSeen.add(localId);
    this.#deps.addChatMessage({ role: "assistant", content: text, source: "cli", session_id: this.id });
  }

  #applyEffects(effects: ReturnType<CodexNormalizer["handle"]>): void {
    for (const eff of effects) {
      switch (eff.kind) {
        case "wire": {
          this.#relay?.send(eff.record, eff.localId);
          const data = (eff.record as { content?: { data?: { ev?: { t?: string; text?: string } } } }).content?.data;
          if (data?.ev?.t === "text" && data.ev.text) this.#mirrorChat(eff.localId ?? String(Math.random()), data.ev.text);
          break;
        }
        case "thinking": this.#thinking = eff.value; this.#relay?.setThinking(eff.value); break;
        case "receipt": this.#relay?.stampReceiptOnLastQueued({ uuid: eff.uuid, turn: eff.turn }); break;
        case "model": this.currentModel = eff.code; void this.#relay?.updateModelCode(eff.code); break;
        case "effort": this.currentEffort = eff.effort; break;
        case "context": void this.#relay?.updateContext(eff.tokens); break;
        case "notify": this.#relay?.notifyCustom(eff.headline, eff.detail); break;
        case "title":
          if (!this.#titleLocked) {
            this.summary = eff.value;
            void this.#relay?.updateSummary(eff.value);
            this.#deps.broadcast("session_update", this.toJSON());
          }
          break;
        case "confirmDispatch": this.#onDispatchEchoed(eff.clientId); break;
      }
    }
  }

  /** Replay thread history through the SAME normalizer on resume. Deterministic
   *  localIds (turn-level + canonical item ordinals) make re-sent rows idempotent
   *  at the relay append layer, so only output missed during downtime lands. */
  async #reconcileHistory(client: CodexAppServerClient): Promise<void> {
    if (!this.#threadId) return;
    await this.#reconcileHistoryInner(client);
  }

  async #reconcileHistoryInner(client: CodexAppServerClient): Promise<void> {
    const res = await client.threadRead(this.#threadId!);
    const thread = ((res.thread ?? res) as Record<string, unknown>);
    const turns = Array.isArray(thread.turns) ? thread.turns as Record<string, unknown>[] : [];

    // Rewind detection (finding #5): if our delivered high-water turn is no
    // longer in history, the TUI rolled back the tail. Surface it rather than
    // silently skipping turns the app still shows.
    const high = this.#checkpoint.deliveredThroughTurnId;
    if (high && !turns.some((t) => String(t.id ?? "") === high)) {
      process.stderr.write(`[codex ${this.id}] history rewound past ${high} — resetting checkpoint\n`);
      this.#checkpoint = { threadId: this.#threadId, deliveredThroughTurnId: null };
    }

    for (const turn of turns) {
      const tid = String(turn.id ?? "");
      if (!tid) continue;
      // Already delivered before the restart — skip wholesale.
      if (isTurnDelivered(this.#checkpoint, tid)) continue;
      const status = String(turn.status ?? "completed");
      const view = String(turn.itemsView ?? "full");
      // A turn whose items history did NOT fully return can't be faithfully
      // replayed — skip its items and do NOT checkpoint it (finding #2/#5).
      if (view && view !== "full") {
        process.stderr.write(`[codex ${this.id}] turn ${tid} itemsView=${view} — deferring replay\n`);
        continue;
      }
      const items = Array.isArray(turn.items) ? turn.items as Record<string, unknown>[] : [];
      // FRESH CARD (restart / resume-by-id / continue): the new relay session
      // has no prior rows, so replay the user prompts too — BEFORE the turn
      // bracket, matching live ordering (user row, then turn-start; the app's
      // positional grouper mis-brackets a user message inside the turn — the
      // e2e's codex CH7 "reverse order", root-caused 2026-08-12).
      if (this.#freshCard) {
        let idx = 0;
        for (const item of items) {
          if (String((item as { type?: unknown }).type ?? "") !== "userMessage") continue;
          const content = (item as { content?: Array<{ type?: string; text?: string }> }).content;
          const text = Array.isArray(content)
            ? content.filter((c) => c?.type === "text").map((c) => c?.text ?? "").join("\n").trim()
            : String((item as { text?: unknown }).text ?? "").trim();
          if (text) this.#relay?.send(encodeUserMessage(text), `turn:${tid}:user:${idx}`);
          idx++;
        }
      }
      this.#applyEffects(this.#norm.handle({ method: "turn/started", params: { turn: { id: tid } } }));
      for (const item of items) {
        // Feed item/started for EVERY item (incl. userMessage) so canonical
        // ordinals allocate identically to the live path AND user-message
        // echoes drain the inbound spool (finding #3a / #5).
        this.#applyEffects(this.#norm.handle({ method: "item/started", params: { turnId: tid, item } }));
        this.#applyEffects(this.#norm.handle({ method: "item/completed", params: { turnId: tid, item } }));
      }
      // Synthesize turn/completed for a TERMINAL turn — its terminal row's ACK
      // advances the checkpoint (setReceiptSink); we do NOT mark it here.
      // For an inProgress turn the handling depends on how we started (#5):
      //   - REJOIN: leave it OPEN — it's a live orphan whose real notifications
      //     (buffered now, flushed after reconcile) will complete it.
      //   - FRESH SPAWN: the old server (and its in-flight turn) died, so the
      //     turn is dead — close it as cancelled so the card doesn't spin.
      if (status !== "inProgress") {
        this.#applyEffects(this.#norm.handle({ method: "turn/completed", params: { turn: { id: tid, status } } }));
      } else if (!this.#rejoined) {
        this.#applyEffects(this.#norm.handle({ method: "turn/completed", params: { turn: { id: tid, status: "interrupted" } } }));
      }
    }
    // The high-water advances via terminal-row ACKs (setReceiptSink); just make
    // sure the thread binding is persisted.
    if (this.#checkpoint.threadId !== this.#threadId) {
      this.#checkpoint = { ...this.#checkpoint, threadId: this.#threadId };
    }
    saveCheckpoint(this.id, this.#checkpoint);
  }

  // ── app-facing intake / queue (daemon-owned FIFO) ────────────────────────────

  busy(): boolean { return this.#thinking; }

  enqueue(text: string, opts?: { source?: DeliverySource; mirrorToRelay?: boolean; seq?: number; visible?: boolean; requireDurable?: boolean }): QueuedMessage {
    // Non-relay intake (app RPC / local). If a seq is provided, dedupe like the
    // relay path; otherwise a random clientId (these are not cursor-replayed).
    const seq = opts?.seq;
    // /title — joy-level, never forwarded to the model (parity with the other
    // adapters). With text: set + lock. Bare: unlock.
    const titleCmd = /^\/title(?:\s+(.*))?$/s.exec(text.trim());
    if (titleCmd) {
      const t = (titleCmd[1] ?? "").trim();
      this.#titleLocked = t.length > 0;
      saveWindowRecord(this.id, { launchCwd: this.cwd, titleLockedByUser: this.#titleLocked });
      if (t) { this.summary = t; void this.#relay?.updateSummary(t); }
      this.#deps.broadcast("session_update", this.toJSON());
      if ((opts?.mirrorToRelay ?? true) && this.#relay) this.#relay.send(encodeUserMessage(text, Date.now()), `codex:in:${this.id}:${seq ?? Date.now()}`);
      return { id: String(seq ?? Date.now()), text, createdAt: Date.now() };
    }
    if (this.#handleJoyPrompt(text, opts?.mirrorToRelay ?? true, seq)) {
      return { id: String(seq ?? Date.now()), text, createdAt: Date.now() };
    }
    if (seq != null && this.#inbound.some((i) => i.seq === seq)) { this.#pumpDispatch(); return { id: String(seq), text, createdAt: Date.now() }; }
    const item: CodexInboundItem = { clientId: seq != null ? `codex-in:${this.id}:${seq}` : randomUUID(), text, state: "queued", at: Date.now(), seq };
    this.#inbound.push(item);
    if (!saveCodexInbound(this.id, this.#inbound) && opts?.requireDurable) {
      this.#inbound.pop();
      throw new Error("codex inbound persist failed");
    }
    if ((opts?.mirrorToRelay ?? true) && this.#relay) this.#relay.send(encodeUserMessage(text, item.at), `codex:in:${this.id}:${seq ?? item.at}`);
    this.#pumpDispatch();
    return { id: String(item.at), text, createdAt: item.at };
  }

  queueState(): QueueState {
    const pending = this.#inbound.filter((i) => i.state === "queued").length;
    return { queue: [], pendingCount: pending, hidden: [], inFlight: this.#activeTurnId, paused: false };
  }

  resumeQueue(): void { this.#pumpDispatch(); }
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
    const r = await this.#tmux.captureFresh(this.tmuxWindow, { color });
    return { ok: true, text: r.ok ? r.out : "" };
  }

  async resize(cols: number, rows: number): Promise<{ ok: boolean }> {
    const r = await this.#tmux.command(["resize-window", "-t", this.tmuxWindow, "-x", String(cols), "-y", String(rows)]);
    return { ok: r.ok };
  }

  async sendRawKeys(script: string, opts?: { literal?: boolean }): Promise<{ ok: boolean; segments: number; error?: string }> {
    const r = opts?.literal ? await this.#tmux.literal(this.tmuxWindow, script) : await this.#tmux.key(this.tmuxWindow, script);
    return { ok: r.ok, segments: 1, error: r.ok ? undefined : "send failed" };
  }

  detectPermissionMode(): string | null { return this.#permissionMode; }

  async setPermissionMode(target: string): Promise<{ ok: boolean; mode?: string; error?: string }> {
    // Applied per-turn on the next turn/start (no pane cycling needed). Persist
    // so a restart/recover keeps the chosen mode (finding #8).
    this.#permissionMode = target;
    this.#persistWindowRecord();
    return { ok: true, mode: target };
  }

  transcript(): { lines: unknown[] } { return { lines: [] }; }

  // ── claude-hook surface (no-op for codex) ─────────────────────────────────────
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
  markCompacting(): void { /* codex compaction is server-side */ }

  // ── teardown ──────────────────────────────────────────────────────────────

  end(reason: "killed" | "process_exited" | "restart"): boolean {
    if (this.status === "ended") return false;
    this.status = "ended";
    this.endReason = reason;
    // Decline any pending approvals so codex isn't left waiting, and clear the bar.
    for (const p of this.#pendingApprovals.values()) { try { p.answer(false); } catch { /* ignore */ } }
    this.#pendingApprovals.clear();
    void this.#relay?.updateCodexApproval(null);
    try { this.#client?.close(); } catch { /* ignore */ }
    this.#client = null;
    // Kill the app-server: our own child, or (rejoined orphan) the recovered pid
    // — but only if it's verifiably OURS (guards a recycled pid — finding #7).
    try {
      if (this.#proc) this.#proc.kill();
      else if (this.pid && this.#isOurServer(this.pid)) process.kill(this.pid);
    } catch { /* ignore */ }
    this.#proc = null;
    // Synthesize a cancellation ONLY for a genuinely open turn, with a
    // DETERMINISTIC localId matching the normalizer's turn-end (finding #9) so
    // it dedupes against a real turn-end the app may already hold.
    if (this.#activeTurnId) {
      try { this.#relay?.send(encodeTurnEnd("cancelled", { turn: this.#activeTurnId }), `codex:${this.#threadId}:turn:${this.#activeTurnId}:complete`); } catch { /* ignore */ }
      this.#activeTurnId = null;
    }
    if (this.#relay) this.#relay.setThinking(false);
    this.#tmux.untrack(this.tmuxWindow);
    if (reason === "process_exited") {
      void this.#relay?.updateJoyState("detached");
      this.#relay?.pausePull();
    } else {
      if (this.#relay && reason !== "restart") this.#archivePromise = this.#relay.archive(); // restart keeps the card
      try {
        void (this.#tmuxSocket
          ? (this.#tmux.runSync("kill-server"), disposeTmuxHandle(this.#tmuxSocket), Promise.resolve())
          : this.#tmux.command(["kill-window", "-t", this.tmuxWindow]));
      } catch { /* ignore */ }
      this.#relay?.stop();
      clearCodexInbound(this.id); // a killed session will never deliver — drop the spool
      clearCheckpoint(this.id);
      // Intentional kill → drop the record so record-based codex recovery
      // can't resurrect this session on the next daemon boot.
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
      tmux_socket: this.#tmuxSocket,
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
    const rs = await createRelaySession(this.#deps.relayClient, { tag: `joy-daemon-${this.id}`, cwd: this.cwd, id: this.id });
    this.attachRelay(rs);
  }
}
