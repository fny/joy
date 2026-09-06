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
import type { DeliverySource } from "../domain/agentSession";
import type { AgentSession } from "../domain/agentSession";
import { codexJoyInstructions, joyPromptReinjection } from "../domain/agentTagsPrompt";
import { spawnCodexAppServer, CodexAppServerClient, JsonRpcError, JsonRpcResponseError } from "./appServerClient";
import { CodexNormalizer, type CodexNotification } from "./normalize";
import { buildCodexAttachCommand } from "./attach";
import { ledgerFor, type Ledger, type CommandRow, LedgerWriteError, StaleCommandError, StaleGenerationError } from "../domain/ledger";
import { toTmuxSegments, ParseError, TmuxKeyError } from "../tmux/keyTokens";
import { isTurnDelivered, advanceTurnHighWater } from "./codexTurnCheckpoint";

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

/** Delay before re-attempting a failed pre-send spool write (#514). */
const PERSIST_RETRY_MS = 2_000;

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
  // Durable inbound queue (finding #3): app messages are ledger commands,
  // committed before delivery; the dispatch attempt (turn/start) is a ledger
  // attempt committed BEFORE the socket write, so a crash between the send
  // and the echo is an explicit unknown outcome, never a blind resend.
  #ledger: Ledger;
  #generation: number;
  // Delivered-turn high-water — `checkpoints(kind='codex_turn')`, committed
  // only once the turn's outbox rows are acked (finding #2, #67).
  #deliveredThrough: string | null = null;
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
    // The ledger is opened SYNCHRONOUSLY here, before attachRelay starts the
    // relay pull, so an inbound message can't race the load (finding #3
    // startup race). A new generation closes the previous one: attempts it
    // left mid-flight become `unknown` and are reconciled from thread/read.
    this.#ledger = deps.ledger ?? ledgerFor();
    this.#generation = this.#ledger.openGeneration(init.id, "codex");
    if (init.codexThreadId) {
      this.#deliveredThrough = this.#ledger.getCheckpoint(init.id, "codex_turn")?.ref || null; // "" = a pending mark, nothing committed yet
      // Do NOT seed pendingEffort on resume/recover (finding #8).
    } else {
      // A fresh thread under this id: nothing queued for an earlier thread can
      // run here, and its delivered-turn mark is meaningless.
      for (const r of this.#ledger.listPending(init.id)) this.#ledger.transition(r.id, ["queued", "submitting", "accepted", "unknown", "running", "cancelling"], "interrupted", { terminalReason: "fresh_session" });
      this.#ledger.clearCheckpoint(init.id, "codex_turn");
      this.#pendingEffort = init.effort ?? null; // fresh session: apply on turn 1
    }
  }

  /** Test/diagnostic access to the session's ledger generation. */
  get ledgerGeneration(): number { return this.#generation; }

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
        if (this.status === "ended") return; // killed while the rejoin was pending: do not spawn (Astra on 4b70d70c)
        client = await this.#spawnFresh();
      }
      if (this.status === "ended") { // killed while starting: this generation owns nothing (Astra on 08f70257)
        try { client.close(); } catch { /* best effort */ }
        return;
      }
      this.#client = client;

      // Deliver anything queued once reconcile has settled the confirmed set.
      // Fresh spawn: the old server + its in-flight turn are gone, so requeue
      // unconfirmed (unknown) items (at-least-once — each resend is a NEW
      // attempt with its own client id). Rejoin: hold them (at-most-once).
      if (!this.#rejoined) {
        for (const r of this.#ledger.listPending(this.id, ["unknown"])) this.#ledger.requeueCommand(r.id);
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
    if (this.status === "ended") {
      // Killed while the spawn was being set up: this process must not outlive
      // the session it was started for (Astra on 4b70d70c).
      try { this.#proc.kill("SIGTERM"); } catch { /* already gone */ }
      this.#proc = null;
      throw new Error("session ended during startup");
    }
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
  #handleJoyPrompt(text: string, mirror: boolean, seq?: number): string | false {
    if (!/^\/joy-prompt(?:\s|$)/.test(text.trim())) return false;
    this.#developerInstructions = codexJoyInstructions();
    this.#persistWindowRecord();
    if (mirror && this.#relay) this.#relay.send(encodeUserMessage(text, Date.now()), `codex:in:${this.id}:${seq ?? randomUUID()}`);
    const rein = this.enqueue(joyPromptReinjection(codexJoyInstructions()), { mirrorToRelay: false });
    return rein.id; // the reinjection item, so a cancelled relay turn can pluck it (#77)
  }

  #persistWindowRecord(): void {
    if (this.status === "ended") return; // a retired generation writes no record (#43, #113)
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
    const item = this.#ledger.listPending(this.id, ["queued"])[0];
    if (!item) return;
    this.#dispatching = true;
    void this.#dispatch(item).finally(() => { this.#dispatching = false; });
  }

  /** The clientUserMessageId a dispatch attempt sends. The first attempt uses
   *  the command id itself (the deterministic `codex-in:<id>:<seq>` scheme
   *  keeps recovery ownership checks simple); a RESEND after an unknown
   *  outcome gets a fresh id per attempt, so the two submissions — and their
   *  echoes — stay distinguishable (campaign decision, 2026-09-06). */
  #attemptRef(commandId: string, attemptNo: number): string {
    return attemptNo <= 1 ? commandId : `${commandId}#a${attemptNo}`;
  }

  async #dispatch(item: CommandRow): Promise<void> {
    const client = this.#client;
    if (!client || !this.#threadId) return;
    // The attempt is COMMITTED before the socket write (finding #3d): a crash
    // after codex accepts but before the response is processed leaves an
    // explicit `unknown`, never a `queued` row that recovery would blindly
    // resend (clientUserMessageId is correlation, not idempotency).
    let attemptId: string;
    let clientId: string;
    try {
      const attemptNo = this.#ledger.attemptsForCommand(item.id).length + 1;
      clientId = this.#attemptRef(item.id, attemptNo);
      attemptId = this.#ledger.recordAttempt(item.id, this.#generation, clientId, "turn/start").id;
    } catch (e) {
      if (e instanceof StaleGenerationError) return; // retired: the replacement owns the queue
      if (e instanceof StaleCommandError) { this.#recordOutcome(item.id, this.#ledger.getCommand(item.id)?.state === "cancelled" ? "cancelled" : "delivered"); queueMicrotask(() => this.#pumpDispatch()); return; }
      // The ledger refused the commit — sending now would let a crash before
      // the echo make recovery resend a prompt codex already accepted. Never
      // send; retry the commit (not the send) shortly (#514).
      process.stderr.write(`[codex ${this.id}] could not commit the dispatch attempt for ${item.id} (${e instanceof Error ? e.message : e}) — holding the send, retrying\n`);
      setTimeout(() => this.#pumpDispatch(), PERSIST_RETRY_MS).unref();
      return;
    }
    this.#dispatched.add(clientId);
    this.#inflightItem = item;
    try {
      const { turnId } = await client.turnStart(this.#threadId, item.text, {
        clientUserMessageId: clientId,
        permissionMode: this.#permissionMode,
        effort: this.#pendingEffort ?? undefined,
      });
      if (this.status === "ended") { // retired while the start was in flight: this generation owns nothing now (#43)
        try { await client.turnInterrupt(this.#threadId, turnId); } catch { /* best effort */ }
        return;
      }
      this.#settle(attemptId, "accepted", { runtimeTurnId: turnId });
      this.#pendingEffort = null; // applied (codex persists it thread-side)
      this.#activeTurnId = turnId; // serialize: no further dispatch until this completes
      if (this.#cancelledIds.has(item.id)) {
        // Cancelled while turn/start was in flight: the turn is accepted and
        // running — interrupt it the moment its id is known (Astra, #66).
        this.#cancelledIds.delete(item.id);
        process.stderr.write(`[codex ${this.id}] ${item.id} was cancelled mid-start — interrupting turn ${turnId}\n`);
        try { await client.turnInterrupt(this.#threadId, turnId); } catch { /* best effort */ }
      }
    } catch (e) {
      if (this.status === "ended") return; // a killed generation must not touch its old queue (#43)
      if (e instanceof JsonRpcResponseError) {
        // EXPLICIT server rejection. A busy/already-active refusal is
        // retryable (turn/completed re-pumps); anything else, three times in
        // a row, is a permanent refusal of THIS prompt → failed (Astra, #66).
        // Busy refusals never count; three CONSECUTIVE non-busy refusals fail
        // the item, and a non-busy refusal schedules its own bounded retry so
        // the counter is driven without waiting for unrelated intake.
        const busy = /busy|already|in progress|active/i.test(String(e.message ?? ""));
        const n = busy ? (this.#rejections.get(item.id) ?? 0) : (this.#rejections.get(item.id) ?? 0) + 1;
        this.#rejections.set(item.id, n);
        if (!busy && n < 3) setTimeout(() => this.#pumpDispatch(), 2_000 * n).unref();
        if (!busy && n >= 3) {
          this.#settle(attemptId, "rejected", { detail: `${e.code}: ${String(e.message ?? "").slice(0, 120)}` });
          this.#recordOutcome(item.id, "failed");
          this.#rejections.delete(item.id);
          process.stderr.write(`[codex ${this.id}] turn/start rejected ${n}× (${e.code}: ${String(e.message ?? "").slice(0, 120)}) — prompt failed\n`);
        } else {
          // A transient refusal: the attempt is settled rejected and the row
          // goes back to queued for the next pump (a new attempt, new id).
          this.#settle(attemptId, "rejected", { detail: String(e.code), command: { to: "queued" } });
          process.stderr.write(`[codex ${this.id}] turn/start rejected (${e.code}) — requeued\n`);
        }
      } else {
        // AMBIGUOUS (timeout / socket loss): it MIGHT have landed — an explicit
        // unknown (at-most-once) rather than a duplicate turn. The tombstone
        // (if any) stays: a late turn/started or echo settles it.
        this.#settle(attemptId, "unknown", { detail: String(e).slice(0, 200) });
        process.stderr.write(`[codex ${this.id}] turn/start ambiguous failure: ${e}\n`);
      }
    } finally {
      this.#inflightItem = null;
    }
  }

  /** settleAttempt with the ledger failure logged, never thrown: the
   *  callers are the tails of a dispatch that already happened. */
  #settle(attemptId: string, outcome: "accepted" | "unknown" | "rejected", patch: { runtimeTurnId?: string; detail?: string; command?: { to: "queued" } } = {}): void {
    try { this.#ledger.settleAttempt(attemptId, outcome, patch); }
    catch (e) { process.stderr.write(`[codex ${this.id}] ledger settle ${outcome} failed: ${e instanceof Error ? e.message : e}\n`); }
  }

  /** The item whose turn/start is in flight; a late turn/started or echo for
   *  a tombstoned one is interrupted here (Astra, #66). */
  #inflightItem: CommandRow | null = null;
  #interruptIfCancelled(clientId: string | null): void {
    if (!clientId || !this.#cancelledIds.has(clientId)) return;
    if (!this.#client || !this.#threadId || !this.#activeTurnId) return; // no turn identity yet — keep the tombstone
    this.#cancelledIds.delete(clientId);
    process.stderr.write(`[codex ${this.id}] ${clientId} was cancelled — interrupting late turn ${this.#activeTurnId}\n`);
    void this.#client.turnInterrupt(this.#threadId, this.#activeTurnId).catch(() => { /* best effort */ });
  }

  /** A userMessage echo (live or from history replay) confirms delivery.
   *  The echo observation, the codex_client + seq receipts (what stops a
   *  redelivery of that seq from starting the prompt a second time, #516),
   *  the attempt's `done` and the command's terminal `delivered` commit
   *  TOGETHER — there is no longer an "ownership first, then the spool"
   *  window, nor an ownership record to keep when a second write fails
   *  (Astra on bdee9ac8 / cde740c1). */
  #onDispatchEchoed(clientId: string): void {
    const attempt = this.#ledger.matchAttemptByRef(this.id, clientId);
    const commandId = attempt?.commandId ?? this.#commandIdForRef(clientId);
    if (commandId) {
      const cmd = this.#ledger.getCommand(commandId);
      try {
        this.#ledger.recordObservation({ sessionId: this.id, generation: this.#generation, attemptId: attempt?.id ?? null, kind: "echo", ref: clientId }, {
          receipts: [{ kind: "codex_client", ref: clientId, commandId, attemptId: attempt?.id ?? null },
            ...(cmd?.seq != null ? [{ kind: "seq", ref: String(cmd.seq), commandId, attemptId: attempt?.id ?? null }] : [])],
          ...(attempt ? { attempt: { id: attempt.id, outcome: "done" as const } } : {}),
          ...(cmd && !["completed", "failed", "cancelled", "interrupted"].includes(cmd.state) ? { command: { id: commandId, to: "completed" as const, terminalReason: "delivered" } } : {}),
        });
      } catch (e) {
        process.stderr.write(`[codex ${this.id}] echo commit for ${clientId} failed: ${e instanceof Error ? e.message : e}\n`);
      }
      this.#recordOutcome(commandId, "delivered");
      this.#dispatched.add(clientId);
    }
    this.#interruptIfCancelled(commandId ?? clientId); // the echo proves it landed; a tombstoned one is interrupted now
  }

  /** The command a runtime ref (clientUserMessageId) belongs to, whether or
   *  not an attempt is still awaiting it: a settled attempt, a retained
   *  receipt, or the deterministic first-attempt id. */
  #commandIdForRef(ref: string): string | null {
    const rc = this.#ledger.getReceipt(this.id, "codex_client", ref);
    if (rc?.commandId) return rc.commandId;
    const base = ref.replace(/#a\d+$/, "");
    return this.#ledger.getCommand(base)?.sessionId === this.id ? base : null;
  }

  /** The relay acked a turn's terminal row: advance the delivered-turn
   *  high-water. Committed pending until every outbox row of this session
   *  up to that point is acked (finding #2, #67); a restart before that
   *  replays from the previous mark, receipt-deduped. Held outright while
   *  the outbox cannot persist (rows exist only in RAM). */
  #markTurnDelivered(turnId: string): void {
    if (!turnId) return;
    const next = advanceTurnHighWater(this.#deliveredThrough, turnId);
    if (next === this.#deliveredThrough || next === null) return;
    if (this.#relay?.outboundPersistDegraded) return;
    try {
      this.#ledger.setCheckpoint(this.id, "codex_turn", next, 0, { throughSeq: "latest" });
      this.#deliveredThrough = next;
    } catch (e) {
      process.stderr.write(`[codex ${this.id}] checkpoint ${next} failed: ${e instanceof Error ? e.message : e}\n`);
    }
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
      // A cancelled item whose start timed out client-side is settled by its
      // userMessage ECHO (#onDispatchEchoed), which names the clientId. A
      // turn/started alone is not attributable — guessing interrupted an
      // unrelated TUI turn (Astra on caf47165).
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
        case "userMessage": {
          // Ours if we dispatched that clientId (spool, dispatched set, or our
          // id scheme); anything else was typed in the attached TUI and has no
          // relay row — mirror it once. Not during history replay: a fresh
          // card already emitted user rows BEFORE the turn bracket (#78).
          const ours = !!eff.clientId && (this.#dispatched.has(eff.clientId) || eff.clientId.startsWith(`codex-in:${this.id}:`) || this.#ledger.ownsRuntimeRef(this.id, eff.clientId, "codex_client"));
          if (ours) { this.#onDispatchEchoed(eff.clientId); break; }
          if (this.#replayingHistory && this.#freshCard) break; // already emitted before the turn bracket
          this.#relay?.send(encodeUserMessage(eff.text, Date.now()), eff.localId);
          break;
        }
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
    const high = this.#deliveredThrough;
    if (high && !turns.some((t) => String(t.id ?? "") === high)) {
      process.stderr.write(`[codex ${this.id}] history rewound past ${high} — resetting checkpoint\n`);
      this.#deliveredThrough = null;
      try { this.#ledger.clearCheckpoint(this.id, "codex_turn"); } catch { /* the next mark rewrites it */ }
    }

    for (const turn of turns) {
      const tid = String(turn.id ?? "");
      if (!tid) continue;
      // Already delivered before the restart — skip wholesale.
      if (isTurnDelivered(this.#deliveredThrough, tid)) continue;
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
      this.#replayingHistory = true;
      try {
        for (const item of items) {
          // Feed item/started for EVERY item (incl. userMessage) so canonical
          // ordinals allocate identically to the live path AND user-message
          // echoes drain the inbound spool (finding #3a / #5).
          this.#applyEffects(this.#norm.handle({ method: "item/started", params: { turnId: tid, item } }));
          this.#applyEffects(this.#norm.handle({ method: "item/completed", params: { turnId: tid, item } }));
        }
      } finally { this.#replayingHistory = false; }
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
    // The high-water advances via terminal-row ACKs (setReceiptSink).
  }

  // ── app-facing intake / queue (daemon-owned FIFO) ────────────────────────────

  busy(): boolean { return this.#thinking; }

  enqueue(text: string, opts?: { source?: DeliverySource; mirrorToRelay?: boolean; seq?: number; visible?: boolean }): QueuedMessage {
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
      if ((opts?.mirrorToRelay ?? true) && this.#relay) this.#relay.send(encodeUserMessage(text, Date.now()), `codex:in:${this.id}:${seq ?? randomUUID()}`);
      // handled: the lane must terminalize its turn now — waiting for agent
      // activity a title change never produces held the queue for 3 min (#65).
      return { id: String(seq ?? Date.now()), text, createdAt: Date.now(), handled: "command" };
    }
    const rein = this.#handleJoyPrompt(text, opts?.mirrorToRelay ?? true, seq);
    if (rein) {
      return { id: String(seq ?? Date.now()), text, createdAt: Date.now(), handled: "command", reinjectionId: rein };
    }
    // Acceptance = the ledger commit (throws when it cannot commit, or when
    // the session has ended — #553). Dedupe lives there: a redelivered seq
    // (crash-before-cursor-persist) hits the pending row, or — after its echo
    // settled the row — the retained seq receipt. Redelivered seqs are the
    // same logical message: never a second turn/start (#516).
    const at = Date.now();
    const accepted = this.#ledger.acceptCommand({
      sessionId: this.id, id: seq != null ? `codex-in:${this.id}:${seq}` : randomUUID(), text,
      origin: seq != null ? "relay" : "local", source: opts?.source ?? "rpc", seq,
      visible: opts?.visible ?? false, mirrorToRelay: opts?.mirrorToRelay ?? true, createdAt: at,
    });
    if (accepted.deduped !== "none") {
      process.stderr.write(`[codex ${this.id}] dedupe ${accepted.deduped === "receipt" ? "redelivered" : "re-pulled"} ${seq != null ? `seq=${seq}` : `id=${accepted.id}`} (already ${accepted.deduped === "receipt" ? "confirmed" : "queued"} as ${accepted.id})\n`);
      this.#pumpDispatch();
      return { id: accepted.id, text, createdAt: accepted.row?.createdAt ?? at };
    }
    // The mirror row's localId must be unique per MESSAGE: two non-relay sends
    // in the same millisecond shared `codex:in:<id>:<ms>` and the relay deduped
    // the second user row away as a replay (Astra medium, codexSession.ts:731).
    // Relay sends keep the seq (stable across a redelivery — that dedupe is wanted).
    if ((opts?.mirrorToRelay ?? true) && this.#relay) this.#relay.send(encodeUserMessage(text, at), `codex:in:${this.id}:${seq ?? accepted.id}`);
    this.#pumpDispatch();
    // The durable command id IS the queue item id: cancelQueued/queueItemState
    // address the ledger by it, and the lane tracks THIS prompt's delivery by
    // the userMessage echo instead of another turn's busy flag (#66).
    return { id: accepted.id, text, createdAt: at };
  }

  /** Per-item outcomes for the lane (see Session.queueItemState). */
  #itemOutcome = new Map<string, "delivered" | "cancelled" | "failed">();
  #recordOutcome(id: string, outcome: "delivered" | "cancelled" | "failed"): void {
    const prev = this.#itemOutcome.get(id);
    if ((prev === "cancelled" || prev === "failed") && outcome === "delivered") return; // terminal outcomes win
    this.#itemOutcome.set(id, outcome);
    if (this.#itemOutcome.size > 200) for (const k of this.#itemOutcome.keys()) { this.#itemOutcome.delete(k); if (this.#itemOutcome.size <= 150) break; }
  }
  queueItemState(id: string): "pending" | "delivered" | "cancelled" | "failed" | "unknown" {
    const local = this.#itemOutcome.get(id);
    if (local) return local;
    const row = this.#ledger.getCommand(id);
    if (row && row.sessionId === this.id) {
      switch (row.state) {
        case "completed": return "delivered";
        case "failed": return "failed";
        case "cancelled": case "interrupted": return "cancelled";
        default: return "pending";
      }
    }
    // A recovered adapter suppresses a redelivered seq from its retained
    // receipts but had no in-process outcome for it, so the lane saw
    // 'unknown', took the untracked path and waited 180 s before failing
    // no_agent_activity (Astra on ddc89de1, #516). The receipt IS the outcome.
    if (this.#ledger.hasReceipt(this.id, "codex_client", id)) return "delivered";
    return "unknown";
  }

  queueState(): QueueState {
    const pending = this.#ledger.listPending(this.id, ["queued"]).length;
    return { queue: [], pendingCount: pending, hidden: [], inFlight: this.#activeTurnId, paused: false };
  }

  resumeQueue(): void { this.#pumpDispatch(); }
  editQueued(): boolean { return false; }
  /** Pluck a spooled prompt by its clientId. A cancelled relay prompt used to
   *  stay queued locally and run after the current turn (#66). An item already
   *  handed to codex (sentUnknown) is removed too — the abort that follows a
   *  cancel interrupts it if it did land. */
  cancelQueued(id: string): boolean {
    const row = this.#ledger.getCommand(id);
    if (!row || row.sessionId !== this.id || ["completed", "failed", "cancelled", "interrupted"].includes(row.state)) return false;
    // Durable cancel: a queued row is cancelled outright; one already handed
    // to codex (submitting/accepted/unknown) is cancelled AND tombstoned so
    // the accepted turn is interrupted as soon as its id arrives (#66).
    const inFlight = row.state !== "queued";
    try { this.#ledger.requestCancel(id); if (inFlight) this.#ledger.transition(id, ["submitting", "accepted", "unknown", "running", "cancelling"], "cancelled", { terminalReason: "cancelled" }); }
    catch (e) { process.stderr.write(`[codex ${this.id}] ledger cancel ${id} failed: ${e instanceof Error ? e.message : e}\n`); }
    this.#recordOutcome(id, "cancelled");
    if (inFlight) this.#cancelledIds.add(id);
    return true;
  }
  /** clientIds this session handed to codex (ownership for userMessage echoes). */
  #dispatched = new Set<string>();
  /** Cancelled while their turn/start was in flight (see #dispatch). */
  #cancelledIds = new Set<string>();
  #rejections = new Map<string, number>();
  #replayingHistory = false;
  reorderQueued(): boolean { return false; }

  async abort(): Promise<{ ok: boolean; error?: string }> {
    if (this.#client && this.#threadId && this.#activeTurnId) {
      // A failed interrupt is reported, not swallowed: the app's Stop used to
      // read success while the agent kept running (#8).
      try { await this.#client.turnInterrupt(this.#threadId, this.#activeTurnId); }
      catch (e) { return { ok: false, error: `interrupt failed: ${e instanceof Error ? e.message : e}` }; }
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
    // Same token language as the claude adapter: the app sends "<Enter>",
    // "<C-c>", "<Up>"… as bracket tokens with literal:false. Passing the raw
    // script to send-keys typed the seven characters "<Enter>" into the TUI
    // and nothing ever submitted (#111).
    if (opts?.literal) {
      const ok = (await this.#tmux.literal(this.tmuxWindow, script)).ok;
      return ok ? { ok: true, segments: 1 } : { ok: false, segments: 1, error: "tmux send-keys failed" };
    }
    let segments;
    try { segments = toTmuxSegments(script); }
    catch (e) {
      if (e instanceof ParseError || e instanceof TmuxKeyError) return { ok: false, segments: 0, error: e.message };
      throw e;
    }
    for (const seg of segments) {
      const ok = seg.type === "keys"
        ? (await this.#tmux.key(this.tmuxWindow, ...seg.names)).ok
        : (await this.#tmux.literal(this.tmuxWindow, seg.text)).ok;
      if (!ok) return { ok: false, segments: segments.length, error: "tmux send-keys failed" };
    }
    return { ok: true, segments: segments.length };
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
      // Intentional kill → drop the record so record-based codex recovery
      // can't resurrect this session on the next daemon boot.
      if (reason !== "restart") this.#recordTerminated = deleteWindowRecord(this.id);
    }
    // A killed session will never deliver: its queued rows are interrupted
    // and its delivered-turn mark dropped. A restart's replacement takes the
    // queued rows; a process exit keeps them for the restart that follows
    // (the record — and the thread — are still there).
    try {
      this.#ledger.closeGeneration(this.id, this.#generation, reason, { keepQueued: reason === "restart" || reason === "process_exited" });
      if (reason === "killed") this.#ledger.clearCheckpoint(this.id, "codex_turn");
    } catch (e) { process.stderr.write(`[codex ${this.id}] ledger closeGeneration failed: ${e instanceof Error ? e.message : e}\n`); }
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
      // Nothing left to deliver or resume (#43).
      try { this.#ledger.closeGeneration(this.id, this.#generation, "killed"); this.#ledger.clearCheckpoint(this.id, "codex_turn"); }
      catch (e) { process.stderr.write(`[codex ${this.id}] ledger close on kill failed: ${e instanceof Error ? e.message : e}\n`); }
      void (this.#tmuxSocket
        ? (this.#tmux.runSync("kill-server"), disposeTmuxHandle(this.#tmuxSocket), Promise.resolve())
        : this.#tmux.command(["kill-window", "-t", this.tmuxWindow]));
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
