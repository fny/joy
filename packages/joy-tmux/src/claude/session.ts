// Session: one Claude Code instance running in a tmux window, bridged to the
// Happy relay. Owns ALL per-session state that used to be scattered across
// eight parallel Maps in server.ts (relay session, transcript watcher, turn
// state, delivery receipts, pending attachments, prelaunch message buffer).
//
// The two invariants this class exists to enforce:
//   1. There is exactly ONE teardown path — end(reason). Every way a session
//      can die (app archive, RPC kill, HTTP DELETE, Claude process exit)
//      funnels through it, so cleanup steps can't be missed or mis-ordered.
//   2. There is exactly ONE send path — sendText(). Every transport (relay
//      message, HTTP /send, machine RPC) gets the same semantics: messages
//      sent while Claude is still booting are buffered and flushed when the
//      first transcript entry lands.

import { setTimeout as sleep } from "timers/promises";
import { existsSync, readFileSync } from "fs";
import { run } from "../tmux/shell";
import {
  encodeTurnStart,
  encodeTextEvent,
  encodeToolCallStart,
  encodeToolCallEnd,
  encodeTurnEnd,
  encodeUserMessage,
  type RelayClient,
  type RelaySession,
} from "../relay/relay.ts";
import {
  initDeliveryState,
  recordInboundReceipt,
  recordOutboundReceipt,
  recordReceived,
  consumeReceived,
  type DeliveryState,
  type DeliverySource,
} from "../domain/receipts";
import { writeAttachmentToCwd } from "../domain/attachments";
import { cwdToTranscriptDir, findLatestTranscript, tailJsonl, type TranscriptTailer } from "./transcript";
import { toTmuxSegments, ParseError, TmuxKeyError } from "../tmux/keyTokens";

export type SessionStatus = "starting" | "active" | "ended";

// Startup watchdog cadence. If Claude shows no sign of life within the deadline
// (it exited at launch — bad --continue/--resume, crash, missing binary), the
// session is ended as process_exited so it surfaces as detached, not stuck.
const STARTUP_POLL_MS = 700;
const STARTUP_DEADLINE_ATTEMPTS = 30; // ~21s — long enough for cold start / --resume

// 500-error auto-retry backoff (seconds): paired ramp, then STOP. 14 attempts,
// ~63 min total. When a turn ENDS with an unresolved 5xx (Claude gave up after
// its own internal retries), joy-tmux re-sends the failed turn on this schedule
// until it succeeds, abort is pressed, or the schedule runs out.
const RETRY_SCHEDULE_SEC = [15, 15, 30, 30, 60, 60, 120, 120, 240, 240, 480, 480, 960, 960];

/**
 * Turn a CLI-wrapped command transcript entry into a clean one-line echo so it
 * can show in chat instead of being dropped (which left no confirmation a
 * command was received). Returns null for unparseable noise.
 *   <command-name>/model</command-name><command-args>opus</command-args> → "/model opus"
 *   <bash-input>ls -la</bash-input>…                                       → "$ ls -la"
 */
// Strip ANSI/terminal escape sequences (SGR colors, cursor moves, OSC) so
// mirrored command output doesn't render as garbage in the chat.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]|[\x00-\x08\x0b-\x1f\x7f]/g;
export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

export function summarizeCommandEcho(content: string): string | null {
  const pick = (tag: string) => {
    const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(content);
    return m ? stripAnsi(m[1]).trim() : "";
  };
  // Slash command: command-message is the human-readable form; fall back to name+args.
  const message = pick("command-message");
  const name = pick("command-name");
  if (message || name) {
    if (message) return message.startsWith("/") ? message : `/${message}`;
    const args = pick("command-args");
    const slash = name.startsWith("/") ? name : `/${name}`;
    return args ? `${slash} ${args}` : slash;
  }
  // Local ! bash: prefer the input command, else the first line of output.
  const bashIn = pick("bash-input");
  if (bashIn) return `$ ${bashIn.split("\n")[0]}`.slice(0, 200);
  const out = pick("local-command-stdout") || pick("local-command-stderr");
  if (out) {
    const first = out.split("\n").find(l => l.trim());
    return first ? `$ ${first}`.slice(0, 200) : null;
  }
  return null;
}

/** Wire shape — frozen. The app and the debug page consume this JSON. */
export interface SessionRecord {
  id: string;
  claude_session_id?: string;
  current_model?: string;
  pid?: number;
  tmux_window: string;
  cwd: string;
  model?: string;
  effort?: string;
  flags: string[];
  status: SessionStatus;
  started_at: number;
  last_active_at: number;
  end_reason?: string;
  transcript_path?: string;
  relay_session_id?: string;
}

export interface ChatMessage {
  role: "user" | "assistant" | "event";
  content: string;
  source: "web" | "cli" | "rpc";
  chat_id?: string;
  session_id?: string;
  event_type?: string;
  event_status?: "info" | "success" | "error" | "warning";
}

/** Capabilities a Session needs from its environment, injected by the registry. */
export interface SessionDeps {
  relayClient: RelayClient | null;
  broadcast(event: string, data: unknown): void;
  addChatMessage(msg: ChatMessage): void;
  /** Called when a relay session is attached — the place to register session-scoped ops. */
  onRelayAttached?: (session: Session, rs: RelaySession) => void;
}

export interface SendOptions {
  seq?: number;
  source: DeliverySource;
  /** Mirror the message to the relay so the app's chat history shows it (web/rpc sends). */
  mirrorToRelay: boolean;
}

interface BufferedMessage extends SendOptions {
  text: string;
}

export interface QueuedMessage {
  id: string;
  text: string;
  createdAt: number;
}

export interface QueueState {
  queue: QueuedMessage[];
  /** Text of the message dispatched but not yet confirmed, or null. */
  inFlight: string | null;
  /** True when auto-drain is halted after a failed dispatch. */
  paused: boolean;
}

export interface SessionInit {
  id: string;
  tmuxWindow: string;
  cwd: string;
  model?: string;
  effort?: string;
  flags: string[];
  status: SessionStatus;
  startedAt: number;
  pid?: number;
  claudeSessionId?: string;
  transcriptPath?: string;
  /** Byte offset to start tailing at (resume backfill cap, snapped to a turn). */
  transcriptStartOffset?: number;
}

export class Session {
  readonly id: string;
  readonly tmuxWindow: string;
  readonly cwd: string;
  readonly model?: string;
  readonly effort?: string;
  readonly flags: string[];
  status: SessionStatus;
  startedAt: number;
  lastActiveAt: number;
  pid?: number;
  endReason?: string;
  claudeSessionId?: string;
  transcriptPath?: string;
  /** Model id from the most recent assistant transcript entry (e.g. claude-fable-5). */
  currentModel?: string;
  /** Claude's generated conversation title (ai-title), mirrored to the relay summary. */
  summary?: string;
  /** Survives relay detach so end() can still archive server-side. */
  relaySessionId?: string;

  #deps: SessionDeps;
  #relay: RelaySession | null = null;
  #tailer: TranscriptTailer | null = null;
  #turn: { turnId: string } | null = null;
  // Last "thinking" value pushed to the relay. The pane poll (#pollThinking)
  // reconciles this against the live pane so the app's status matches the
  // window; the event-driven setters below give instant feedback in between.
  #thinking = false;
  // The (retrying) archive POST fired when this session is killed — awaited by
  // the killSession op so it can report a genuine failure to the app instead of
  // an unconditional success (which would suppress the app's fallback archive).
  #archivePromise: Promise<boolean> | null = null;
  // Throttle: surface at most one api_error note per turn (Claude retries up to
  // 10×, so a turn can emit several). Reset at turn end.
  #errorNotedThisTurn = false;
  // 500-error auto-retry. #turn5xxStatus holds the last 5xx status seen in the
  // current turn; it's cleared the moment Claude produces real output (recovery)
  // and consumed on turn-end — if a turn ENDS with it still set, Claude gave up
  // on a server error, so we re-send the failed prompt (#lastUserText) on
  // RETRY_SCHEDULE_SEC. #retry holds the live backoff timer + attempt count.
  #retry: { attempts: number; timer: ReturnType<typeof setTimeout> | null } | null = null;
  #turn5xxStatus: number | null = null;
  #lastUserText: string | null = null;
  // Byte offset the tailer starts at — non-zero only for a capped --resume
  // backfill (snapped to a turn boundary so we don't replay a partial turn).
  #transcriptStartOffset = 0;
  #delivery: DeliveryState | null = null;
  #pendingAttachments: Promise<Uint8Array | null>[] = [];
  // The most recent `!cmd` command, captured from <bash-input> so it can head
  // the bash-output card.
  #pendingBashCmd?: string;
  #prelaunchBuffer: BufferedMessage[] = [];
  #promptPollActive = false;
  #trustHandled = false;

  // ── Message queue ──────────────────────────────────────────────────────────
  // Messages the user lined up while Claude was busy. They stay editable here
  // until the daemon DISPATCHES one (types it into the pane), at which point it
  // leaves the queue and becomes a normal turn. So the queue never contains the
  // in-flight message — edit/cancel/reorder are plain array ops.
  #queue: QueuedMessage[] = [];
  // The message typed-but-not-yet-confirmed. Treated as busy: nothing else
  // dispatches until Claude starts a turn in response (echo confirmation) or we
  // time out. Confirmed when the next turn-start fires; failed on timeout.
  #dispatchInFlight: { id: string; text: string; at: number } | null = null;
  #dispatchTimer: ReturnType<typeof setTimeout> | null = null;
  #drainRetry: ReturnType<typeof setTimeout> | null = null;
  // Set when a dispatch failed to land (no turn started) — stops auto-draining
  // so we don't shovel messages into a wedged/odd state. Cleared by resume.
  #queuePaused = false;

  constructor(init: SessionInit, deps: SessionDeps) {
    this.id = init.id;
    this.tmuxWindow = init.tmuxWindow;
    this.cwd = init.cwd;
    this.model = init.model;
    this.effort = init.effort;
    this.flags = init.flags;
    this.status = init.status;
    this.startedAt = init.startedAt;
    this.lastActiveAt = Date.now();
    this.pid = init.pid;
    this.claudeSessionId = init.claudeSessionId;
    this.transcriptPath = init.transcriptPath;
    this.#transcriptStartOffset = init.transcriptStartOffset ?? 0;
    this.#deps = deps;
  }

  get relayAttached(): boolean {
    return this.#relay !== null;
  }

  get watcherActive(): boolean {
    return this.#tailer !== null;
  }

  /** Frozen snake_case wire shape (app metadata + debug page + RPC results). */
  toJSON(): SessionRecord {
    return {
      id: this.id,
      claude_session_id: this.claudeSessionId,
      pid: this.pid,
      tmux_window: this.tmuxWindow,
      cwd: this.cwd,
      model: this.model,
      effort: this.effort,
      flags: this.flags,
      status: this.status,
      started_at: this.startedAt,
      last_active_at: this.lastActiveAt,
      end_reason: this.endReason,
      transcript_path: this.transcriptPath,
      relay_session_id: this.relaySessionId,
      current_model: this.currentModel,
    };
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  /** Start transcript discovery + PID-death polling. Call once after construction. */
  beginWatching(): void {
    this.pollForTranscript();
    this.#pollEnd();
    this.#pollThinking();
    this.#watchTrustPrompt();
    this.#watchStartup();
  }

  /**
   * Startup watchdog: confirm Claude actually came up after launch. If it
   * exited immediately (no conversation to --continue, a bad --resume, a crash,
   * a missing binary), the PID probe can latch onto the immortal login shell —
   * so #pollEnd never sees a death and the session sits in 'starting' forever,
   * never detached. Poll the pane for evidence Claude is running; if none
   * appears within the deadline, end as process_exited so it shows as detached
   * (red) instead of stuck. Resolves silently once Claude is visibly up.
   */
  #watchStartup(attempts = 0): void {
    if (this.status === "ended" || this.status === "active") return; // already resolved
    const pane = run("tmux", "capture-pane", "-p", "-t", this.tmuxWindow);
    if (pane.ok && paneShowsClaudeRunning(pane.out)) return; // Claude is visibly up
    if (attempts >= STARTUP_DEADLINE_ATTEMPTS) {
      process.stderr.write(`[startup] ${this.id}: claude never came up within deadline → detached\n`);
      this.end("process_exited");
      return;
    }
    setTimeout(() => this.#watchStartup(attempts + 1), STARTUP_POLL_MS);
  }

  /**
   * Claude shows a "Is this a project you trust?" dialog on the first launch in
   * an untrusted directory — it blocks the session and `--dangerously-skip-
   * permissions` doesn't skip it. The user already chose this folder when
   * creating the session, so auto-confirm "Yes, I trust this folder". Polls for
   * a bounded window; fires at most once.
   */
  #watchTrustPrompt(attempts = 0): void {
    if (this.status === "ended" || this.status === "active" || this.#trustHandled) return;
    const pane = run("tmux", "capture-pane", "-p", "-t", this.tmuxWindow);
    if (pane.ok && /Yes, I trust this folder|Is this a project you (created|trust)/i.test(pane.out)) {
      // "1" selects "Yes, I trust this folder"; Enter confirms (harmless empty
      // submit if "1" already activated it).
      run("tmux", "send-keys", "-t", this.tmuxWindow, "1", "Enter");
      this.#trustHandled = true;
      return;
    }
    if (attempts < 60) setTimeout(() => this.#watchTrustPrompt(attempts + 1), 700);
  }

  /**
   * Wire a relay session: message/file-event callbacks, session-scoped op
   * registration (via deps hook), heartbeats. The ONE wiring path — used by
   * launch, recovery, and relay-reconnect alike.
   * Returns false (and stops the relay session) if this session already ended,
   * guarding against kill racing the async relay creation.
   */
  attachRelay(rs: RelaySession, allowEnded = false): boolean {
    // Normally refuse an ended session (guards a kill racing async relay
    // creation). Recovery passes allowEnded so a finished session's file/git
    // RPCs still work — but incoming messages are NOT typed into its dead pane
    // (see #onRelayMessage).
    if (this.status === "ended" && !allowEnded) {
      rs.stop();
      return false;
    }
    // A detached session (ended, window still around) KEEPS heartbeating
    // presence — that per-session liveness is how the app distinguishes "daemon
    // alive, Claude dead" (red detached) from "daemon gone" (falls back to
    // offline). The app renders joy__state='detached' as red, not green online.
    this.#relay = rs;
    this.relaySessionId = rs.relaySessionId;

    // Reconcile a stale retry banner. If the relay says we were retrying but no
    // retry is live in memory, clear it. That's the daemon-restart case:
    // recover() rebuilds the Session with #retry=null, but joy__retry persisted
    // server-side, so the app would otherwise show a stuck "retrying N/…". A
    // plain socket reconnect keeps #retry (the backoff timer survives in-process),
    // so a genuinely-live banner is preserved. (Idempotent — no-op if unset.)
    if (!this.#retry) void rs.updateRetry(null);
    // Reflect the current queue on (re)attach — recovery/reconnect included.
    void rs.updateQueue(this.queueState());

    // File events arrive ahead of the user-text message. Kick off the
    // download/decrypt immediately; the next message drains the bucket.
    rs.onFileEvent = (ev) => {
      if (!this.#deps.relayClient) return;
      const { sessionKey, variant } = rs.encryptionMaterial;
      this.#pendingAttachments.push(
        this.#deps.relayClient.downloadAndDecryptAttachment(rs.relaySessionId, ev.ref, sessionKey, variant),
      );
    };

    rs.onMessage = async (text, seq) => {
      await this.#onRelayMessage(text, seq);
    };

    this.#deps.onRelayAttached?.(this, rs);
    rs.start();
    this.#deps.broadcast("session_update", this.toJSON());

    // Push the existing conversation title on attach. On recovery the tailer
    // runs before the relay exists, so the ai-title entry it sees can't be
    // forwarded — read the latest one straight from the transcript here.
    const title = this.summary ?? this.#readLatestAiTitle();
    if (title) { this.summary = title; void rs.updateSummary(title); }
    return true;
  }

  /** Scan the transcript for the most recent ai-title entry (recovery path). */
  #readLatestAiTitle(): string | null {
    if (!this.transcriptPath || !existsSync(this.transcriptPath)) return null;
    try {
      const lines = readFileSync(this.transcriptPath, "utf-8").split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i].includes('"ai-title"')) continue;
        try {
          const e = JSON.parse(lines[i]);
          if (e.type === "ai-title" && typeof e.aiTitle === "string" && e.aiTitle.trim()) {
            return e.aiTitle.trim();
          }
        } catch { /* skip */ }
      }
    } catch { /* unreadable */ }
    return null;
  }

  /**
   * The ONE teardown path. Two outcomes, by reason:
   *
   *  - "process_exited" → ERRORED. Claude died on its own; the tmux window is
   *    still around at a bash prompt. We stop the tailer and pending work but
   *    KEEP the relay attached (presence off, joy__state='detached') so the app
   *    shows a red detached status and file/git RPCs still answer on the cwd.
   *    Not archived — it's a crash, not a cleanup.
   *  - "killed" → ARCHIVED. Explicit kill/cleanup: mark archived, archive
   *    server-side (drops it from the active list), detach the relay and kill
   *    the window.
   */
  end(reason: "killed" | "process_exited"): boolean {
    if (this.status === "ended") return false;

    // Capture before any relay detach — needed for the archive POST.
    const relaySessionId = this.#relay?.relaySessionId ?? this.relaySessionId;

    this.#tailer?.close();
    this.#tailer = null;
    this.#turn = null;
    if (this.#retry?.timer) clearTimeout(this.#retry.timer);
    this.#retry = null;
    this.#turn5xxStatus = null;
    this.#delivery = null;
    if (this.#dispatchTimer) { clearTimeout(this.#dispatchTimer); this.#dispatchTimer = null; }
    if (this.#drainRetry) { clearTimeout(this.#drainRetry); this.#drainRetry = null; }
    this.#queue = [];
    this.#dispatchInFlight = null;

    this.status = "ended";
    this.endReason = reason;
    this.lastActiveAt = Date.now();

    if (reason === "process_exited") {
      // Detached: keep the relay attached AND keep heartbeating presence (the
      // session-alive loop keeps running), so the app sees a live presence +
      // joy__state='detached' → red "detached". When the daemon dies the
      // heartbeat stops and it lapses to offline. Messages are still ignored
      // (dead pane) via #onRelayMessage.
      // Clear thinking first: #pollThinking stops the instant status==='ended',
      // so without this the keepalive would re-assert a stale thinking:true
      // (Claude usually died mid-turn) forever on the dead session.
      this.#setThinking(false);
      if (this.#relay) void this.#relay.updateJoyState("detached");
    } else {
      // Killed → archived: flag, archive, detach, kill the window.
      if (this.#relay) void this.#relay.updateJoyState("archived");
      this.#relay?.stop();
      this.#relay = null;
      if (this.#deps.relayClient && relaySessionId) {
        // Keep the (retrying) promise so killSession can await the real result.
        this.#archivePromise = this.#deps.relayClient.archiveSession(relaySessionId);
      }
      run("tmux", "kill-window", "-t", this.tmuxWindow);
    }

    this.#deps.broadcast("session_update", this.toJSON());
    return true;
  }

  /** Resolve once the kill-path archive POST settles (true if archived or there
   *  was nothing to archive). Lets killSession report a real failure so the app
   *  runs its own fallback archive instead of trusting an unconditional success. */
  async awaitArchive(): Promise<boolean> {
    return this.#archivePromise ? await this.#archivePromise : true;
  }

  /** Re-assert lifecycle metadata the app reads, on relay reconnect — so a
   *  one-shot transition (notably joy__state:'detached') lost to a merge timeout
   *  at the moment of death reconciles instead of leaving a dead session green.
   *  updateJoyState no-ops if the value already stuck, so this is cheap. */
  reassertLifecycle(): void {
    if (this.status === "ended" && this.endReason === "process_exited") {
      void this.#relay?.updateJoyState("detached");
    }
  }

  /**
   * Force this session gone: an active one ends as "killed"; a detached one
   * (already ended, window still around) gets archived and its window removed.
   * Returns true if anything was torn down. Used by "kill all sessions".
   */
  forceKill(): boolean {
    if (this.status !== "ended") return this.end("killed");
    const relaySessionId = this.#relay?.relaySessionId ?? this.relaySessionId;
    if (this.#relay) {
      void this.#relay.updateJoyState("archived");
      this.#relay.stop();
      this.#relay = null;
    }
    if (this.#deps.relayClient && relaySessionId) {
      this.#archivePromise = this.#deps.relayClient.archiveSession(relaySessionId);
    }
    run("tmux", "kill-window", "-t", this.tmuxWindow);
    this.endReason = "killed";
    this.#deps.broadcast("session_update", this.toJSON());
    return true;
  }

  // ── Op verbs ────────────────────────────────────────────────────────────────

  /**
   * The ONE send path. Buffers while Claude is still booting (status
   * 'starting') — send-keys during that window would land in bash or a
   * trust-prompt dialog and be lost/misinterpreted. Buffered messages flush
   * when Claude's ready prompt appears in the pane (see #pollPromptReady) or
   * when the first transcript entry lands, whichever comes first.
   */
  sendText(text: string, opts: SendOptions): { buffered: boolean } {
    if (this.status === "starting") {
      this.#prelaunchBuffer.push({ text, ...opts });
      this.#pollPromptReady();
      return { buffered: true };
    }
    this.#typeIntoTmux(text, opts);
    return { buffered: false };
  }

  // ── Message queue API ───────────────────────────────────────────────────────

  queueState(): QueueState {
    return {
      queue: this.#queue.map(q => ({ ...q })),
      inFlight: this.#dispatchInFlight?.text ?? null,
      paused: this.#queuePaused,
    };
  }

  enqueue(text: string): QueuedMessage {
    const msg: QueuedMessage = { id: crypto.randomUUID().slice(0, 8), text, createdAt: Date.now() };
    this.#queue.push(msg);
    this.#broadcastQueue();
    this.#maybeDrainQueue(); // drains immediately if Claude is idle
    return msg;
  }

  editQueued(id: string, text: string): boolean {
    const m = this.#queue.find(q => q.id === id);
    if (!m) return false; // already dispatched or unknown
    m.text = text;
    this.#broadcastQueue();
    return true;
  }

  cancelQueued(id: string): boolean {
    const i = this.#queue.findIndex(q => q.id === id);
    if (i < 0) return false;
    this.#queue.splice(i, 1);
    this.#broadcastQueue();
    return true;
  }

  /** Move a queued message to a new index (clamped). */
  reorderQueued(id: string, toIndex: number): boolean {
    const from = this.#queue.findIndex(q => q.id === id);
    if (from < 0) return false;
    const [m] = this.#queue.splice(from, 1);
    const to = Math.max(0, Math.min(this.#queue.length, Math.floor(toIndex)));
    this.#queue.splice(to, 0, m);
    this.#broadcastQueue();
    return true;
  }

  /** Re-enable auto-drain after a paused (failed) dispatch. */
  resumeQueue(): void {
    this.#queuePaused = false;
    this.#broadcastQueue();
    this.#maybeDrainQueue();
  }

  clearQueue(): void {
    this.#queue = [];
    this.#broadcastQueue();
  }

  #broadcastQueue(): void {
    const state = this.queueState();
    this.#deps.broadcast("queue_update", { session_id: this.claudeSessionId, ...state });
    // Push to the app via session metadata so it doesn't have to poll.
    void this.#relay?.updateQueue(state);
  }

  /**
   * Dispatch the head of the queue IF Claude is genuinely idle. The decision
   * does NOT trust the GUI alone — it gates on the authoritative transcript
   * turn state (#turn) and the in-flight echo confirmation, then confirms the
   * pane is at the ready prompt (not a dialog/spinner) before typing.
   */
  #maybeDrainQueue(): void {
    if (this.#drainRetry) { clearTimeout(this.#drainRetry); this.#drainRetry = null; }
    if (this.status !== "active") return;
    if (this.#queuePaused) return;
    if (this.#dispatchInFlight) return; // one dispatch awaiting echo confirmation
    if (this.#turn) return;             // a turn is open → Claude is busy (authoritative)
    if (this.#queue.length === 0) return;

    // Idle per the transcript — now confirm the pane actually shows the ready
    // input prompt. At the instant a turn ends the prompt may not have
    // repainted yet, so recheck shortly rather than dispatching blind.
    const pane = run("tmux", "capture-pane", "-p", "-t", this.tmuxWindow);
    if (!pane.ok || !paneShowsReadyPrompt(pane.out)) {
      this.#drainRetry = setTimeout(() => { this.#drainRetry = null; this.#maybeDrainQueue(); }, 500);
      return;
    }

    const next = this.#queue.shift()!;
    this.#dispatchInFlight = { id: next.id, text: next.text, at: Date.now() };
    this.#broadcastQueue();
    try {
      this.sendText(next.text, { source: "rpc", mirrorToRelay: true });
    } catch (e) {
      // Send failed outright — put it back at the head and pause.
      this.#queue.unshift(next);
      this.#dispatchInFlight = null;
      this.#queuePaused = true;
      this.#broadcastQueue();
      process.stderr.write(`[queue] dispatch send failed for ${this.id}: ${e}\n`);
      return;
    }
    // Arm the echo-confirmation timeout: a successful dispatch produces a new
    // turn (Claude responds). If none appears, the message didn't land.
    this.#dispatchTimer = setTimeout(() => this.#onDispatchTimeout(), 20000);
  }

  /** Called from onTranscriptEntry when a new turn starts — confirms the dispatch landed. */
  #confirmDispatchIfAwaiting(): void {
    if (!this.#dispatchInFlight) return;
    this.#dispatchInFlight = null;
    if (this.#dispatchTimer) { clearTimeout(this.#dispatchTimer); this.#dispatchTimer = null; }
    this.#broadcastQueue();
  }

  #onDispatchTimeout(): void {
    this.#dispatchTimer = null;
    const inflight = this.#dispatchInFlight;
    if (!inflight) return;
    // No turn started in time → the message didn't land (a dialog ate it, or
    // Claude wasn't actually ready). Re-queue at the head and pause so we don't
    // pile more into a bad state; the user resumes once it's sorted.
    this.#dispatchInFlight = null;
    this.#queue.unshift({ id: inflight.id, text: inflight.text, createdAt: Date.now() });
    this.#queuePaused = true;
    this.#broadcastQueue();
    process.stderr.write(`[queue] dispatch for ${this.id} never echoed — paused\n`);
  }

  /**
   * Read the CURRENT permission mode off the pane footer. Empirically mapped
   * on claude 2.1.170 (launched with --dangerously-skip-permissions):
   *   "⏵⏵ bypass permissions on"  → bypassPermissions
   *   "⏵⏵ auto mode on"           → auto
   *   (no marker line)             → default
   *   "⏵⏵ accept edits on"        → acceptEdits
   *   "⏸ plan mode on"            → plan
   */
  detectPermissionMode(): string | null {
    const pane = run("tmux", "capture-pane", "-p", "-t", this.tmuxWindow);
    if (!pane.ok) return null;
    return parsePermissionModeFromPane(pane.out);
  }

  /**
   * Set the permission mode ABSOLUTELY: detect the current mode from the
   * footer, walk the Shift+Tab cycle to the target, verify. The cycle order
   * (same claude version, empirically): bypassPermissions → auto → default →
   * acceptEdits → plan → bypassPermissions.
   */
  async setPermissionMode(target: string): Promise<{ ok: boolean; mode?: string; error?: string }> {
    const CYCLE = ["bypassPermissions", "auto", "default", "acceptEdits", "plan"];
    const ti = CYCLE.indexOf(target);
    if (ti < 0) return { ok: false, error: `unsupported mode: ${target}` };
    const current = this.detectPermissionMode();
    if (current === null) return { ok: false, error: "could not read pane" };
    const ci = CYCLE.indexOf(current);
    if (ci < 0) return { ok: false, error: `unrecognized current mode: ${current}` };
    const steps = (ti - ci + CYCLE.length) % CYCLE.length;
    for (let i = 0; i < steps; i++) {
      run("tmux", "send-keys", "-t", this.tmuxWindow, "BTab");
      await sleep(120); // footer needs a beat to repaint between cycles
    }
    await sleep(250);
    const after = this.detectPermissionMode();
    return after === target
      ? { ok: true, mode: after }
      : { ok: false, mode: after ?? undefined, error: `landed on ${after ?? "unknown"}` };
  }

  /** Escape → Claude Code interactive interprets as "interrupt generation". */
  abort(): { ok: true } {
    // Abort also cancels an in-progress 500 auto-retry (pressing abort means
    // "stop trying"), and disarms a pending retry so the next turn-end won't
    // start one.
    if (this.#retry) {
      this.#emitAgentNote(`⏹ Auto-retry cancelled`, Date.now(), this.claudeSessionId);
      this.#clearRetry();
    }
    this.#turn5xxStatus = null;
    run("tmux", "send-keys", "-t", this.tmuxWindow, "Escape");
    this.#setThinking(false);
    return { ok: true };
  }

  /**
   * Raw intervention path: parse a bracketed key script (see keyTokens.ts —
   * `git commit<Enter>oops<C-c>`) and replay it into the pane verbatim.
   * Unlike sendText this does NOT buffer, record receipts, mirror to the
   * relay, or auto-append Enter — it is a direct keyboard, for poking at
   * trust prompts, TUI menus, or a wedged claude. Consecutive named keys
   * are batched into one tmux call; literal runs are sent with -l so tmux
   * doesn't interpret them.
   */
  sendRawKeys(script: string, opts?: { literal?: boolean }): { ok: boolean; segments: number; error?: string } {
    // Literal mode: type the string verbatim, no token parsing — so
    // "git commit<Enter>" lands as those exact characters instead of a
    // command + keypress. Used by the pane's plain-text input toggle.
    if (opts?.literal) {
      const ok = run("tmux", "send-keys", "-l", "-t", this.tmuxWindow, "--", script).ok;
      return ok ? { ok: true, segments: 1 } : { ok: false, segments: 1, error: "tmux send-keys failed" };
    }
    // parse the token language → tmux key-name / literal segments (toTmux
    // already groups consecutive named keys and coalesces literal runs, so each
    // segment is exactly one send-keys call).
    let segments;
    try {
      segments = toTmuxSegments(script);
    } catch (e) {
      if (e instanceof ParseError || e instanceof TmuxKeyError) {
        return { ok: false, segments: 0, error: e.message };
      }
      throw e;
    }
    for (const seg of segments) {
      const ok = seg.type === "keys"
        ? run("tmux", "send-keys", "-t", this.tmuxWindow, ...seg.names).ok
        : run("tmux", "send-keys", "-l", "-t", this.tmuxWindow, "--", seg.text).ok;
      if (!ok) return { ok: false, segments: segments.length, error: "tmux send-keys failed" };
    }
    return { ok: true, segments: segments.length };
  }

  pane(color = false): { ok: true; text: string } {
    // -e includes ANSI SGR escape sequences (colors, bold, …) so the app can
    // render the TUI in color; without it the capture is plain text.
    const args = color
      ? ["capture-pane", "-p", "-e", "-t", this.tmuxWindow]
      : ["capture-pane", "-p", "-t", this.tmuxWindow];
    return { ok: true, text: run("tmux", ...args).out };
  }

  /**
   * Resize the tmux window. tmux's resize-window auto-switches the window to
   * window-size=manual, so the size sticks (the session is detached — the app
   * is the only "viewer"). A real terminal attaching reclaims via the global
   * client-attached hook (window-size latest), giving "last connector drives
   * the width". cols/rows are clamped to sane terminal bounds.
   */
  resize(cols: number, rows: number): { ok: boolean } {
    const c = Math.max(20, Math.min(500, Math.floor(cols)));
    const r = Math.max(10, Math.min(200, Math.floor(rows)));
    if (!Number.isFinite(c) || !Number.isFinite(r)) return { ok: false };
    return { ok: run("tmux", "resize-window", "-t", this.tmuxWindow, "-x", String(c), "-y", String(r)).ok };
  }

  transcript(): { lines: unknown[] } {
    if (!this.transcriptPath || !existsSync(this.transcriptPath)) return { lines: [] };
    const lines = readFileSync(this.transcriptPath, "utf-8").split("\n")
      .filter((l) => l.trim())
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
    return { lines };
  }

  // ── Relay message handling ──────────────────────────────────────────────────

  async #onRelayMessage(text: string, seq: number): Promise<void> {
    // An ended session keeps its relay attached only to serve file/git RPCs on
    // its directory. Its pane is a dead-Claude shell, so typing a relayed
    // message there would run it as a shell command — drop it instead. (To
    // continue an ended session, the app uses the explicit restart/resume flow.)
    if (this.status === "ended") {
      process.stderr.write(`[relay] ${this.id}: ignoring message for ended session\n`);
      return;
    }
    // Drain attachments first so paths can be appended to this turn's text.
    // Atomic swap: take the bucket, replace with an empty one so any
    // late-arriving file event lands in the next batch (matches happy-cli's
    // drainAttachmentsForUserMessage swap-then-await order).
    const drained = this.#pendingAttachments;
    this.#pendingAttachments = [];
    let augmented = text;
    if (drained.length > 0) {
      const results = await Promise.all(drained);
      const paths: string[] = [];
      for (const bytes of results) {
        if (!bytes) continue;
        const refPath = writeAttachmentToCwd(this.cwd, bytes);
        if (refPath) paths.push(refPath);
      }
      if (paths.length > 0) {
        // Bare relative paths appended after the text, space-separated.
        // tmux send-keys -l + Enter sends a single line, so line breaks
        // can't be preserved. Claude resolves them against the session cwd
        // and reads each file as an image.
        augmented = text + " " + paths.join(" ");
      }
    }
    // mirrorToRelay: false — the message came FROM the relay; the app already
    // has it in the chat history.
    this.sendText(augmented, { seq, source: "relay", mirrorToRelay: false });
  }

  /**
   * Emit a standalone agent-side note (e.g. slash-command output) as a
   * response. Wraps it in a transient turn when none is open so the app
   * renders it left-aligned like Claude's replies, not as an outbound message.
   */
  #emitAgentNote(text: string, timeMs: number, sid?: string): void {
    if (this.#relay) {
      const opened = !this.#turn;
      if (opened) {
        this.#turn = { turnId: crypto.randomUUID() };
        this.#relay.send(encodeTurnStart({ turn: this.#turn.turnId, time: timeMs }));
      }
      this.#relay.send(encodeTextEvent(text, { turn: this.#turn!.turnId, time: timeMs }));
      if (opened) {
        this.#relay.send(encodeTurnEnd("completed", { turn: this.#turn!.turnId, time: timeMs }));
        this.#turn = null;
      }
    }
    this.#deps.addChatMessage({ role: "assistant", content: text, source: "cli", session_id: sid });
  }

  // ── 500-error auto-retry ──────────────────────────────────────────────────────

  /**
   * Schedule the next auto-retry after a 5xx-exhausted turn. Walks
   * RETRY_SCHEDULE_SEC by attempt count; when it runs out, gives up. Publishes
   * the retry banner (updateRetry) and an agent note with the countdown.
   */
  #scheduleRetry(status: number, sid?: string): void {
    const made = this.#retry?.attempts ?? 0;
    if (made >= RETRY_SCHEDULE_SEC.length) {
      this.#emitAgentNote(`⚠️ API ${status}: auto-retry exhausted after ${RETRY_SCHEDULE_SEC.length} attempts — giving up`, Date.now(), sid);
      this.#clearRetry();
      return;
    }
    const delaySec = RETRY_SCHEDULE_SEC[made];
    const attempt = made + 1;
    const nextAt = Date.now() + delaySec * 1000;
    if (this.#retry?.timer) clearTimeout(this.#retry.timer);
    this.#retry = { attempts: attempt, timer: setTimeout(() => this.#fireRetry(sid), delaySec * 1000) };
    void this.#relay?.updateRetry({ attempt, total: RETRY_SCHEDULE_SEC.length, nextAt, status });
    this.#emitAgentNote(`⏳ API ${status} — retrying in ${formatRetryDelay(delaySec)} (attempt ${attempt}/${RETRY_SCHEDULE_SEC.length})`, Date.now(), sid);
  }

  /** Fire a scheduled retry: re-send the failed prompt through the queue. */
  #fireRetry(sid?: string): void {
    if (!this.#retry) return;
    this.#retry.timer = null;
    const text = this.#lastUserText;
    if (!text) {
      this.#emitAgentNote(`⚠️ Auto-retry: no prompt to re-send — giving up`, Date.now(), sid);
      this.#clearRetry();
      return;
    }
    // Re-send via the queue so it waits for the ready prompt, types, and a fresh
    // turn confirms it landed. If that turn 5xx-fails again, #turn5xxStatus is
    // re-armed and the turn-end handler calls #scheduleRetry for the next step.
    this.enqueue(text);
  }

  /** Tear down any pending retry (timer + banner). */
  #clearRetry(): void {
    if (this.#retry?.timer) clearTimeout(this.#retry.timer);
    this.#retry = null;
    void this.#relay?.updateRetry(null);
  }

  #ensureDelivery(): DeliveryState | null {
    if (!this.relaySessionId) return null;
    if (!this.#delivery) this.#delivery = initDeliveryState(this.relaySessionId);
    return this.#delivery;
  }

  /** Type a message into the pane + record receipt + bump thinking. */
  #typeIntoTmux(text: string, opts: SendOptions): void {
    const delivery = this.#ensureDelivery();
    // Commands (`!bash`, `/slash`) never produce a user-text transcript entry —
    // their synthetic wrappers are suppressed — so they must NOT go on the
    // pending-match queue, where they'd never match and would block the next
    // real message's match, mirroring it as a duplicate.
    const isCommand = /^\s*!/.test(text) || /^\/[a-zA-Z][\w:-]*(?:\s|$)/.test(text);
    const tracked = !!delivery && !isCommand;
    // send-keys can't type newlines, so a multi-line message is typed (and
    // recorded by Claude in its transcript) with newlines collapsed to spaces.
    // Track THIS form for dedup so the transcript echo matches — otherwise a
    // multi-line message's echo fails to match the original and gets mirrored
    // as a duplicate. The relay mirror still uses the original (with newlines)
    // so the app shows the message as the user typed it.
    const typed = text.replace(/\n/g, " ");
    if (tracked) {
      delivery!.pending.push({ seq: opts.seq, text: typed, source: opts.source, at: Date.now() });
      // Persisted backstop: remember we sent this text so its transcript echo is
      // never mirrored as a duplicate, even if the pending queue is lost to a
      // restart.
      recordReceived(delivery!, this.relaySessionId!, typed, Date.now());
    }
    const r = run("tmux", "send-keys", "-l", "-t", this.tmuxWindow, "--", typed);
    if (!r.ok) {
      if (tracked) delivery!.pending.pop();
      throw new Error("tmux send-keys failed");
    }
    run("tmux", "send-keys", "-t", this.tmuxWindow, "Enter");
    if (opts.mirrorToRelay) {
      this.#relay?.send(encodeUserMessage(text));
    }
    this.#setThinking(true);
    if (!this.#tailer && this.status !== "ended") this.pollForTranscript();
  }

  #flushPrelaunch(): void {
    const buffered = this.#prelaunchBuffer;
    this.#prelaunchBuffer = [];
    for (const m of buffered) {
      try {
        this.#typeIntoTmux(m.text, m);
      } catch (e) {
        process.stderr.write(`[prelaunch] flush failed for ${this.id}: ${e}\n`);
      }
    }
  }

  /**
   * Resolve the chicken-and-egg of a brand-new project directory: the
   * transcript JSONL only appears after Claude receives its first message,
   * but buffered messages only flushed on the first transcript entry — so a
   * fresh session would deadlock in 'starting' forever. Poll the pane for
   * Claude's ready input prompt and flush the buffer the moment it shows.
   * Transcript-entry activation remains the authoritative status flip.
   */
  #pollPromptReady(): void {
    if (this.#promptPollActive) return;
    this.#promptPollActive = true;
    const tick = () => {
      if (this.status === "ended" || this.#prelaunchBuffer.length === 0) {
        this.#promptPollActive = false;
        return;
      }
      if (this.status === "active") {
        // Transcript entry beat us to it — its activation already flushed.
        this.#promptPollActive = false;
        this.#flushPrelaunch();
        return;
      }
      const pane = run("tmux", "capture-pane", "-p", "-t", this.tmuxWindow);
      if (pane.ok && paneShowsReadyPrompt(pane.out)) {
        this.#promptPollActive = false;
        this.#flushPrelaunch();
        return;
      }
      setTimeout(tick, 700);
    };
    setTimeout(tick, 700);
  }

  // ── Transcript watching ─────────────────────────────────────────────────────

  // M4: 120 attempts × 500ms = 60s window, enough for slow first-runs
  // (trust prompts etc.)
  pollForTranscript(attempts = 0): void {
    if (this.#tailer || this.status === "ended") return;
    // A pinned transcript (e.g. the --resume target) is tailed directly — its
    // full history replays from byte 0, regardless of mtime. Falls through to
    // mtime-based discovery for fresh sessions.
    if (this.transcriptPath && existsSync(this.transcriptPath)) {
      this.startTailer(this.transcriptPath);
      return;
    }
    const path = findLatestTranscript(cwdToTranscriptDir(this.cwd), this.startedAt);
    if (path) {
      this.startTailer(path);
      return;
    }
    if (attempts < 120) {
      setTimeout(() => this.pollForTranscript(attempts + 1), 500);
    } else {
      process.stderr.write(`[transcript] WARN: no transcript found for ${this.id} after 60s — assistant output will not reach the relay\n`);
    }
  }

  /**
   * Attach (or with force=true, re-attach) the JSONL tailer. force is the
   * seam for the future /branch//fork/--resume handling, where Claude rotates
   * its session id and starts writing a new transcript file.
   */
  startTailer(transcriptPath: string, force = false): void {
    if (this.#tailer) {
      if (!force) return;
      this.#tailer.close();
      this.#tailer = null;
    }
    this.transcriptPath = transcriptPath;
    this.#tailer = tailJsonl(
      transcriptPath,
      (entry) => {
        this.onTranscriptEntry(entry);
        this.#deps.broadcast("transcript_entry", { session_id: this.claudeSessionId, entry });
      },
      () => this.status !== "ended",
      this.#transcriptStartOffset,
    );
  }

  /** PID-death detection: poll every 5s; on exit, run the full teardown. */
  #pollEnd(): void {
    if (this.status === "ended") return;
    if (this.pid !== undefined && !run("kill", "-0", String(this.pid)).ok) {
      this.end("process_exited");
      return;
    }
    setTimeout(() => this.#pollEnd(), 5000);
  }

  /** Single funnel for the app's "thinking" status — tracks the last value and
   *  pushes it to the relay. Lifecycle transitions (send/end_turn/abort) call
   *  this directly; the pane poll change-gates itself before calling. */
  #setThinking(thinking: boolean): void {
    this.#thinking = thinking;
    this.#relay?.setThinking(thinking);
  }

  /** Reconcile "thinking" from the live pane every 3s — the pane is the ground
   *  truth: the "esc to interrupt" line shows iff Claude is actively generating.
   *  This corrects the event-driven setters for the cases they miss: typing
   *  directly in the pane, stops at an interactive prompt (no end_turn), and
   *  interrupts. Runs only while a relay is attached and the session is live. */
  #pollThinking(): void {
    if (this.status === "ended") return;
    if (this.#relay) {
      const pane = run("tmux", "capture-pane", "-p", "-t", this.tmuxWindow);
      if (pane.ok) {
        const working = paneShowsWorking(pane.out);
        if (working !== this.#thinking) this.#setThinking(working); // only on change
      }
    }
    setTimeout(() => this.#pollThinking(), 3000);
  }

  // ── Transcript entry semantics ──────────────────────────────────────────────

  onTranscriptEntry(entry: Record<string, unknown>): void {
    const entryType = String(entry.type || "");

    // First entry activates the session — Claude is now reading the pane,
    // so flush any messages buffered during boot.
    if (this.status === "starting") {
      const sid = String(entry.sessionId || "");
      if (sid) {
        this.claudeSessionId = sid;
        this.status = "active";
        this.lastActiveAt = Date.now();
        this.#deps.broadcast("session_update", this.toJSON());
        this.#flushPrelaunch();
      }
    }

    const sid = this.claudeSessionId;

    // Claude generates a conversation title and writes it as an `ai-title`
    // entry. Push it into the relay session summary so the app shows the real
    // title instead of "New Chat".
    if (entryType === "ai-title") {
      const title = typeof entry.aiTitle === "string" ? entry.aiTitle.trim() : "";
      if (title) {
        this.summary = title;
        void this.#relay?.updateSummary(title);
        this.#deps.broadcast("session_update", this.toJSON());
      }
      return;
    }

    // Every mirrored message is stamped with Claude's own transcript
    // timestamp (one clock for both user and agent messages), so a --resume
    // replay sorts in true chronological order in the app instead of
    // splitting into "all agent, then all user" from daemon/relay clock skew.
    // Falls back to now() for entries without a parseable timestamp.
    const entryTimeMs = Date.parse(String(entry.timestamp || "")) || Date.now();

    // Turn complete → send turn-end and clear turn state. Either the Stop hook
    // ran (stop_hook_summary) or Claude reported the turn's wall-clock
    // (turn_duration). turn_duration fires at the end of EVERY turn, including
    // ones that ended in an API error — whose assistant entry carries no
    // end_turn stop_reason, so the assistant-path turn-end below never fires.
    // Handling it here is what unsticks `thinking` when a turn errors out.
    if (entryType === "system" && (entry.subtype === "stop_hook_summary" || entry.subtype === "turn_duration")) {
      this.#errorNotedThisTurn = false;
      this.#deps.broadcast("stop", { session_id: sid });
      if (this.#relay && this.#turn) {
        this.#relay.send(encodeTurnEnd("completed", { turn: this.#turn.turnId, time: entryTimeMs }));
      }
      this.#turn = null;
      this.#setThinking(false);
      // 500-error auto-retry: if Claude exhausted its own retries on a 5xx this
      // turn, re-send on the backoff schedule. A turn that ended cleanly while a
      // retry was pending means the re-send worked → clear it.
      if (this.#turn5xxStatus != null) {
        const status = this.#turn5xxStatus;
        this.#turn5xxStatus = null;
        this.#scheduleRetry(status, sid);
        return; // hold the queue — the retry owns the next dispatch
      }
      if (this.#retry) this.#clearRetry();
      this.#maybeDrainQueue(); // turn done → send the next queued message
      return;
    }

    // API error (401, rate limit, network, …). Claude retries up to maxRetries,
    // so this isn't a turn end (turn_duration handles that) — but it IS normally
    // invisible: nothing reaches the app and the spinner just hangs. Log every
    // one for diagnosis, and surface the first per turn as an agent note so the
    // app shows e.g. "API error: 401 Invalid authentication credentials".
    if (entryType === "system" && entry.subtype === "api_error") {
      const err = (entry.error ?? {}) as Record<string, unknown>;
      const formatted = typeof err.formatted === "string" && err.formatted
        ? err.formatted
        : typeof err.message === "string" ? err.message : "API error";
      process.stderr.write(`[api_error] ${this.id} status=${err.status ?? "?"} retry=${entry.retryAttempt ?? "?"}/${entry.maxRetries ?? "?"}: ${formatted}\n`);
      if (!this.#errorNotedThisTurn) {
        this.#errorNotedThisTurn = true;
        this.#emitAgentNote(`⚠️ API error: ${formatted}`, entryTimeMs, sid);
      }
      // Mark the turn as carrying an unresolved server error. Claude retries 5xx
      // internally; if it recovers, the assistant-output path clears this. If the
      // turn ENDS with it still set, Claude gave up → the turn-end handler starts
      // our backoff retry. (Keyed on a trailing 5xx, not on hitting maxRetries:
      // observed 529s recover by attempt ~8/10, so they never reach the ceiling.)
      const status = Number(err.status);
      if (status >= 500) this.#turn5xxStatus = status;
      return;
    }

    if (entryType !== "user" && entryType !== "assistant") return;

    const msg = entry.message as Record<string, unknown> | undefined;
    if (!msg) return;

    const role = String(msg.role || "");
    const content = msg.content;

    if (role === "user") {
      if (entry.isMeta) return;
      if (typeof content !== "string") {
        // Emit tool-call-end events for tool results
        if (this.#relay && this.#turn && Array.isArray(content)) {
          for (const item of content as Array<Record<string, unknown>>) {
            if (item.type === "tool_result" && typeof item.tool_use_id === "string") {
              this.#relay.send(encodeToolCallEnd(item.tool_use_id, { turn: this.#turn.turnId, time: entryTimeMs }));
            }
          }
        }
        return;
      }
      // Command/bash machinery from the CLI generates a flood of synthetic
      // user entries. The user's typed command already reaches the relay as
      // their own message (so it shows as a plain outbound message — no chip),
      // so here we only:
      //  - surface slash-command OUTPUT (<local-command-stdout>) as an agent
      //    RESPONSE (it's the result, not something the user sent);
      //  - SUPPRESS everything else — the <command-*> wrapper (would render a
      //    chip), the raw transcript echo (duplicate), bash blocks, caveats.
      if (content.startsWith("<local-command-stdout>")) {
        const m = /<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/.exec(content);
        const out = m ? stripAnsi(m[1]).trim() : "";
        if (out) this.#emitAgentNote(out, entryTimeMs, sid);
        return;
      }
      // `!cmd`: capture the command from <bash-input> (to head the output card)
      // and suppress its echo — the user's typed `! cmd` already shows.
      if (content.startsWith("<bash-input>")) {
        const m = /<bash-input>([\s\S]*?)<\/bash-input>/.exec(content);
        this.#pendingBashCmd = m ? stripAnsi(m[1]).trim() : "";
        return;
      }
      // Bash output (`!cmd`) → a structured card the app renders as a tool call:
      // command in the header, stdout/stderr in the body. Parts are base64'd so
      // arbitrary output can't break the block. Terminal escape codes stripped.
      if (content.startsWith("<bash-stdout>") || content.startsWith("<bash-stderr>")) {
        const so = /<bash-stdout>([\s\S]*?)<\/bash-stdout>/.exec(content);
        const se = /<bash-stderr>([\s\S]*?)<\/bash-stderr>/.exec(content);
        const stdout = so ? stripAnsi(so[1]).replace(/\s+$/, "") : "";
        const stderr = se ? stripAnsi(se[1]).replace(/\s+$/, "") : "";
        const cmd = this.#pendingBashCmd ?? "";
        this.#pendingBashCmd = undefined;
        const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
        this.#emitAgentNote(`<bash-run><cmd>${b64(cmd)}</cmd><stdout>${b64(stdout)}</stdout><stderr>${b64(stderr)}</stderr></bash-run>`, entryTimeMs, sid);
        return;
      }
      if (content.startsWith("<command-name>") ||
          content.startsWith("<command-message>") ||
          content.startsWith("<local-command") ||
          content.startsWith("<bash-")) {
        return;
      }

      // Match this transcript entry against the front of the pending-send
      // queue. Identical messages are matched sequentially: two "yes" sends
      // pair with two "yes" transcript entries in order.
      const uuid = typeof entry.uuid === "string" ? entry.uuid : "";
      const delivery = this.#relay && uuid ? this.#ensureDelivery() : null;
      if (delivery && this.relaySessionId) {
        // Match anywhere in the queue (not just the front) so an out-of-order or
        // stale entry can't block a real match.
        const idx = delivery.pending.findIndex((p) => p.text === content);
        if (idx >= 0) {
          const matched = delivery.pending.splice(idx, 1)[0];
          recordInboundReceipt(delivery, this.relaySessionId, {
            seq: matched.seq, uuid, text: content, source: matched.source, at: Date.now(),
          });
          // #typeIntoTmux records BOTH a pending entry and a persisted `received`
          // backstop. Now that pending matched, drop the backstop twin too — else
          // it dangles for 15 min and a later identical message typed directly in
          // the pane finds no pending match, hits this stale `received`, and gets
          // wrongly swallowed (the app's history loses a real "yes"/"continue").
          consumeReceived(delivery, this.relaySessionId, content, Date.now());
          // codex-4: record the prompt for 5xx auto-retry BEFORE returning —
          // app/queue/RPC sends match here and used to skip the #lastUserText
          // assignment below, so #fireRetry had nothing to re-send.
          this.#lastUserText = content;
          // codex-3: the echo proves the dispatched prompt landed. Confirm it now
          // instead of waiting for assistant output — a turn that errors before any
          // output (api_error → turn_duration with no assistant blocks) would
          // otherwise leave #dispatchInFlight set until the 20s timeout requeues +
          // pauses an already-delivered message.
          if (this.#dispatchInFlight &&
              (this.#dispatchInFlight.text === content ||
               this.#dispatchInFlight.text.replace(/\n/g, " ") === content)) {
            this.#confirmDispatchIfAwaiting();
          }
          return; // self-echo of a relay/HTTP/RPC send — don't double-record locally
        }
        // No queue match. Before assuming this was typed directly in the pane,
        // check the PERSISTED received-text backstop: if the app sent this text
        // recently, the pending match was just lost (e.g. a daemon restart) —
        // suppress it instead of mirroring a duplicate.
        if (!delivery.forwardedUuids.has(uuid)) {
          if (consumeReceived(delivery, this.relaySessionId, content, Date.now())) {
            recordInboundReceipt(delivery, this.relaySessionId, {
              uuid, text: content, source: "relay", at: Date.now(),
            });
          } else {
            this.#relay!.send(encodeUserMessage(content, entryTimeMs));
            recordOutboundReceipt(delivery, this.relaySessionId, { uuid, turn: "", at: Date.now() });
          }
        }
      }
      this.#lastUserText = content; // the prompt to re-send if this turn 5xx-fails
      this.#deps.addChatMessage({ role: "user", content, source: "cli", session_id: sid });

    } else if (role === "assistant") {
      if (typeof msg.model === "string" && msg.model) {
        if (this.currentModel !== msg.model) {
          this.currentModel = msg.model;
          if (this.#relay) {
            this.#relay.updateModelCode(msg.model).catch(() => {});
          }
        }
      }
      const blocks = Array.isArray(content) ? content as Array<Record<string, unknown>> : [];
      // Claude produced output → it recovered from any mid-turn 5xx, so this turn
      // won't trigger an auto-retry.
      if (blocks.length > 0) this.#turn5xxStatus = null;
      const entryUuid = typeof entry.uuid === "string" ? entry.uuid : "";
      // Skip if we've already forwarded this transcript entry (recovery case).
      if (this.#relay && entryUuid) {
        const delivery = this.#ensureDelivery();
        if (delivery?.forwardedUuids.has(entryUuid)) return;
      }
      if (this.#relay && blocks.length > 0) {
        // Ensure a turn is open; send turn-start on the first assistant entry per turn
        if (!this.#turn) {
          this.#turn = { turnId: crypto.randomUUID() };
          this.#relay.send(encodeTurnStart({ turn: this.#turn.turnId, time: entryTimeMs }));
          // A fresh turn starting is the proof a dispatched queue message
          // landed — Claude is now responding to it.
          this.#confirmDispatchIfAwaiting();
        }
        const opts = { turn: this.#turn.turnId, claudeUuid: entryUuid || undefined, time: entryTimeMs };
        for (const block of blocks) {
          const blockType = String(block.type || "");
          if (blockType === "text") {
            const text = String(block.text || "").trim();
            if (text) this.#relay.send(encodeTextEvent(text, opts));
          } else if (blockType === "tool_use") {
            this.#relay.send(encodeToolCallStart({
              call: String(block.id || crypto.randomUUID()),
              name: String(block.name || "tool"),
              input: block.input,
              ...opts,
            }));
          }
        }
        // Record outbound receipt — we forwarded this transcript entry to the relay.
        const delivery = this.#ensureDelivery();
        if (entryUuid && delivery && this.relaySessionId) {
          recordOutboundReceipt(delivery, this.relaySessionId, {
            uuid: entryUuid, turn: this.#turn.turnId, at: Date.now(),
          });
        }
        // M3: send turn-end when the assistant finishes — don't require a
        // Stop hook. end_turn = normal completion; tool_use = more tool
        // calls pending (no turn-end yet).
        const stopReason = String(msg.stop_reason || "");
        if (stopReason === "end_turn" || stopReason === "max_tokens") {
          this.#errorNotedThisTurn = false;
          this.#relay.send(encodeTurnEnd("completed", { turn: this.#turn.turnId, time: entryTimeMs }));
          this.#turn = null;
          this.#setThinking(false);
          this.#deps.broadcast("stop", { session_id: sid });
          this.#maybeDrainQueue(); // turn done → send the next queued message
        }
      }
      for (const block of blocks) {
        const blockType = String(block.type || "");
        if (blockType === "text") {
          const text = String(block.text || "").trim();
          if (text) this.#deps.addChatMessage({ role: "assistant", content: text, source: "cli", session_id: sid });
        } else if (blockType === "tool_use") {
          const name = String(block.name || "tool");
          const detail = summarizeInput(block.input);
          this.#deps.addChatMessage({
            role: "event",
            content: detail ? `▶ ${name}: ${detail}` : `▶ ${name}`,
            source: "cli",
            event_type: "tool_use",
            event_status: "info",
            session_id: sid,
          });
        }
      }
    }
  }
}

/**
 * True when the pane shows Claude's interactive input prompt: a line whose
 * trimmed content starts with "❯" — EXCLUDING selector dialogs (folder-trust
 * prompt, /model picker, etc.) which render options as "❯ 1. Yes, …".
 * Ghost-text suggestions like `❯ Try "refactor <filepath>"` count as ready.
 */
export function paneShowsReadyPrompt(text: string): boolean {
  return text.split("\n").some(line => {
    const t = line.trim();
    if (!t.startsWith("❯")) return false;
    return !/^❯\s*\d+\./.test(t);
  });
}

/**
 * True when the pane shows ANY sign Claude's TUI is up and running — broader
 * than paneShowsReadyPrompt: the ready input box, a selector/trust dialog, the
 * mode footer, or the "esc to interrupt" working line all count. Used by the
 * startup watchdog to tell "Claude is alive" from "it exited back to the shell"
 * (a plain shell prompt matches none of these). Exported for tests.
 */
export function paneShowsClaudeRunning(text: string): boolean {
  if (paneShowsReadyPrompt(text)) return true;
  return /Yes, I trust this folder|Is this a project you (created|trust)|esc to interrupt|\? for shortcuts|shift\+tab to cycle|⏵⏵|⏸/i.test(text);
}

/**
 * True when Claude is ACTIVELY generating — narrower than paneShowsClaudeRunning.
 * Claude prints the "esc to interrupt" hint only while a turn is in flight (text
 * generation or a running tool); it's absent at the idle ready prompt and at any
 * input prompt (picker/trust/permission). This is the ground truth the daemon
 * uses to report the app's "thinking" status, so blue/green tracks the window.
 */
export function paneShowsWorking(text: string): boolean {
  return /esc to interrupt/i.test(text);
}

/** Human-readable backoff delay for retry notes: "15s", "2m". Exported for tests. */
export function formatRetryDelay(sec: number): string {
  return sec < 60 ? `${sec}s` : `${Math.round(sec / 60)}m`;
}

/** Footer → permission mode. Exported for tests. */
export function parsePermissionModeFromPane(text: string): string {
  if (/bypass permissions on/i.test(text)) return "bypassPermissions";
  if (/auto mode on/i.test(text)) return "auto";
  if (/accept edits on/i.test(text)) return "acceptEdits";
  if (/plan mode on/i.test(text)) return "plan";
  return "default"; // no marker line in default mode
}

function summarizeInput(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const inp = input as Record<string, unknown>;
  if (typeof inp.command === "string") return inp.command.split("\n")[0].slice(0, 70);
  if (typeof inp.file_path === "string") return inp.file_path;
  if (typeof inp.pattern === "string") return inp.pattern;
  return JSON.stringify(input).slice(0, 70);
}
