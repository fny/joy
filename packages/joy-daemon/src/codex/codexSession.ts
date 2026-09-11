// CodexSession — the AgentSession implementation for OpenAI's codex, driven via
// the app-server (JSON-RPC over a per-session unix socket) instead of a claude
// TUI + transcript. It reproduces the SAME wire output the claude Session emits
// (via CodexNormalizer) so the app renders both identically.
//
// Durability model (post gpt-5.6-sol review, Wave C1/C2):
//  - INBOUND: app messages are ledger commands owned by the session
//    coordinator (domain/coordinator.ts); this session is the codex DRIVER
//    (codexDriver.ts): one turn/start per attempt, interrupt by turn id,
//    observations from the app-server, reconcile from thread/read. Explicit
//    reject → the coordinator's rejection budget, ambiguous → unknown.
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
import { CodexNormalizer, itemSignature, type CodexNotification } from "./normalize";
import type { WireRecord } from "../relay/relay";
import { buildCodexAttachCommand } from "./attach";
import { ledgerFor, AWAITING_ATTEMPT_STATES, NON_TERMINAL_STATES, type Ledger } from "../domain/ledger";
import { coordinatorFor, type SessionCoordinator, type CommandView, type HandledCommand } from "../domain/coordinator";
import { CodexDriver, codexTurnStatus, type CodexRuntimePort } from "./codexDriver";
import { toTmuxSegments, ParseError, TmuxKeyError } from "../tmux/keyTokens";
import {
  nextStartState, initialStartState, isRejoined, bindBufferedItems,
  nextDeliveredState, initialDeliveredState, isDelivered, markRef,
  type StartState, type StartEvent, type DeliveredState, type HistoryItem,
} from "./codexStartMachine";

import { codexPaneAuth } from "./codexPane";
import type { JoyLoginInfo, JoyDialogInfo } from "../relay/relay";
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
  // The TUI pane's sign-in state (codexPane.ts). Codex is driven over the
  // app-server, so nothing here read the pane — and a lapsed ChatGPT token
  // left a session on "Sign in with ChatGPT … Press enter to continue" for
  // 21 minutes with its first prompt held and the app saying nothing
  // (fny c80b0698). The watcher polls the pane, quickly while starting or
  // while a sign-in screen is up, slowly otherwise, and surfaces the state:
  // the chooser as a dialog, the device-code screen as a login (link + code),
  // the "Press enter to continue" screens by pressing Enter, a dead token as
  // a login notice with the message.
  #authTimer: ReturnType<typeof setTimeout> | null = null;
  #authShown: { login: string | null; dialog: string | null } = { login: null, dialog: null };
  #authContinuePressed = false;
  #authRefreshRequestedAt = 0;
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
  // Same for a model picked mid-session (joy-set-model): one turn/start
  // override, which codex then keeps.
  #pendingModel: string | null = null;
  // The turn codex reports active (turn/started … turn/completed): the
  // synthetic turn-end at teardown and an untargeted interrupt name it. Turn
  // serialization itself is the coordinator's (one op per session).
  #activeTurnId: string | null = null;
  #started = false;
  #archivePromise: Promise<boolean> | null = null;
  // The start lifecycle — rejoin or fresh spawn, the thread/read snapshot,
  // the notification buffer and its barrier, the history replay — is one
  // explicit machine (codexStartMachine.ts). Whether we REJOINED a live
  // app-server (vs spawned a fresh one) is a variant of its bound phases:
  // on a rejoin we must NOT resend 'sentUnknown' items — the live turn may
  // still be in flight and not yet in thread/read (finding #3c) — so we
  // hold them (at-most-once). On a fresh spawn the old server (and its
  // in-flight turn) died, so unconfirmed sends are requeued (at-least-once).
  #startState: StartState = initialStartState();
  // /title lock (parity with claude/opencode): a user-set title beats agent
  // <joy-title> emissions. Loaded from the window record.
  #titleLocked = false;
  #freshCard = false;
  // Durable inbound queue (finding #3): app messages are ledger commands the
  // coordinator owns; this session's driver submits them. The dispatch
  // attempt (turn/start) is committed BEFORE the socket write, so a crash
  // between the send and the echo is an explicit unknown, never a resend.
  #ledger: Ledger;
  #generation: number;
  #coordinator: SessionCoordinator;
  #driver: CodexDriver;
  #unsubscribeQueue: () => void = () => {};
  // Delivered-turn high-water — `checkpoints(kind='codex_turn')`, committed
  // only once the turn's outbox rows are acked (finding #2, #67) — and the
  // oldest turn whose history could NOT be replayed, which the mark never
  // passes (#518). Stepped by the delivered machine (codexStartMachine.ts).
  #delivered: DeliveredState = initialDeliveredState();
  // Codex emits turn/started BEFORE the turn's userMessage item, so a prompt
  // typed in the attached TUI mirrored on that item landed AFTER the turn-
  // start record and the app bracketed it inside the turn (#131). The
  // turn-start is held until the turn's first other effect; a TUI user row
  // goes out first.
  #heldTurnStart: { record: WireRecord; localId: string } | null = null;
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
    this.#scheduleAuthWatch(1_500);
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
    this.#coordinator = deps.coordinator ?? coordinatorFor(this.#ledger);
    if (init.codexThreadId) {
      // null = no mark, "" = a pending mark (nothing committed yet), else the turn.
      this.#deliveredSend({ type: "loaded", ref: this.#ledger.getCheckpoint(init.id, "codex_turn")?.ref ?? null });
      // Do NOT seed pendingEffort on resume/recover (finding #8).
    } else {
      // A fresh thread under this id: nothing queued for an earlier thread can
      // run here, and its delivered-turn mark is meaningless.
      for (const r of this.#ledger.listPending(init.id)) this.#ledger.transition(r.id, ["queued", "submitting", "accepted", "unknown", "running", "cancelling"], "interrupted", { terminalReason: "fresh_session", generation: this.#generation });
      this.#ledger.clearCheckpoint(init.id, "codex_turn");
      this.#deliveredSend({ type: "cleared" });
      this.#pendingEffort = init.effort ?? null; // fresh session: apply on turn 1
    }
    // The driver is adopted BEFORE the relay pull can start (attachRelay):
    // an inbound message meets a coordinator that owns this session; the
    // pump waits for `ready` (app-server up, history replayed).
    this.#driver = new CodexDriver(this.#runtimePort(), this.#generation);
    this.#coordinator.adopt(this.id, this.#driver);
    this.#unsubscribeQueue = this.#coordinator.subscribe((ev) => {
      if (ev.type !== "session" && ev.type !== "command") return;
      if (ev.sessionId !== this.id || !this.#relay) return;
      void this.#relay.updateQueue(this.#coordinator.snapshot(this.id));
    });
  }

  /** What the driver reads from this session at call time. */
  #runtimePort(): CodexRuntimePort {
    return {
      sessionId: this.id,
      threadId: () => this.#threadId,
      client: () => (this.status === "ended" ? null : this.#client),
      permissionMode: () => this.#permissionMode,
      pendingEffort: () => this.#pendingEffort ?? undefined,
      effortApplied: () => { this.#pendingEffort = null; },
      pendingModel: () => this.#pendingModel ?? undefined,
      modelApplied: () => { this.#pendingModel = null; },
      activeTurnId: () => this.#activeTurnId,
      rejoined: () => isRejoined(this.#startState),
      handleCommand: (text, opts) => this.#handleCommand(text, opts),
      mirrorAccepted: (cmd) => this.#mirrorAccepted(cmd),
      log: (line) => process.stderr.write(`[codex ${this.id}] ${line}\n`),
    };
  }

  /** Test/diagnostic access to the coordinator this session is adopted by. */
  get coordinator(): SessionCoordinator { return this.#coordinator; }

  /** Test/diagnostic access to the session's ledger generation. */
  get ledgerGeneration(): number { return this.#generation; }

  get relayAttached(): boolean { return this.#relay !== null; }
  /** The codex thread id, once known — used by registry.restart to resume the
   *  SAME thread even when the persisted record is absent (finding #7). */
  get codexThreadId(): string | undefined { return this.#threadId ?? this.#resumeThreadId; }
  /** The `-c key=value` overrides this app-server was launched with — a
   *  restart's replacement launches with the same ones (#561). */
  get codexConfig(): Record<string, string> | undefined { return this.#config && Object.keys(this.#config).length > 0 ? { ...this.#config } : undefined; }

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

  /** One step of the start machine; its effects are performed here. The
   *  phase checks in #start read the machine, and end() feeds it `killed`,
   *  so "the session ended while this step was in flight" is one fact. */
  #startSend(ev: StartEvent): StartState {
    const t = nextStartState(this.#startState, ev);
    if (!t) return this.#startState;
    this.#startState = t.to;
    for (const eff of t.effects ?? []) {
      switch (eff.type) {
        case "dispatch": this.#dispatchNotification(eff.n); break;
        case "flush":
          // Bind the live items buffered during the read to the identities
          // the replay allocated (#519), then apply the buffer in order.
          bindBufferedItems(eff.buffered, eff.barrier, eff.history, (turnId, type, id, ordinal) => this.#norm.bindTransient(turnId, type, id, ordinal));
          for (const { n } of eff.buffered) this.#dispatchNotification(n);
          break;
        case "ready":
          // The runtime is up and its history replayed: the coordinator now
          // reconciles anything still unknown (thread/read — a fresh spawn
          // resends what never landed, at least once; a rejoin holds it, at
          // most once) and pumps the queued rows.
          this.#driver.emit({ kind: "ready" });
          this.#persistWindowRecord();
          if (this.status === "starting") this.status = "active";
          this.#deps.broadcast("session_update", this.toJSON());
          this.#launchAttach();
          break;
        case "end": this.end(eff.reason); break;
        case "spawn": case "abandon": break; // the start sequence acts on the phase
      }
    }
    return this.#startState;
  }

  async #start(): Promise<void> {
    // Transactional rejoin (finding #7): only trust a live orphan server after
    // connect + resume + read + validate all succeed. Any failure → fresh spawn.
    const canRejoin = !!this.#resumeThreadId && existsSync(this.#socketPath);
    this.#startSend({ type: "start", canRejoin });
    try {
      let client: CodexAppServerClient | null = null;
      if (canRejoin) client = await this.#tryRejoin();
      if (!client) {
        if (this.#startState.phase === "ended") return; // killed while the rejoin was pending: do not spawn (Astra on d4fc9336)
        client = await this.#spawnFresh();
      }
      if (this.#startState.phase === "ended") { // killed while starting: this generation owns nothing (Astra on d6b84547)
        try { client.close(); } catch { /* best effort */ }
        return;
      }
      this.#client = client;
      // Reconcile done → live: the machine flushes the buffer (bound to the
      // replay under the response frame's barrier) and readies the driver.
      this.#startSend({ type: "reconcile_done" });
    } catch (e) {
      process.stderr.write(`[codex ${this.id}] start failed: ${e}\n`);
      this.#startSend({ type: "start_failed", error: String(e) }); // → end("process_exited")
      if (this.status !== "ended") this.end("process_exited");
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
      // Bound on the REJOIN path before reconcile, so it leaves any in-progress
      // turn OPEN (a live orphan whose real notifications will arrive) rather
      // than closing it (finding #5).
      this.#startSend({ type: "thread_resumed", threadId: r.threadId });
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
      this.#startSend({ type: "rejoin_failed", error: String(e) });
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
      // the session it was started for (Astra on d4fc9336).
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
      this.#startSend({ type: "thread_resumed", threadId: r.threadId });
      await this.#reconcileHistory(client);
    } else {
      const r = await client.threadStart({ cwd: this.cwd, permissionMode: this.#permissionMode, model: this.model, developerInstructions: this.#developerInstructions });
      this.#threadId = r.threadId;
      this.#norm.setThreadId(r.threadId);
      this.transcriptPath = r.rolloutPath ?? undefined;
      this.#persistWindowRecord();
      if (r.model) { this.currentModel = r.model; void this.#relay?.updateModelCode(r.model); }
      this.#startSend({ type: "thread_started", threadId: r.threadId });
    }
    return client;
  }

  /** Wire the notification / server-request / close handlers onto a client. */
  #wireClient(client: CodexAppServerClient): void {
    client.onNotification((n, seq) => this.#onNotification(n, seq));
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

  /** Joy-owned slash commands the harness executes itself (never forwarded
   *  to the model); the coordinator completes their row in the accept
   *  transaction, so a relay turn carrying one terminalizes at once (#65).
   *   - /title: with text set + lock, bare unlock (parity with the other adapters);
   *   - /joy-prompt: re-deliver the CURRENT joy instructions in-band (the
   *     thread's developerInstructions are frozen at start, and attention
   *     decays in long sessions regardless); also refreshes the stored
   *     instructions so a thread restart launches with the latest wording.
   *     The reinjection body is a hidden follow-up command the coordinator
   *     queues; only the /joy-prompt row (when mirrored) appears in chat. */
  #handleCommand(text: string, opts: { source: string; mirrorToRelay: boolean; seq?: number | null }): HandledCommand | null {
    const titleCmd = /^\/title(?:\s+(.*))?$/s.exec(text.trim());
    if (titleCmd) {
      const t = (titleCmd[1] ?? "").trim();
      this.#titleLocked = t.length > 0;
      saveWindowRecord(this.id, { launchCwd: this.cwd, titleLockedByUser: this.#titleLocked });
      if (t) { this.summary = t; void this.#relay?.updateSummary(t); }
      this.#deps.broadcast("session_update", this.toJSON());
      if (opts.mirrorToRelay && this.#relay) this.#relay.send(encodeUserMessage(text, Date.now()), `codex:in:${this.id}:${opts.seq ?? randomUUID()}`);
      return { handled: true };
    }
    if (/^\/joy-prompt(?:\s|$)/.test(text.trim())) {
      this.#developerInstructions = codexJoyInstructions();
      this.#persistWindowRecord();
      if (opts.mirrorToRelay && this.#relay) this.#relay.send(encodeUserMessage(text, Date.now()), `codex:in:${this.id}:${opts.seq ?? randomUUID()}`);
      return { handled: true, reinjection: joyPromptReinjection(codexJoyInstructions()) };
    }
    return null;
  }

  /** The mirror row's localId is unique per MESSAGE: two non-relay sends in
   *  the same millisecond shared `codex:in:<id>:<ms>` and the relay deduped
   *  the second away as a replay (Astra medium). Relay sends keep the seq
   *  (stable across a redelivery — that dedupe is wanted). */
  #mirrorAccepted(cmd: CommandView): void {
    if (!cmd.mirrorToRelay || !this.#relay) return;
    this.#relay.send(encodeUserMessage(cmd.text, cmd.createdAt), `codex:in:${this.id}:${cmd.seq ?? cmd.id}`);
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

  /** The relay acked a turn's terminal row: advance the delivered-turn
   *  high-water. Committed pending until every outbox row of this session
   *  up to that point is acked (finding #2, #67); a restart before that
   *  replays from the previous mark, receipt-deduped. Held outright while
   *  the outbox cannot persist (rows exist only in RAM). */
  #markTurnDelivered(turnId: string): void {
    // The machine refuses a mark behind the current one or past a deferred
    // turn (#518: the mark is a delivered PREFIX, and that turn is a hole
    // in it); the ledger write is the commit, and the state moves only once
    // it has landed.
    const t = nextDeliveredState(this.#delivered, { type: "acked", turnId });
    if (!t || !t.commit) return;
    if (this.#relay?.outboundPersistDegraded) return;
    try {
      this.#ledger.setCheckpoint(this.id, "codex_turn", t.commit, 0, { throughSeq: "latest", generation: this.#generation });
      this.#delivered = t.to;
    } catch (e) {
      process.stderr.write(`[codex ${this.id}] checkpoint ${t.commit} failed: ${e instanceof Error ? e.message : e}\n`);
    }
  }

  /** One step of the delivered-mark machine (the ledger call, when one is
   *  owed, is the caller's — a rewind clears it, an ack commits it). */
  #deliveredSend(ev: Parameters<typeof nextDeliveredState>[1]): void {
    const t = nextDeliveredState(this.#delivered, ev);
    if (t) this.#delivered = t.to;
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
        // The server wants a token joy cannot mint: the sign-in is about to
        // fail. Remember when, and look at the pane sooner.
        this.#authRefreshRequestedAt = Date.now();
        process.stderr.write(`[codex ${this.id}] app-server asked to refresh ChatGPT auth tokens — a sign-in is needed\n`);
        this.#scheduleAuthWatch(500);
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

  #onNotification(n: CodexNotification, seq: number): void {
    // Buffered while the start machine is not yet live (the thread filter is
    // inactive until #threadId is known, and live traffic must not
    // interleave with the synthetic history replay — finding #10);
    // dispatched at once when it is. `seq` is the client's dispatch
    // sequence — the coordinate the snapshot barrier is expressed in.
    this.#startSend({ type: "notification", n, seq });
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
      // A turn/started alone is not attributable — the coordinator treats it
      // as foreign until the userMessage ECHO names a clientId; guessing
      // interrupted an unrelated TUI turn (Astra on e573e1a9).
      this.#driver.emit({ kind: "turn_started", runtimeTurnId: typeof turn.id === "string" ? turn.id : null });
    } else if (n.method === "turn/completed") {
      const turn = (n.params?.turn ?? {}) as Record<string, unknown>;
      const turnId = typeof turn.id === "string" ? turn.id : this.#activeTurnId;
      this.#activeTurnId = null;
      // Checkpoint is advanced by the terminal-row ACK (setReceiptSink), NOT
      // here (finding #2). The coordinator settles the command this turn ran.
      this.#driver.emit({ kind: "turn_ended", runtimeTurnId: turnId, status: codexTurnStatus(String(turn.status ?? "completed")) });
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

  /** Send the held turn-start (#131) — before anything else of its turn. */
  #flushHeldTurnStart(): void {
    const held = this.#heldTurnStart;
    if (!held) return;
    this.#heldTurnStart = null;
    this.#relay?.send(held.record, held.localId);
  }

  #applyEffects(effects: ReturnType<CodexNormalizer["handle"]>): void {
    for (const eff of effects) {
      switch (eff.kind) {
        case "wire": {
          const data = (eff.record as { content?: { data?: { ev?: { t?: string; text?: string } } } }).content?.data;
          if (data?.ev?.t === "turn-start") {
            // Held until the turn's first item (#131): a TUI-typed prompt's
            // user row must precede the bracket, as a joy-sent one does.
            this.#flushHeldTurnStart();
            this.#heldTurnStart = { record: eff.record, localId: eff.localId };
            break;
          }
          this.#flushHeldTurnStart();
          this.#relay?.send(eff.record, eff.localId);
          if (data?.ev?.t === "text" && data.ev.text) this.#mirrorChat(eff.localId ?? String(Math.random()), data.ev.text);
          break;
        }
        case "thinking": this.#thinking = eff.value; this.#relay?.setThinking(eff.value); break;
        case "receipt": this.#flushHeldTurnStart(); this.#relay?.stampReceiptOnLastQueued({ uuid: eff.uuid, turn: eff.turn }); break;
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
        case "confirmDispatch":
          // The userMessage echo carrying a clientId we submitted proves
          // delivery; the coordinator pairs it with its attempt (a late one
          // for a cancelled row is interrupted there — the tombstone rule).
          // Only OUR id opens the bracket here (our prompt's row is already
          // in the card). A foreign client id — the TUI / another app-server
          // client stamps its own — is not ours to bracket: its user row is
          // mirrored on item/completed and must land first, so the held
          // turn-start waits for that effect (#131).
          if (this.#ledger.ownsRuntimeRef(this.id, eff.clientId, "codex_client")) {
            this.#flushHeldTurnStart();
            this.#driver.emit({ kind: "echo", runtimeRef: eff.clientId, runtimeTurnId: eff.turn, receiptKind: "codex_client" });
          }
          break;
        case "userMessage": {
          // Ours if this session ever submitted that clientId (an attempt
          // row or a retained receipt); anything else was typed in the
          // attached TUI and has no relay row — mirror it once, BEFORE the
          // held turn-start so the app brackets it like a joy-sent prompt
          // (#131). Not during history replay: a fresh card already emitted
          // user rows before the turn bracket (#78).
          const ours = !!eff.clientId && this.#ledger.ownsRuntimeRef(this.id, eff.clientId, "codex_client");
          if (ours) { this.#flushHeldTurnStart(); this.#driver.emit({ kind: "echo", runtimeRef: eff.clientId, runtimeTurnId: eff.turn, receiptKind: "codex_client" }); break; }
          if (this.#replayingHistory && this.#freshCard) { this.#flushHeldTurnStart(); break; } // already emitted before the turn bracket
          this.#relay?.send(encodeUserMessage(eff.text, Date.now()), eff.localId);
          this.#flushHeldTurnStart();
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
    const { thread, notifBarrier } = await client.threadRead(this.#threadId!);
    // Everything dispatched before the read's response frame could be in
    // the snapshot; nothing after it can be (#519). The client's barrier,
    // not the buffer length here: by the time this continuation runs the
    // socket may already have dispatched frames that FOLLOWED the response.
    this.#startSend({ type: "read_response", barrier: notifBarrier });
    const turns = Array.isArray(thread.turns) ? thread.turns as Record<string, unknown>[] : [];

    // Rewind detection (finding #5): if our delivered high-water turn is no
    // longer in history, the TUI rolled back the tail. Surface it rather than
    // silently skipping turns the app still shows.
    const high = markRef(this.#delivered.mark);
    if (high && !turns.some((t) => String(t.id ?? "") === high)) {
      process.stderr.write(`[codex ${this.id}] history rewound past ${high} — resetting checkpoint\n`);
      this.#deliveredSend({ type: "rewound" });
      try { this.#ledger.clearCheckpoint(this.id, "codex_turn"); } catch { /* the next mark rewrites it */ }
    }

    for (const turn of turns) {
      const tid = String(turn.id ?? "");
      if (!tid) continue;
      // Already delivered before the restart — skip wholesale.
      if (isDelivered(this.#delivered.mark, tid)) continue;
      const status = String(turn.status ?? "completed");
      const view = String(turn.itemsView ?? "full");
      // A turn whose items history did NOT fully return can't be faithfully
      // replayed — skip its items and do NOT checkpoint it (finding #2/#5).
      // Nor anything AFTER it: a later terminal turn's ack used to advance
      // the high-water past this gap, and the next recovery skipped this
      // turn's output for good once its full items were available (#518).
      // A TERMINAL deferred turn is left alone entirely (no bracket for
      // content that is not here yet). An IN-PROGRESS one still falls
      // through to the status handling below: whether the runtime is active
      // is a fact about the turn, not about its item availability — the
      // rejoined session read idle and Stop had nothing to interrupt when
      // the live turn's items came back partial (#513).
      const deferred = !!view && view !== "full";
      if (deferred) {
        process.stderr.write(`[codex ${this.id}] turn ${tid} itemsView=${view} — deferring replay; the delivered mark holds below it\n`);
        this.#deliveredSend({ type: "deferred", turnId: tid });
        if (status !== "inProgress") continue;
      }
      let items = deferred ? [] : (Array.isArray(turn.items) ? turn.items as Record<string, unknown>[] : []);
      // A turn the OLD server left in progress is dead with it on a fresh
      // spawn (a rejoin keeps it live, below). When nothing ran, a prompt of
      // OURS still pending is not replayed (#625): no echo binds its row, so
      // the row stays `unknown` and the coordinator's reconcile — the
      // driver's thread/read finds it in a dead turn with no output —
      // re-sends it. Only such prompts, though: one typed in the TUI, or one
      // of ours the ledger already settled, is nobody's to resend, so it
      // replays like any history (its user row on a fresh card) and the dead
      // turn closes `interrupted` below — dropping it lost history. One that
      // visibly ran is replayed whole and closed below, and its row ends
      // `interrupted` so the prompt is never run twice.
      const dead = status === "inProgress" && !isRejoined(this.#startState);
      const ran = items.some((item) => String((item as { type?: unknown }).type ?? "") !== "userMessage");
      if (dead && !ran) {
        const kept = items.filter((item) => !this.#pendingOwnPrompt(item));
        if (kept.length < items.length) process.stderr.write(`[codex ${this.id}] turn ${tid} died with the previous app-server before any output — ${items.length - kept.length} pending prompt(s) of ours not replayed; reconciled from thread/read\n`);
        if (!kept.length) continue;
        items = kept;
      }
      // What replay is about to emit — id, ordinal, whole content — for the
      // live-buffer flush (#519).
      const ordinals = new Map<string, number>();
      const replayed: HistoryItem[] = items.map((item) => {
        const type = String((item as { type?: unknown }).type ?? "");
        const ordinal = ordinals.get(type) ?? 0;
        ordinals.set(type, ordinal + 1);
        return { id: String((item as { id?: unknown }).id ?? ""), type, ordinal, sig: itemSignature(item), matched: false };
      });
      this.#startSend({ type: "history_replayed", turnId: tid, items: replayed });
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
      // Either way the coordinator hears the turn end, as it does live: the
      // replayed echo bound our attempt to this turn, and a row left waiting
      // for a terminal the dead server can never send was stuck for good
      // (#625). A turn none of our attempts rode is nobody's to settle.
      if (status !== "inProgress") {
        this.#applyEffects(this.#norm.handle({ method: "turn/completed", params: { turn: { id: tid, status } } }));
        this.#emitReplayedTurnEnd(tid, codexTurnStatus(status), "replayed from thread/read");
      } else if (!isRejoined(this.#startState)) {
        this.#applyEffects(this.#norm.handle({ method: "turn/completed", params: { turn: { id: tid, status: "interrupted" } } }));
        // Only a dead turn that visibly RAN is the coordinator's to end here
        // (its rows settle `interrupted` rather than run twice). One that
        // never ran holds prompts reconcile is about to re-send — withheld
        // above, yet bound to this turn id since turn/start named it — or
        // rows the ledger already settled: a turn_ended naming the turn
        // would end the pending row `interrupted` and lose the resend.
        if (ran) this.#emitReplayedTurnEnd(tid, "interrupted", "app-server died mid-turn");
      } else {
        // A LIVE turn we rejoined: it is the active one — busy, thinking,
        // interruptible by id. Its turn/started fired before we connected
        // and will never be replayed, so tell the coordinator now (its own
        // attempt claims it when the turn id is known; otherwise it is a
        // foreign turn, R8). Without this the session read idle, abort()
        // had nothing to interrupt and the next prompt was started against
        // the running turn (#513).
        this.#activeTurnId = tid;
        this.#applyEffects([{ kind: "thinking", value: true }]);
        this.#driver.emit({ kind: "turn_started", runtimeTurnId: tid });
      }
    }
    // The high-water advances via terminal-row ACKs (setReceiptSink).
  }

  /** Is this history prompt one the coordinator is about to settle itself: an
   *  attempt of ours still awaiting evidence, on a command still pending? On
   *  a fresh spawn the restart left such a command `unknown`; its reconcile
   *  re-sends it when the dead turn shows no output (#625). Anything else —
   *  a TUI-typed prompt, a prompt of ours already settled — is history to
   *  replay. */
  #pendingOwnPrompt(item: Record<string, unknown>): boolean {
    if (String(item.type ?? "") !== "userMessage") return false;
    const ref = String(item.clientId ?? item.clientUserMessageId ?? "");
    if (!ref) return false;
    const attempt = this.#ledger.attemptByRef(this.id, ref);
    if (!attempt || !AWAITING_ATTEMPT_STATES.includes(attempt.state)) return false;
    const cmd = this.#ledger.getCommand(attempt.commandId);
    return !!cmd && NON_TERMINAL_STATES.includes(cmd.state);
  }

  /** A history turn's end, told to the coordinator when one of our attempts
   *  rode it (its replayed echo bound the turn id) — what the live path does
   *  on every turn/completed (#625). */
  #emitReplayedTurnEnd(tid: string, status: "completed" | "failed" | "cancelled" | "interrupted", detail: string): void {
    if (!this.#ledger.attemptsByRuntimeTurnId(this.id, tid).length) return;
    this.#driver.emit({ kind: "turn_ended", runtimeTurnId: tid, status, detail });
  }

  // ── app-facing state (the queue itself is the coordinator's) ────────────────

  busy(): boolean { return this.#thinking || this.#coordinator.busy(this.id); }

  #replayingHistory = false;

  /** Stop what is executing: every command in flight is cancelled durably
   *  (the coordinator interrupts and retries until confirmed) and a foreign
   *  turn gets turnInterrupt. A failed interrupt is reported, not swallowed:
   *  the app's Stop used to read success while the agent kept running (#8). */
  async abort(): Promise<{ ok: boolean; error?: string }> {
    return this.#coordinator.abortRunning(this.id);
  }

  // ── pane / control (the tmux window hosts the attached TUI) ───────────────────

  #scheduleAuthWatch(ms: number): void {
    if (this.#authTimer) clearTimeout(this.#authTimer);
    this.#authTimer = setTimeout(() => { this.#authTimer = null; void this.#authWatchTick(); }, ms);
  }

  async #authWatchTick(): Promise<void> {
    if (this.status === "ended") return;
    let text = "";
    try { const r = await this.#tmux.captureFresh(this.tmuxWindow, { color: false }); text = r.ok ? r.out : ""; } catch { /* pane gone or not yet up */ }
    const auth = text ? codexPaneAuth(text) : null;
    const now = Date.now();
    // Auto-continue a bare keypress screen, once per appearance.
    if (auth?.kind === "continue") {
      if (!this.#authContinuePressed) { this.#authContinuePressed = true; void this.#tmux.key(this.tmuxWindow, "Enter").catch(() => {}); }
    } else this.#authContinuePressed = false;
    // What the card should say. Each is published only on change, and only
    // once a relay is attached — the state is kept so attach catches up.
    let login: JoyLoginInfo | null = null;
    let dialog: JoyDialogInfo | null = null;
    if (auth?.kind === "device") login = { kind: "codex", url: auth.url, code: auth.code, since: now, ...(auth.expiresMinutes ? { expiresAt: now + auth.expiresMinutes * 60_000 } : {}) };
    else if (auth?.kind === "chooser") dialog = { title: "Codex needs a sign-in", options: auth.options, since: now };
    else if (auth?.kind === "broken") login = { kind: "codex", error: auth.message, since: now };
    if (this.#relay) {
      const loginKey = login ? `${login.url ?? ""}|${login.code ?? ""}|${login.error ?? ""}` : null;
      if (loginKey !== this.#authShown.login) { this.#authShown.login = loginKey; void this.#relay.updateLogin(login); }
      const dialogKey = dialog ? dialog.options.join("|") : null;
      if (dialogKey !== this.#authShown.dialog) { this.#authShown.dialog = dialogKey; this.#relay.updateDialog(dialog); }
    }
    // Quick while something needs a human or the runtime is still coming up
    // (or the server just asked for a token), slow in a healthy conversation.
    const attentive = auth !== null || this.status === "starting" || now - this.#authRefreshRequestedAt < 60_000;
    this.#scheduleAuthWatch(attentive ? 2_000 : 15_000);
  }

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

  /** Reasoning effort for the NEXT turn (codex keeps it for the turns after). */
  async setEffort(effort: string | null): Promise<{ ok: boolean; effort?: string; error?: string }> {
    this.#pendingEffort = effort;
    this.currentEffort = effort ?? undefined;
    this.#persistWindowRecord();
    this.#deps.broadcast("session_update", this.toJSON());
    return { ok: true, effort: this.currentEffort };
  }

  /** Model for the NEXT turn (codex keeps it for the turns after). The card
   *  shows it at once; the thread's own report on the next turn confirms. */
  async setModel(model: string): Promise<{ ok: boolean; model?: string; error?: string }> {
    this.#pendingModel = model;
    this.currentModel = model;
    void this.#relay?.updateModelCode(model);
    this.#persistWindowRecord();
    this.#deps.broadcast("session_update", this.toJSON());
    return { ok: true, model };
  }

  get permissionMode(): string { return this.#permissionMode; }

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
    // A start step still in flight finds the machine ended and abandons
    // what it made (Astra on d4fc9336, d6b84547).
    this.#startSend({ type: "killed", reason });
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
      this.#flushHeldTurnStart();
      try { this.#relay?.send(encodeTurnEnd("cancelled", { turn: this.#activeTurnId }), `codex:${this.#threadId}:turn:${this.#activeTurnId}:complete`); } catch { /* ignore */ }
      this.#activeTurnId = null;
    }
    this.#heldTurnStart = null;
    // The session's own flag too, not only the relay's: an ended session read
    // busy forever through busy() and toJSON() (#515).
    this.#thinking = false;
    if (this.#relay) this.#relay.setThinking(false);
    if (this.#authTimer) { clearTimeout(this.#authTimer); this.#authTimer = null; }
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
    // (the record — and the thread — are still there). The coordinator
    // closes the generation and settles what was mid-flight.
    this.#unsubscribeQueue();
    this.#coordinator.retire(this.id, reason);
    if (reason === "killed") { try { this.#ledger.clearCheckpoint(this.id, "codex_turn"); } catch { /* the next fresh session clears it */ } }
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
      // (Astra on 57fb90a3, #43).
      if (this.#relay) { this.#archivePromise = this.#relay.archive(); this.#relay.stop(); this.#relay = null; }
      this.endReason = "killed";
      this.#recordTerminated = deleteWindowRecord(this.id);
      // Nothing left to deliver or resume (#43).
      this.#coordinator.retire(this.id, "killed");
      try { this.#ledger.clearCheckpoint(this.id, "codex_turn"); } catch { /* the next fresh session clears it */ }
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
      current_effort: this.currentEffort ?? this.effort,
      permission_mode: this.#permissionMode,
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
