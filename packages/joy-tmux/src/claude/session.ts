// Session: one Claude Code instance running in a tmux window, bridged to the
// Happy relay. Owns ALL per-session state that used to be scattered across
// eight parallel Maps in server.ts (relay session, transcript watcher, turn
// state, delivery receipts, pending attachments).
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
import { tmux } from "../tmux/driver";
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
import { saveWindowRecord } from "../domain/windowRecord";
import { cwdToTranscriptDir, findLatestTranscript, tailJsonl, type TranscriptTailer } from "./transcript";
import { toTmuxSegments, ParseError, TmuxKeyError } from "../tmux/keyTokens";

export type SessionStatus = "starting" | "active" | "ended";

// Startup watchdog cadence. If Claude shows no sign of life within the deadline
// (it exited at launch — bad --continue/--resume, crash, missing binary), the
// session is ended as process_exited so it surfaces as detached, not stuck.
const STARTUP_POLL_MS = 700;
const STARTUP_DEADLINE_ATTEMPTS = 30; // ~21s — long enough for cold start / --resume

// Delay between typing a message and the Enter that submits it. send-keys -l
// types the whole message as one fast burst, which claude's TUI treats as a
// PASTE; an Enter that lands inside claude's paste-detection window is absorbed
// as a literal newline instead of submitting, leaving the message stuck unsent
// in the box (the "typed but not submitted" bug). This delay lets paste-detection
// settle so Enter submits cleanly. (verified live: back-to-back does NOT submit a
// long message; +~350ms does.) A genuine non-submit is caught by the dispatch
// timeout (requeue + pause), not a blind re-Enter.
const ENTER_SUBMIT_DELAY_MS = 350;

// After an abort (Escape interrupts the turn), wait this long before clearing any
// text left in the input box. Escape does NOT clear the box (verified live) — e.g.
// text the user typed while Claude was generating stays put — so we follow up with
// a guarded C-c once the interrupt has settled and the ready prompt has repainted
// (paneInputText needs the box drawn to read it). Cancelled if a new send starts.
const ABORT_CLEAR_DELAY_MS = 400;
// After the C-u clear, wait this long before typing a MULTI-LINE message. The C-j
// burst trips Claude's paste-detection, which otherwise captures the just-sent C-u
// (\x15) into the pasted content — corrupting the message + breaking dedup. The delay
// lets the kill-line be processed first. Single-line sends skip it (no paste trigger).
const CLEAR_SETTLE_MS = 120;

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
  /** Conversation title (Claude's ai-title or a manual /title), aka the relay summary. */
  summary?: string;
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

/** Slash commands joy handles itself, before the text reaches Claude (`/steer`, `/title`). */
const JOY_COMMANDS = new Set(["steer", "title"]);

/**
 * Parse a joy-owned slash command the daemon intercepts BEFORE the text reaches Claude:
 * `/<name> <args>`. Only the names in JOY_COMMANDS are ours — every OTHER slash command
 * (`/compact`, project commands, …) returns null and passes straight through to Claude
 * untouched. Returns the lowercased name + remaining args, or null.
 */
export function parseJoyCommand(text: string): { name: string; args: string } | null {
  const m = /^\/([a-zA-Z][\w-]*)[ \t]*([\s\S]*)$/.exec(text);
  if (!m) return null;
  const name = m[1].toLowerCase();
  return JOY_COMMANDS.has(name) ? { name, args: m[2] } : null;
}

/**
 * Collapse any newline form to a single space — the canonical form for DEDUP matching.
 * We type real newlines into the pane (one C-j per line break, see #typeLines), so
 * Claude echoes a multi-line user message in its transcript; we record + compare the
 * flattened form on BOTH sides so that echo still matches our send and isn't mirrored
 * as a duplicate. (The relay mirror always uses the original, newlines intact.)
 */
export function flattenForMatch(text: string): string {
  return text.replace(/\r\n|\r|\n/g, " ");
}

/** Slim wire shape pushed to the app (joy__queue) and returned by queue ops. */
export interface QueuedMessage {
  id: string;
  text: string;
  createdAt: number;
}

/** Why auto-drain is currently halted — surfaced to the app for a precise banner. */
export type QueuePauseReason = "input_dirty" | "dispatch_timeout" | "dispatch_mismatch" | "dispatch_failed";

/**
 * Internal queue item. Carries the dispatch options so EVERY app→Claude path
 * (relay app-send, HTTP/RPC /send, explicit queue-add, 5xx auto-retry) funnels
 * through the one verified dispatch queue with its original semantics intact.
 * `visible` controls whether it shows as an editable chip in joy__queue:
 * relay/`/send`/retry items already have (or will get) a chat bubble, so they
 * stay hidden — only an explicit queue-add is a visible, editable chip.
 */
export interface QueuedItem extends QueuedMessage {
  source: DeliverySource;
  mirrorToRelay: boolean;
  seq?: number;
  visible: boolean;
}

export interface QueueState {
  queue: QueuedMessage[];
  /** Text of the (visible) message dispatched but not yet confirmed, or null. */
  inFlight: string | null;
  /** True when auto-drain is halted after a failed dispatch / dirty input. */
  paused: boolean;
  /** When paused, why — lets the app distinguish "junk in the box" from a timeout. */
  pauseReason?: QueuePauseReason;
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
  // tool_use_id → turnId for tools whose start was forwarded but whose end hasn't
  // been seen. Lets us emit tool-call-end even after #turn is nulled, and
  // synthesize ends for tools left open by an abort/turn-close/teardown — else
  // the app's tool card spins "running" forever (no matching tool-result).
  #openTools = new Map<string, string>();
  // The latest token-usage object seen on an assistant entry this turn (Claude
  // reports cumulative usage per message). Attached to the turn-end event so the
  // app shows real tokens/cost; reset at turn-start.
  #turnUsage: Record<string, unknown> | null = null;
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
  // joy: Claude is compacting its context (the PreCompact hook fired). Surfaced
  // as a "compacting" status; cleared by the compact_boundary transcript record
  // or, as a backstop, by #compactingTimer — a boundary we never see (e.g. the
  // session died mid-compaction) would otherwise leave the banner stuck.
  #compacting: { trigger: string; since: number } | null = null;
  #compactingTimer: ReturnType<typeof setTimeout> | null = null;
  // Byte offset the tailer starts at — non-zero only for a capped --resume
  // backfill (snapped to a turn boundary so we don't replay a partial turn).
  #transcriptStartOffset = 0;
  #delivery: DeliveryState | null = null;
  #pendingAttachments: Promise<Uint8Array | null>[] = [];
  // The most recent `!cmd` command, captured from <bash-input> so it can head
  // the bash-output card.
  #pendingBashCmd?: string;
  #trustHandled = false;

  // ── Message queue ──────────────────────────────────────────────────────────
  // The ONE verified dispatch queue. EVERY app→Claude text — relay app-send,
  // HTTP/RPC /send, explicit queue-add, 5xx auto-retry — funnels through here so
  // nothing types into the pane until Claude is genuinely idle AND the input box
  // is empty. Visible (user-queued) items stay editable until dispatched; hidden
  // (relay/send/retry) items just serialize. The queue never contains the
  // in-flight message — edit/cancel/reorder are plain array ops.
  #queue: QueuedItem[] = [];
  // The message typed-but-not-yet-confirmed. Treated as busy: nothing else
  // dispatches until Claude starts a turn in response (echo confirmation) or we
  // time out. Confirmed when the next turn-start fires; failed on timeout. Holds
  // the whole item so a timeout re-queues it with its original seq/source/opts.
  #dispatchInFlight: QueuedItem | null = null;
  #dispatchTimer: ReturnType<typeof setTimeout> | null = null;
  #drainRetry: ReturnType<typeof setTimeout> | null = null;
  // The pending delayed-Enter (submit) for a just-typed message. Cancellable so an
  // abort/kill/confirm/timeout in the settle window can't let a stale Enter fire
  // into the pane (re-submitting an aborted message, or submitting into a turn).
  #submitTimer: ReturnType<typeof setTimeout> | null = null;
  // Pending delayed clear of leftover input-box text after an abort (see
  // ABORT_CLEAR_DELAY_MS). Cancelled when a new send starts (so it can't C-c the
  // freshly-typed message) or on teardown.
  #abortClearTimer: ReturnType<typeof setTimeout> | null = null;
  // Pending delayed-Enter for a /steer send — separate from #submitTimer so steering
  // (which submits mid-turn) and the dispatch submit don't cancel each other.
  #steerSubmitTimer: ReturnType<typeof setTimeout> | null = null;
  // Count of clear-the-input attempts for the current drain: one guarded C-c, then
  // pause. Reset once the box is empty / on dispatch / when the pane isn't ready.
  #clearAttempts = 0;
  // Async drain pump (control-mode captures are awaited). #draining serializes one
  // drain at a time; #drainRequested re-runs once if a trigger (turn-end / enqueue)
  // arrives while a drain is mid-await, so it isn't dropped.
  #draining = false;
  #drainRequested = false;
  // Set when a dispatch failed to land (no turn started) or the input box is
  // dirty and unclearable — stops auto-draining so we don't shovel messages into
  // a wedged/odd state. Cleared by resume. #pauseReason says why (for the app).
  #queuePaused = false;
  #pauseReason: QueuePauseReason | undefined;

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
      summary: this.summary,
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
    const pane = tmux.captureCached(this.tmuxWindow);
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
    const pane = tmux.captureCached(this.tmuxWindow);
    if (pane.ok && /Yes, I trust this folder|Is this a project you (created|trust)/i.test(pane.out)) {
      // "1" selects "Yes, I trust this folder"; Enter confirms (harmless empty
      // submit if "1" already activated it).
      void tmux.key(this.tmuxWindow,"1", "Enter"); // fire-and-forget (sync watcher)
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
    // Same reconcile for the compacting banner: a daemon restart mid-compaction
    // rebuilds the Session with #compacting=null while joy__compacting persisted
    // server-side. The in-memory backstop timer is also gone, so without this the
    // banner could stick until the next compaction. (Idempotent — no-op if unset.)
    if (!this.#compacting) void rs.updateCompacting(null);
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
    this.#closeOpenTools(); // before the relay detaches below — don't strand tool spinners
    this.#turn = null;
    if (this.#retry?.timer) clearTimeout(this.#retry.timer);
    this.#retry = null;
    this.#turn5xxStatus = null;
    this.#delivery = null;
    if (this.#dispatchTimer) { clearTimeout(this.#dispatchTimer); this.#dispatchTimer = null; }
    if (this.#drainRetry) { clearTimeout(this.#drainRetry); this.#drainRetry = null; }
    this.#clearSubmitTimer();
    if (this.#abortClearTimer) { clearTimeout(this.#abortClearTimer); this.#abortClearTimer = null; }
    if (this.#steerSubmitTimer) { clearTimeout(this.#steerSubmitTimer); this.#steerSubmitTimer = null; }
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
      this.#clearCompacting();
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
      void tmux.command(["kill-window", "-t", this.tmuxWindow]); // teardown, fire-and-forget
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
    void tmux.command(["kill-window", "-t", this.tmuxWindow]); // teardown, fire-and-forget
    this.endReason = "killed";
    this.#deps.broadcast("session_update", this.toJSON());
    return true;
  }

  // ── Op verbs ────────────────────────────────────────────────────────────────

  /**
   * Compatibility shim. The ONE send path is now the verified dispatch queue
   * (#maybeDrainQueue): it serializes every app→Claude message behind any
   * in-flight turn and only types into an empty, ready box — so no caller can
   * inject straight into the pane and race a busy turn or stuck text (the
   * lost/merged-send bugs). This delegates to enqueue() with visible:false (a
   * direct sendText caller isn't an explicit, editable queue chip). It also
   * subsumes the old 'starting' buffering: the queue drains from 'starting' once
   * the pane shows an empty ready box (bootstrapping the first transcript).
   */
  sendText(text: string, opts: SendOptions): { buffered: boolean } {
    this.enqueue(text, { seq: opts.seq, source: opts.source, mirrorToRelay: opts.mirrorToRelay, visible: false });
    return { buffered: false };
  }

  // ── Message queue API ───────────────────────────────────────────────────────

  queueState(): QueueState {
    // Only VISIBLE items are user-facing chips. Hidden (relay/send/retry) items
    // already have a chat bubble, so showing them as editable chips would be a
    // duplicate with false edit/cancel semantics — they serialize silently.
    const visible = this.#queue.filter(q => q.visible);
    const inFlight = this.#dispatchInFlight?.visible ? this.#dispatchInFlight.text : null;
    return {
      queue: visible.map(q => ({ id: q.id, text: q.text, createdAt: q.createdAt })),
      inFlight,
      paused: this.#queuePaused,
      pauseReason: this.#queuePaused ? this.#pauseReason : undefined,
    };
  }

  /**
   * Add a message to the verified dispatch queue. opts default to an explicit,
   * visible queue-add (mirrored to the relay so it shows in chat). The other
   * callers override: relay app-sends pass {source:"relay",mirrorToRelay:false,
   * seq,visible:false} (the app already has the bubble); /send passes
   * {mirrorToRelay:true,visible:false}; 5xx retry passes {visible:false}.
   */
  enqueue(text: string, opts?: { source?: DeliverySource; mirrorToRelay?: boolean; seq?: number; visible?: boolean }): QueuedMessage {
    // Joy-owned commands are handled HERE — before the text is queued or reaches Claude.
    //   /steer <msg>  type <msg> straight into the pane and submit it now, BYPASSING the
    //                 queue + its idle gate, so it lands immediately (mid-turn if a turn
    //                 is running) instead of waiting behind the queue.
    //   /title <text> set the session's conversation title (the summary the app shows).
    // None are queued or sent to Claude; we return a synthetic record so queue-add
    // callers still get an id.
    const cmd = parseJoyCommand(text);
    if (cmd) {
      if (cmd.name === "steer" && cmd.args.trim()) {
        void this.#steer(cmd.args, {
          seq: opts?.seq,
          source: opts?.source ?? "rpc",
          mirrorToRelay: opts?.mirrorToRelay ?? true,
        });
      } else if (cmd.name === "title") {
        this.#setTitle(cmd.args);
      }
      return { id: crypto.randomUUID().slice(0, 8), text, createdAt: Date.now() };
    }
    const item: QueuedItem = {
      id: crypto.randomUUID().slice(0, 8),
      text,
      createdAt: Date.now(),
      source: opts?.source ?? "rpc",
      mirrorToRelay: opts?.mirrorToRelay ?? true,
      seq: opts?.seq,
      visible: opts?.visible ?? true,
    };
    this.#queue.push(item);
    this.#broadcastQueue();
    this.#maybeDrainQueue(); // drains immediately if Claude is idle
    return { id: item.id, text: item.text, createdAt: item.createdAt };
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

  /** Re-enable auto-drain after a paused (failed/dirty) dispatch. */
  resumeQueue(): void {
    this.#queuePaused = false;
    this.#pauseReason = undefined;
    this.#clearAttempts = 0;
    this.#broadcastQueue();
    this.#maybeDrainQueue();
  }

  /** Halt auto-drain and record why, so the app can show a precise banner. */
  #pauseDispatch(reason: QueuePauseReason): void {
    this.#queuePaused = true;
    this.#pauseReason = reason;
    this.#clearAttempts = 0;
    this.#broadcastQueue();
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
   * Clear the live input box IF it currently holds real text — ONE guarded `C-c`.
   * `C-c` reliably clears even a wrapped multi-line box (which `C-u` can't), but on
   * an EMPTY box it arms claude's "press again to exit" — so this re-captures and
   * fires ONLY when the box is confirmed non-empty (real text, not the empty/ghost
   * state). Single-shot by design: callers must never blind-retry a 2nd `C-c` (it
   * could land on a now-empty box). `idleOnly` adds the dispatch-gate guards (no
   * open turn / in-flight dispatch / generating) — the abort path passes false
   * because it intentionally clears right after interrupting a turn. Returns true
   * iff a `C-c` was sent.
   */
  async #clearInputIfDirty(idleOnly: boolean): Promise<boolean> {
    if (idleOnly && (this.#turn || this.#dispatchInFlight)) return false;
    const pane = await tmux.captureFresh(this.tmuxWindow); // FRESH — stale here = concatenation
    // captureFresh can take a control-mode round-trip; re-check the idle guards after
    // it: a turn / dispatch may have begun while it was in flight, in which case the
    // text in the box is no longer stale leftover and must not be cleared.
    if (idleOnly && (this.#turn || this.#dispatchInFlight)) return false;
    if (!pane.ok) return false;
    if (idleOnly && (paneShowsGenerating(pane.out) || !paneShowsReadyPrompt(pane.out))) return false;
    const box = paneInputText(pane.out);
    if (box === "" || box === null) return false; // empty / no box → nothing to clear (never C-c empty)
    const cc = await tmux.key(this.tmuxWindow, "C-c");
    return cc.ok;
  }

  /** True when a drain could proceed by the transcript/queue state alone (pane
   *  readiness is checked separately, after a fresh capture). */
  #canDrain(): boolean {
    return this.status !== "ended" && !this.#queuePaused && !this.#dispatchInFlight
      && !this.#turn && this.#queue.length > 0;
  }

  #armDrainRetry(ms: number): void {
    if (this.#drainRetry) clearTimeout(this.#drainRetry);
    this.#drainRetry = setTimeout(() => { this.#drainRetry = null; this.#maybeDrainQueue(); }, ms);
  }

  /**
   * Drain the queue's head IF Claude is genuinely idle AND the input box is empty.
   * The gate AWAITS a FRESH pane capture (control mode) where a stale read would
   * cause data loss, so it runs as a serialized async PUMP, not a sync tick:
   * #draining lets one drain run at a time; a trigger (turn-end / enqueue / resume /
   * #drainRetry) arriving mid-await sets #drainRequested so it re-runs once instead
   * of being dropped. The sync entry point is kept since many callers fire it.
   */
  #maybeDrainQueue(): void {
    if (this.#draining) { this.#drainRequested = true; return; }
    void this.#kickDrain();
  }

  async #kickDrain(): Promise<void> {
    this.#draining = true;
    try {
      await this.#drainOnce();
    } finally {
      this.#draining = false;
      if (this.#drainRequested) { this.#drainRequested = false; this.#maybeDrainQueue(); }
    }
  }

  /**
   * One drain attempt. Re-checks #canDrain() after EVERY await (queue/turn/pause can
   * change while a capture is in flight). Pane gating mirrors the sync version:
   *   1. NOT generating ("esc to interrupt") — #turn lags turn-start, so the pane's
   *      real-time signal is what stops a dispatch into a live turn (double-queue).
   *   2. AT the ready prompt (not a dialog/spinner) — repaint lag → recheck shortly.
   * Then REQUIRE an EMPTY box: dispatch ONLY when paneInputText === "" — a null box
   * (no live input box detected) is "not ready", NOT "empty", so it retries; stuck
   * TEXT is cleared with one guarded C-c (a 2nd dirty read pauses, never a blind 2nd
   * C-c). (Background shells alone don't block — that's why it's "esc to interrupt",
   * not paneShowsWorking.)
   */
  async #drainOnce(): Promise<void> {
    if (this.#drainRetry) { clearTimeout(this.#drainRetry); this.#drainRetry = null; }
    if (!this.#canDrain()) return;

    const pane = await tmux.captureFresh(this.tmuxWindow);
    if (!this.#canDrain()) return; // re-check after the await
    if (!pane.ok || paneShowsGenerating(pane.out) || !paneShowsReadyPrompt(pane.out)) {
      this.#clearAttempts = 0; // a not-ready/busy pane ends any in-progress clear episode
      this.#armDrainRetry(500);
      return;
    }

    const box = paneInputText(pane.out);
    if (box !== "") {
      if (box === null) { this.#clearAttempts = 0; this.#armDrainRetry(500); return; } // not-ready, not empty
      // Stuck text → one guarded C-c, re-check next tick; a 2nd dirty read pauses
      // (never a blind 2nd C-c). Count the attempt ONLY when a C-c actually went out.
      if (this.#clearAttempts >= 1) {
        process.stderr.write(`[queue] input box dirty + unclearable for ${this.id} — paused\n`);
        this.#pauseDispatch("input_dirty");
        return;
      }
      if (await this.#clearInputIfDirty(true)) this.#clearAttempts += 1;
      this.#armDrainRetry(200);
      return;
    }

    // box === "" → empty, safe to type.
    this.#clearAttempts = 0;
    if (!this.#canDrain()) return; // final re-check before committing the dispatch

    const next = this.#queue.shift()!;
    this.#dispatchInFlight = next; // whole item — timeout re-queues it intact
    this.#broadcastQueue();
    try {
      // Type DIRECTLY (not via sendText) — the gate proved the pane is ready + empty,
      // and a "starting" session must type now to bootstrap its transcript. Awaited:
      // the keystrokes go over control mode and a failure must reach the catch below.
      await this.#typeIntoTmux(next.text, { seq: next.seq, source: next.source, mirrorToRelay: next.mirrorToRelay });
    } catch (e) {
      // Send failed outright — put it back at the head and pause.
      this.#queue.unshift(next);
      this.#dispatchInFlight = null;
      this.#pauseDispatch("dispatch_failed");
      process.stderr.write(`[queue] dispatch send failed for ${this.id}: ${e}\n`);
      return;
    }
    // Arm the echo-confirmation timeout: a successful dispatch produces a new turn.
    // If none appears, the message didn't land.
    this.#dispatchTimer = setTimeout(() => this.#onDispatchTimeout(), 20000);
  }

  /** Called from onTranscriptEntry when a new turn starts — confirms the dispatch landed. */
  #confirmDispatchIfAwaiting(): void {
    if (!this.#dispatchInFlight) return;
    this.#dispatchInFlight = null;
    if (this.#dispatchTimer) { clearTimeout(this.#dispatchTimer); this.#dispatchTimer = null; }
    this.#clearSubmitTimer(); // the turn already started → the submit Enter is done/moot
    this.#broadcastQueue();
  }

  #onDispatchTimeout(): void {
    this.#dispatchTimer = null;
    const inflight = this.#dispatchInFlight;
    if (!inflight) return;
    // No turn started in time → the message didn't land (a dialog ate it, or
    // Claude wasn't actually ready). Re-queue the WHOLE item at the head (so its
    // seq/source/mirror/visible survive) and pause so we don't pile more into a
    // bad state; resume re-clears the box and re-types it. Drop the stale pending
    // entry first so the re-type doesn't double it / suppress it as a self-echo.
    this.#dispatchInFlight = null;
    this.#clearSubmitTimer();
    this.#neutralizePending(inflight.text);
    this.#queue.unshift(inflight);
    this.#pauseDispatch("dispatch_timeout");
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
    const pane = tmux.captureCached(this.tmuxWindow);
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
      await tmux.key(this.tmuxWindow,"BTab");
      await sleep(120); // footer needs a beat to repaint between cycles
    }
    await sleep(250);
    const after = this.detectPermissionMode();
    return after === target
      ? { ok: true, mode: after }
      : { ok: false, mode: after ?? undefined, error: `landed on ${after ?? "unknown"}` };
  }

  /** Escape → Claude Code interactive interprets as "interrupt generation". */
  async abort(): Promise<{ ok: true }> {
    // Snapshot the pending submit BEFORE the awaited capture: if a NEW dispatch
    // starts during that await, this (now possibly stale) abort must not cancel it.
    const submitBefore = this.#submitTimer;

    // Block abort only when the session is unambiguously IDLE: an EMPTY ready box,
    // not generating, and no open turn / in-flight dispatch / pending submit. The
    // empty-box requirement is what makes this robust — a turn that's thinking either
    // shows "esc to interrupt" (empty box) OR holds text in the box, so it never
    // reads empty+idle. (#turn lags turn-start, and "esc to interrupt" is HIDDEN by
    // box text, both verified — neither is reliable alone.) Bias toward NOT blocking:
    // a stray Escape on idle is a no-op (Escape doesn't clear the box), whereas a
    // wrong block means "Stop did nothing". FRESH capture — a stale read here could
    // wrongly block a real abort.
    const pane = await tmux.captureFresh(this.tmuxWindow);
    // A genuinely NEW send appeared while we awaited the capture → this abort is
    // stale: the state it was issued against is gone and a fresh message is now in
    // flight. Return before touching anything (no Escape-interrupt, no clear). Note
    // a NULL #submitTimer here means the pre-abort submit simply FIRED (a turn is
    // starting) — that we still interrupt below; only a different, non-null timer is
    // a new send.
    if (this.#submitTimer !== null && this.#submitTimer !== submitBefore) return { ok: true };
    if (!this.#turn && !this.#dispatchInFlight && !this.#submitTimer && pane.ok &&
        paneShowsEmptyReadyPrompt(pane.out) && !paneShowsGenerating(pane.out)) {
      return { ok: true };
    }
    // Abort also cancels an in-progress 500 auto-retry (pressing abort = "stop
    // trying") and disarms a pending retry so the next turn-end won't start one.
    if (this.#retry) {
      this.#emitAgentNote(`⏹ Auto-retry cancelled`, Date.now(), this.claudeSessionId);
      this.#clearRetry();
    }
    this.#turn5xxStatus = null;
    // Cancel the pending submit Enter — but ONLY the one that was pending when abort
    // BEGAN. The new-dispatch case already returned above, so here sameSubmit is false
    // ONLY when that pre-abort submit FIRED mid-capture (#submitTimer went null): then
    // there's nothing to cancel and the box is empty, so skip the cancel + abort-clear.
    const sameSubmit = this.#submitTimer === submitBefore;
    if (sameSubmit) this.#clearSubmitTimer();
    await tmux.key(this.tmuxWindow, "Escape");
    this.#setThinking(false);
    // Interrupting mid-tool means Claude won't write that tool's result — close any
    // open tools so their cards don't spin forever.
    this.#closeOpenTools();
    // Clear after abort: Escape interrupts but does NOT clear the box (verified), so
    // anything typed while Claude was generating lingers. Once the interrupt settles +
    // the prompt repaints, drop it with one guarded C-c. Cancelled if a new queued send
    // starts first (#typeIntoTmux clears the timer). The clear only ever C-c's a box it
    // re-confirms non-empty, so an idle/already-clear box is a no-op.
    if (sameSubmit) {
      if (this.#abortClearTimer) clearTimeout(this.#abortClearTimer);
      this.#abortClearTimer = setTimeout(() => {
        this.#abortClearTimer = null;
        if (this.status !== "ended") void this.#clearInputIfDirty(false);
      }, ABORT_CLEAR_DELAY_MS);
    }
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
  async sendRawKeys(script: string, opts?: { literal?: boolean }): Promise<{ ok: boolean; segments: number; error?: string }> {
    // NB: raw keys are an escape hatch for manual intervention, NOT a primary input
    // path, so we deliberately DON'T coordinate them with the dispatch/abort-clear
    // machinery — if a manual poke lands in the ~400ms after an abort and gets cleared,
    // whoever's hands-on the pane can see it and redo it. (The primary queued path does
    // cancel the abort-clear, in #typeIntoTmux.)
    // Literal mode: type the string verbatim, no token parsing — so
    // "git commit<Enter>" lands as those exact characters instead of a
    // command + keypress. Used by the pane's plain-text input toggle.
    if (opts?.literal) {
      const ok = (await tmux.literal(this.tmuxWindow,script)).ok;
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
    // Await each segment IN ORDER so a failed one stops the rest from being enqueued.
    for (const seg of segments) {
      const ok = seg.type === "keys"
        ? (await tmux.key(this.tmuxWindow,...seg.names)).ok
        : (await tmux.literal(this.tmuxWindow,seg.text)).ok;
      if (!ok) return { ok: false, segments: segments.length, error: "tmux send-keys failed" };
    }
    return { ok: true, segments: segments.length };
  }

  async pane(color = false): Promise<{ ok: true; text: string }> {
    // -e includes ANSI SGR escape sequences (colors, bold, …) so the app can
    // render the TUI in color; without it the capture is plain text. A FRESH read
    // over control mode (colour stays uncached) — falls back to spawn while
    // disconnected.
    return { ok: true, text: (await tmux.captureFresh(this.tmuxWindow, { color })).out };
  }

  /**
   * Resize the tmux window. tmux's resize-window auto-switches the window to
   * window-size=manual, so the size sticks (the session is detached — the app
   * is the only "viewer"). A real terminal attaching reclaims via the global
   * client-attached hook (window-size latest), giving "last connector drives
   * the width". cols/rows are clamped to sane terminal bounds.
   */
  async resize(cols: number, rows: number): Promise<{ ok: boolean }> {
    const c = Math.max(20, Math.min(500, Math.floor(cols)));
    const r = Math.max(10, Math.min(200, Math.floor(rows)));
    if (!Number.isFinite(c) || !Number.isFinite(r)) return { ok: false };
    const res = await tmux.command(["resize-window", "-t", this.tmuxWindow, "-x", String(c), "-y", String(r)]);
    return { ok: res.ok };
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
    // Route through the verified dispatch queue (NOT sendText directly): the app
    // send is serialized behind any in-flight turn and only typed into an empty,
    // ready box — never on top of a busy turn or stuck text (the lost/merged-send
    // bugs). visible:false — the app already has this message in its chat history,
    // so it must not also appear as an editable queue chip. mirrorToRelay:false —
    // it came FROM the relay. seq is carried so receipt-matching still pairs the
    // transcript echo with this send.
    this.enqueue(augmented, { seq, source: "relay", mirrorToRelay: false, visible: false });
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
    // mirrorToRelay so the re-sent prompt shows in chat (its bubble was the prior
    // turn's); visible:false — it's a system re-send, not an editable queue chip.
    this.enqueue(text, { source: "rpc", mirrorToRelay: true, visible: false });
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

  /**
   * Drop the pending-match entry + persisted `received` backstop for `text`.
   * Called when a dispatch times out (re-queued for re-type) or mismatches — its
   * #typeIntoTmux already recorded a pending+received twin keyed on the typed
   * (newline-collapsed) form, and leaving that behind would (a) double up on
   * re-dispatch and (b) wrongly suppress a later identical prompt as a self-echo.
   */
  #neutralizePending(text: string): void {
    const delivery = this.#delivery;
    if (!delivery || !this.relaySessionId) return;
    const typed = flattenForMatch(text);
    const i = delivery.pending.findIndex(p => p.text === typed);
    if (i >= 0) delivery.pending.splice(i, 1);
    consumeReceived(delivery, this.relaySessionId, typed, Date.now());
  }

  /**
   * Type `text` into the pane PRESERVING newlines: one `literal` per line with a C-j
   * (a real in-box linefeed, NOT a submit) between them. A single-line message is one
   * `literal` — unchanged. Does NOT clear or submit: callers ensure the box is empty
   * first (the dispatch gate, or #steer's guarded C-c) and own the delayed Enter. NB no
   * pre-clear control char (C-u/C-c) is sent right before the C-j burst — that's what
   * Claude's paste-detection used to fold into the message as a stray \x15. Awaited in
   * order via the FIFO; returns false if any send fails (caller rolls back).
   */
  async #typeLines(text: string): Promise<boolean> {
    const lines = text.split(/\r\n|\r|\n/);
    for (let i = 0; i < lines.length; i++) {
      if (i > 0 && !(await tmux.key(this.tmuxWindow, "C-j")).ok) return false;
      if (lines[i] !== "" && !(await tmux.literal(this.tmuxWindow, lines[i])).ok) return false;
    }
    return true;
  }

  /** Type a message into the pane + record receipt + bump thinking. */
  async #typeIntoTmux(text: string, opts: SendOptions): Promise<void> {
    // A new send supersedes any pending abort-clear: cancel it so its C-c can't
    // fire mid-type and wipe the message we're about to send.
    if (this.#abortClearTimer) { clearTimeout(this.#abortClearTimer); this.#abortClearTimer = null; }
    const delivery = this.#ensureDelivery();
    // Commands (`!bash`, `/slash`) never produce a user-text transcript entry —
    // their synthetic wrappers are suppressed — so they must NOT go on the
    // pending-match queue, where they'd never match and would block the next
    // real message's match, mirroring it as a duplicate.
    const isCommand = /^\s*!/.test(text) || /^\/[a-zA-Z][\w:-]*(?:\s|$)/.test(text);
    const tracked = !!delivery && !isCommand;
    // Dedup key: the flattened (newline→space) form. We type REAL newlines into the
    // pane (#typeLines), so Claude echoes a multi-line user message — but we record +
    // match the flattened form on both sides (flattenForMatch on the echo too) so that
    // echo still pairs with this send and isn't mirrored as a duplicate. The relay
    // mirror uses the original `text` (newlines intact) so the app shows it verbatim.
    const typed = flattenForMatch(text);
    if (tracked) {
      delivery!.pending.push({ seq: opts.seq, text: typed, source: opts.source, at: Date.now() });
      // Persisted backstop: remember we sent this text so its transcript echo is
      // never mirrored as a duplicate, even if the pending queue is lost to a
      // restart.
      recordReceived(delivery!, this.relaySessionId!, typed, Date.now());
    }
    // No pre-clear: the drain gate only dispatches into a box it has confirmed EMPTY
    // (clearing any leftover with a guarded C-c first), so a C-u here is redundant — and
    // a control char right before the C-j burst is exactly what paste-detection folded
    // into the message as a stray \x15. Type goes over control mode (or spawn while
    // disconnected) IN ORDER via the FIFO; on failure roll back + throw so the drain
    // re-queues + retries.
    if (!(await this.#typeLines(text))) {
      if (tracked) delivery!.pending.pop();
      throw new Error("tmux send-keys failed");
    }
    // Submit on a delay — NOT back-to-back. The fast send-keys -l burst reads as a
    // paste to claude; an immediate Enter is swallowed as a newline and the message
    // sits unsent (the core "typed but not submitted" bug). See ENTER_SUBMIT_DELAY_MS.
    // mirrorToRelay + thinking are deferred into the submit callback so the app's
    // chat doesn't show "sent" before the pane has actually submitted.
    this.#armSubmit({ text, mirrorToRelay: opts.mirrorToRelay });
    if (!this.#tailer && this.status !== "ended") this.pollForTranscript();
  }

  /**
   * /steer: type a message straight into the pane and submit it NOW, bypassing the
   * dispatch queue and its empty-box/idle gate — so it reaches Claude immediately, even
   * while a turn is in flight (Claude takes it as its next input). Unlike #armSubmit this
   * submits WITHOUT the #turn / #dispatchInFlight guards — submitting mid-turn is the
   * whole point. Records a receipt so the transcript echo is deduped (not re-mirrored),
   * and mirrors to the relay once the Enter actually lands.
   */
  async #steer(text: string, opts: SendOptions): Promise<void> {
    if (this.status === "ended") return;
    const typed = flattenForMatch(text); // dedup key; real newlines are typed (see #typeIntoTmux)
    const delivery = this.#ensureDelivery();
    const tracked = !!delivery && !!this.relaySessionId;
    if (tracked) {
      delivery!.pending.push({ seq: opts.seq, text: typed, source: opts.source, at: Date.now() });
      recordReceived(delivery!, this.relaySessionId!, typed, Date.now());
    }
    // No dispatch gate here (steering types alongside an in-flight turn), so clear any
    // leftover ourselves — but with a GUARDED C-c, never a blind one: C-c on an empty
    // box arms Claude's "press again to exit", so we only send it when the box actually
    // holds text. C-c (unlike C-u) clears a wrapped multi-line box. Let it settle before
    // the type so it can't be folded into a multi-line paste (the \x15-class bug).
    const pane = await tmux.captureFresh(this.tmuxWindow);
    if (pane.ok && paneInputText(pane.out)) {
      await tmux.key(this.tmuxWindow, "C-c");
      await sleep(CLEAR_SETTLE_MS);
    }
    if (!(await this.#typeLines(text))) { if (tracked) delivery!.pending.pop(); return; }
    // Submit after the settle delay (paste-detection swallows an immediate Enter).
    // Coalesce rapid steers; mirror only once the Enter has gone out.
    if (this.#steerSubmitTimer) clearTimeout(this.#steerSubmitTimer);
    this.#steerSubmitTimer = setTimeout(async () => {
      this.#steerSubmitTimer = null;
      if (this.status === "ended") return;
      const e = await tmux.key(this.tmuxWindow, "Enter");
      if (e.ok && opts.mirrorToRelay) this.#relay?.send(encodeUserMessage(text));
    }, ENTER_SUBMIT_DELAY_MS);
  }

  /**
   * /title <text>: set the session's conversation title directly. Titles are the relay
   * "summary" (normally Claude's generated ai-title); this overrides it with the user's
   * text and pushes it the same way — relay summary + a local session_update broadcast —
   * so the app shows it instead of "New Chat". A later ai-title entry can still overwrite
   * it (same as renaming in Claude). Bare `/title` (no text) is a no-op.
   */
  #setTitle(title: string): void {
    const t = title.trim();
    if (!t) return;
    this.summary = t;
    void this.#relay?.updateSummary(t);
    this.#deps.broadcast("session_update", this.toJSON());
  }

  /** Cancel a pending delayed-Enter (abort/kill/confirm/timeout/mismatch). */
  #clearSubmitTimer(): void {
    if (this.#submitTimer) { clearTimeout(this.#submitTimer); this.#submitTimer = null; }
  }

  /**
   * Submit a just-typed message: send Enter after a settle delay so claude's
   * paste-detection doesn't swallow it (see ENTER_SUBMIT_DELAY_MS), then — only
   * once the Enter has actually gone out — mirror it to the relay and flip
   * thinking, so the app never shows "sent" before the pane submitted. The timer
   * is cancellable (#clearSubmitTimer) and the callback is strictly guarded: the
   * session must still be live, the SAME dispatch must still be in flight (so an
   * abort+new-dispatch can't fire a stale Enter), and no turn may already be open.
   * No automatic re-Enter: a genuine non-submit is caught by the dispatch timeout
   * (paused + surfaced), which is safer than blindly re-pressing Enter.
   */
  #armSubmit(opts: { text: string; mirrorToRelay: boolean }): void {
    this.#clearSubmitTimer();
    const target = this.#dispatchInFlight; // the dispatch this Enter belongs to (may be null)
    this.#submitTimer = setTimeout(async () => {
      this.#submitTimer = null;
      if (this.status === "ended") return;
      if (this.#turn) return;                                    // a turn is already in flight
      if (!target || this.#dispatchInFlight !== target) return;  // require the same dispatch still in flight
      // Mirror + flip thinking ONLY after the Enter has actually gone out over the
      // wire — so the app never shows "sent" before the pane submitted. A failed
      // Enter (disconnect) leaves it unsent; the 20s dispatch timeout surfaces it.
      const e = await tmux.key(this.tmuxWindow, "Enter");
      if (!e.ok) return;
      // Re-validate AFTER the awaited Enter (it may have queued behind other control
      // commands): a kill / dispatch-timeout / abort that flipped state mid-await must
      // not let us publish stale "sent/thinking". (#turn can't have flipped from our
      // own Enter yet — the turn isn't detected until claude writes turn-start — so
      // this only catches an externally-changed state.)
      const st: string = this.status; // re-read: it may have flipped to "ended" during the await
      if (st === "ended" || this.#turn || !target || this.#dispatchInFlight !== target) return;
      if (opts.mirrorToRelay) this.#relay?.send(encodeUserMessage(opts.text));
      this.#setThinking(true);
    }, ENTER_SUBMIT_DELAY_MS);
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

  /** Synthesize tool-call-end for every tool whose start we forwarded but whose
   *  result never arrived (turn force-closed, aborted, or session torn down) —
   *  otherwise the app's tool card spins "running" forever. */
  #closeOpenTools(timeMs?: number): void {
    if (this.#openTools.size === 0) return;
    if (this.#relay) {
      for (const [id, turn] of this.#openTools) {
        this.#relay.send(encodeToolCallEnd(id, { turn, time: timeMs }));
      }
    }
    this.#openTools.clear();
  }

  /** Single funnel for the app's "thinking" status — tracks the last value and
   *  pushes it to the relay. Lifecycle transitions (send/end_turn/abort) call
   *  this directly; the pane poll change-gates itself before calling. */
  #setThinking(thinking: boolean): void {
    this.#thinking = thinking;
    this.#relay?.setThinking(thinking);
  }

  /** PreCompact hook fired: Claude is compacting. Surface the "compacting"
   *  status and arm a backstop timeout in case the compact_boundary record that
   *  normally clears it never arrives (compaction can run for minutes — see the
   *  174s observed — so the window is generous). */
  markCompacting(trigger: string): void {
    if (this.status === "ended") return;
    this.#compacting = { trigger: trigger === "manual" ? "manual" : "auto", since: Date.now() };
    void this.#relay?.updateCompacting(this.#compacting as { trigger: "auto" | "manual"; since: number });
    if (this.#compactingTimer) clearTimeout(this.#compactingTimer);
    this.#compactingTimer = setTimeout(() => this.#clearCompacting(), 10 * 60_000);
  }

  /** Clear the "compacting" status (compact_boundary seen, abort, or teardown). */
  #clearCompacting(): void {
    if (this.#compactingTimer) { clearTimeout(this.#compactingTimer); this.#compactingTimer = null; }
    if (this.#compacting == null) return;
    this.#compacting = null;
    void this.#relay?.updateCompacting(null);
  }

  /** Reconcile "thinking" from the live pane every 3s — the pane is the ground
   *  truth: the "esc to interrupt" line shows iff Claude is actively generating.
   *  This corrects the event-driven setters for the cases they miss: typing
   *  directly in the pane, stops at an interactive prompt (no end_turn), and
   *  interrupts. Runs only while a relay is attached and the session is live. */
  #pollThinking(): void {
    if (this.status === "ended") return;
    if (this.#relay) {
      const pane = tmux.captureCached(this.tmuxWindow);
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

    // First entry activates the session — Claude is now reading the pane.
    if (this.status === "starting") {
      const sid = String(entry.sessionId || "");
      if (sid) {
        this.claudeSessionId = sid;
        this.status = "active";
        this.lastActiveAt = Date.now();
        // Persist the window→conversation binding so a daemon restart's recover()
        // can re-attach the RIGHT transcript instead of the newest-mtime one.
        saveWindowRecord(this.id, { claudeSessionId: sid });
        this.#deps.broadcast("session_update", this.toJSON());
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
        this.#relay.send(encodeTurnEnd("completed", { turn: this.#turn.turnId, time: entryTimeMs, usage: this.#turnUsage ?? undefined }));
      }
      this.#turnUsage = null;
      this.#closeOpenTools(entryTimeMs); // a tool abandoned by an errored turn shouldn't spin forever
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

    // Compaction finished: Claude writes a compact_boundary marker after
    // summarizing the conversation (it carries durationMs/postTokens, so it's
    // the authoritative COMPLETION signal). Clear the "compacting" status the
    // PreCompact hook set when it started.
    if (entryType === "system" && entry.subtype === "compact_boundary") {
      this.#clearCompacting();
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
        // Emit tool-call-end for tool results. NOT gated on this.#turn: the turn
        // may have been nulled (turn_duration/error) before the result lands, and
        // gating used to drop the end → a tool card stuck "running". Use the turn
        // id remembered when the start was forwarded (fall back to the live turn).
        if (this.#relay && Array.isArray(content)) {
          for (const item of content as Array<Record<string, unknown>>) {
            if (item.type === "tool_result" && typeof item.tool_use_id === "string") {
              const id = item.tool_use_id;
              const turn = this.#openTools.get(id) ?? this.#turn?.turnId;
              if (turn) {
                this.#relay.send(encodeToolCallEnd(id, { turn, time: entryTimeMs }));
                this.#openTools.delete(id);
              }
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
        // We type real newlines but record the flattened form (see #typeIntoTmux), and
        // Claude echoes the message multi-line — so MATCH on the flattened echo. `content`
        // itself (newlines intact) is kept for the inbound receipt + retry text below.
        const matchContent = flattenForMatch(content);
        // Match anywhere in the queue (not just the front) so an out-of-order or
        // stale entry can't block a real match.
        const idx = delivery.pending.findIndex((p) => p.text === matchContent);
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
          consumeReceived(delivery, this.relaySessionId, matchContent, Date.now());
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
              flattenForMatch(this.#dispatchInFlight.text) === matchContent) {
            this.#confirmDispatchIfAwaiting();
          }
          return; // self-echo of a relay/HTTP/RPC send — don't double-record locally
        }
        // No queue match. Before assuming this was typed directly in the pane,
        // check the PERSISTED received-text backstop: if the app sent this text
        // recently, the pending match was just lost (e.g. a daemon restart) —
        // suppress it instead of mirroring a duplicate.
        if (!delivery.forwardedUuids.has(uuid)) {
          if (consumeReceived(delivery, this.relaySessionId, matchContent, Date.now())) {
            recordInboundReceipt(delivery, this.relaySessionId, {
              uuid, text: content, source: "relay", at: Date.now(),
            });
          } else if (this.#dispatchInFlight || delivery.pending.length > 0) {
            // A dispatch is in flight / still pending, yet this transcript user
            // entry matched NONE of them — the pane likely concatenated or
            // garbled the send (the S5/S8 bug). Do NOT mirror it: re-mirroring an
            // unmatched echo is exactly the seq-43 duplicate. Mark the uuid
            // handled, clear the in-flight (so an upcoming turn-start can't
            // FALSELY confirm a send that didn't land as typed), and pause with a
            // mismatch reason so the app shows a real banner instead of silently
            // losing or duplicating the message.
            recordInboundReceipt(delivery, this.relaySessionId, {
              uuid, text: content, source: "relay", at: Date.now(),
            });
            if (this.#dispatchTimer) { clearTimeout(this.#dispatchTimer); this.#dispatchTimer = null; }
            this.#clearSubmitTimer(); // don't let a stale Enter submit the garbled text
            // Clear the stale pending twin(s) so they can't later suppress a real
            // identical prompt as a phantom self-echo, or keep forcing mismatch
            // pauses. If a dispatch is still in flight, neutralize its text; if
            // turn-start already confirmed (cleared) the in-flight item but a
            // garbled echo still arrived, the leftover pending entries are the
            // culprit — drop them all (with their persisted received twins).
            if (this.#dispatchInFlight) {
              this.#neutralizePending(this.#dispatchInFlight.text);
            } else {
              for (const p of [...delivery.pending]) {
                consumeReceived(delivery, this.relaySessionId, p.text, Date.now());
              }
              delivery.pending.length = 0;
            }
            this.#dispatchInFlight = null;
            this.#pauseDispatch("dispatch_mismatch");
            process.stderr.write(`[dispatch] mismatch for ${this.id}: transcript user entry matched no pending send — paused (not mirrored)\n`);
            return;
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
          this.#turnUsage = null; // fresh turn → reset usage accumulator
          this.#relay.send(encodeTurnStart({ turn: this.#turn.turnId, time: entryTimeMs }));
          // A fresh turn starting is the proof a dispatched queue message
          // landed — Claude is now responding to it.
          this.#confirmDispatchIfAwaiting();
        }
        // Capture token usage (cumulative per message) to report at turn-end —
        // AFTER the turn-start reset above so the first entry's usage isn't wiped.
        if (msg.usage && typeof msg.usage === "object") this.#turnUsage = msg.usage as Record<string, unknown>;
        const opts = { turn: this.#turn.turnId, claudeUuid: entryUuid || undefined, time: entryTimeMs };
        for (const block of blocks) {
          const blockType = String(block.type || "");
          if (blockType === "text") {
            const text = String(block.text || "").trim();
            if (text) this.#relay.send(encodeTextEvent(text, opts));
          } else if (blockType === "tool_use") {
            const callId = String(block.id || crypto.randomUUID());
            this.#openTools.set(callId, this.#turn.turnId); // track for tool-call-end
            this.#relay.send(encodeToolCallStart({
              call: callId,
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
          this.#closeOpenTools(entryTimeMs); // safety: any tool without a result
          this.#relay.send(encodeTurnEnd("completed", { turn: this.#turn.turnId, time: entryTimeMs, usage: this.#turnUsage ?? undefined }));
          this.#turnUsage = null;
          this.#turn = null;
          this.#setThinking(false);
          this.#deps.broadcast("stop", { session_id: sid });
          this.#maybeDrainQueue(); // turn done → send the next queued message
          // Claude finished responding AND there's genuinely no more queued work
          // → push a "done" notification (the server suppresses it if you're
          // already looking at this session). This is what makes joy sessions
          // notify at all — nothing was firing one before.
          //
          // Guard on all three: nothing dispatched awaiting echo, an empty queue,
          // AND no pending drain-retry. At turn-end the pane often hasn't
          // repainted, so #maybeDrainQueue() arms a #drainRetry (a queued message
          // about to send) WITHOUT yet setting #dispatchInFlight — checking only
          // #dispatchInFlight would fire a premature "done" for an intermediate
          // turn while more queued messages are still about to run.
          if (!this.#dispatchInFlight && this.#queue.length === 0 && !this.#drainRetry) {
            this.#relay?.notify("done");
          }
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
 * True when the pane shows Claude's LIVE interactive input box.
 *
 * The input box is a "❯" line drawn between two horizontal rules:
 *     ─────────────────────
 *     ❯ <your text or empty>
 *     ─────────────────────
 *       ⏵⏵ bypass permissions on …            ← footer
 *
 * We require the rule directly ABOVE the "❯" — NOT just any "❯" line — because
 * Claude echoes every PAST user message in scrollback as "❯ say hi…", and a bare
 * "❯" match can't tell those history echoes from the one live box (they have no
 * border above them). Also excludes selector dialogs, whose options render as
 * "❯ 1. Yes, …". Ghost-text suggestions like `❯ Try "refactor <filepath>"` count
 * as ready (the live box with placeholder text).
 */
export function paneShowsReadyPrompt(text: string): boolean {
  const lines = text.split("\n");
  const isRule = (s: string | undefined) => /^[─━]{3,}$/.test((s ?? "").trim());
  for (let i = 1; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t.startsWith("❯")) continue;
    if (/^❯\s*\d+\./.test(t)) continue;     // selector option row, not the input
    if (isRule(lines[i - 1])) return true;  // the live box's top border
  }
  return false;
}

/**
 * Extract the text currently sitting in Claude's LIVE input box — the "❯" line
 * with a horizontal rule directly above it (the same line paneShowsReadyPrompt
 * keys on). Returns:
 *   - "" when the box is empty (just the prompt + cursor),
 *   - the typed text (prompt glyph, cursor's non-breaking-space padding and ANSI
 *     stripped) when something is in it,
 *   - null when no live input box is on screen.
 * Ghost-text placeholders (e.g. `Try "refactor <filepath>"`, shown dimmed when
 * the box is empty) count as empty — they are not user content. This is the
 * primitive the dispatch gate uses to refuse typing into a non-empty box (which
 * is how two messages used to concatenate into one garbled turn).
 */
export function paneInputText(text: string): string | null {
  const lines = text.split("\n");
  const isRule = (s: string | undefined) => /^[─━]{3,}$/.test((s ?? "").trim());
  for (let i = 1; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t.startsWith("❯")) continue;
    if (/^❯\s*\d+\./.test(t)) continue;     // selector option row, not the input
    if (!isRule(lines[i - 1])) continue;    // not the live box (scrollback echo)
    // Read the WHOLE box: the ❯ line PLUS any continuation lines down to the bottom
    // rule. A wrapped / multi-line (C-j) input box spans several lines between the
    // rules; reading only the ❯ line would miss text on a blank-first-line box and
    // wrongly report "empty", letting a dispatch concatenate on top of it.
    const parts: string[] = [];
    const first = stripAnsi(t.replace(/^❯/, "")).replace(/\s+/g, " ").trim();
    if (first) parts.push(first);
    for (let j = i + 1; j < lines.length && !isRule(lines[j]); j++) {
      // Defensive bound: the footer (permission hint) lives below the bottom rule, but
      // if a capture is missing that rule, don't run past it into footer text.
      if (/⏵|bypass permissions|shift\+tab/i.test(lines[j])) break;
      const cont = stripAnsi(lines[j]).replace(/\s+/g, " ").trim();
      if (cont) parts.push(cont);
    }
    const joined = parts.join(" ");
    if (!joined) return "";
    if (/^Try\s+["“']/.test(joined)) return ""; // ghost-text placeholder, not input
    return joined;
  }
  return null;
}

/** True when the live input box is present AND empty — safe to type into. */
export function paneShowsEmptyReadyPrompt(text: string): boolean {
  return paneInputText(text) === "";
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
 * True when Claude is doing (or waiting on) work — the daemon's ground truth for
 * the app's "thinking" status. Two cases:
 *   1. Actively generating: Claude prints the "esc to interrupt" hint while a turn
 *      is in flight (text or a running tool). Absent at the idle prompt / dialogs.
 *   2. Background work still running even though the turn ended and the pane is
 *      back at the ready prompt: Claude's LIVE status footer (the bottom bar)
 *      shows "· N shell(s) · … · ↓ to manage" while background tasks/agents run.
 *      Without this the status flips to idle/green while a background task is
 *      still working.
 * The shell/manage check is restricted to the live status-footer line(s) — NOT
 * the whole pane — because old "· N shell still running" progress output lingers
 * in scrollback and would otherwise read as working forever (stuck "thinking").
 * Footer lines are identified by their signature, mode-agnostically: the
 * permission-mode glyph (⏵⏵ bypass/auto/accept, ⏸ plan) OR the footer hints
 * ("← for agents", "↓ to manage") which also appear in default mode (no glyph).
 * Narrow panes truncate the footer and drop the shell/manage tokens — that's an
 * accepted false-negative (under-report), never a stuck-working false-positive.
 */
export function paneShowsWorking(text: string): boolean {
  if (paneShowsGenerating(text)) return true;
  // Only the LIVE footer counts. Old "· N shells · ↓ to manage" / completed-agent
  // footers linger in SCROLLBACK above the input box after a turn ends; matching
  // them anywhere reads as work-forever (stuck "thinking" — observed right after a
  // subagent/background run). The live footer sits BELOW the live input box, so
  // scope the scan to the lines after it (fall back to the last few lines if no
  // box is on screen, e.g. a dialog).
  const lines = text.split("\n");
  const isRule = (s: string | undefined) => /^[─━]{3,}$/.test((s ?? "").trim());
  let boxLine = -1;
  for (let i = 1; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t.startsWith("❯") && !/^❯\s*\d+\./.test(t) && isRule(lines[i - 1])) boxLine = i;
  }
  const region = (boxLine >= 0 ? lines.slice(boxLine + 1) : lines.slice(-4))
    .filter((l) => /⏵⏵|⏸|↓\s*to manage|for agents/i.test(l))
    .join("\n");
  return /·\s*\d+\s+shells?\b/i.test(region) || /↓\s*to manage/i.test(region);
}

/**
 * True ONLY when Claude is ACTIVELY generating a turn — it prints "esc to
 * interrupt" while text/tool output is streaming. Narrower than paneShowsWorking
 * (which also counts background shells): this is the dispatch gate's real-time
 * "a turn is in flight" signal, used to avoid typing a queued message into a live
 * turn before the transcript's #turn flag catches up. A lingering background shell
 * must NOT count here — Claude is idle at the prompt and can take the next message.
 */
export function paneShowsGenerating(text: string): boolean {
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
