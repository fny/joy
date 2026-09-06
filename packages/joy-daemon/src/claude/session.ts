// Session: one Claude Code instance running in a tmux window, bridged to the
// joy relay. Owns ALL per-session state that used to be scattered across
// eight parallel Maps in server.ts (relay session card, transcript watcher,
// turn state, delivery receipts).
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
import { existsSync, readFileSync, statSync, openSync, readSync, closeSync } from "fs";
import type { AgentSession } from "../domain/agentSession";
import { run } from "../tmux/shell";
import { tmux as defaultTmux, disposeTmuxHandle, type TmuxDriver } from "../tmux/driver";
import {
  encodeTurnStart,
  encodeTextEvent,
  encodeToolCallStart,
  encodeToolCallEnd,
  encodeTurnEnd,
  encodeUserMessage,
  type RelayClient,
  type RelaySession,
  type JoyGoalInfo,
  type JoyLoginInfo,
  type JoyDialogInfo,
} from "../relay/relay.ts";
import type { DeliverySource } from "../domain/agentSession";
import { ledgerFor, type Ledger } from "../domain/ledger";
import { coordinatorFor, type SessionCoordinator, type CommandView, type AttemptRef, type SubmitResult, type InterruptResult, type HandledCommand } from "../domain/coordinator";
import { ClaudeDriver } from "./claudeDriver";
import { joyPromptReinjection } from "../domain/agentTagsPrompt";
import { OPTIONS_SYSTEM_PROMPT } from "./optionsPrompt";
import { saveWindowRecord, loadWindowRecord, deleteWindowRecord, WindowRecordWriteError } from "../domain/windowRecord";
import { cwdToTranscriptDir, findLatestTranscript, cappedTailOffset, tailJsonl, type TranscriptTailer } from "./transcript";
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

// After the C-u clear, wait this long before typing a MULTI-LINE message. The
// C-j burst trips Claude's paste-detection, which otherwise captures the just-sent
// clear control char into the pasted content — corrupting the message + breaking
// dedup. The delay lets the kill-line be processed first. (Used by /steer.)
const CLEAR_SETTLE_MS = 120;

// Cadence of the input_dirty self-heal probe (#recheckDirtyPause): a handful of
// dense checks catch the common case (buffered clear keys landing just after we
// declared the box unclearable), then it settles into a slow heartbeat so a
// long-paused session costs next to nothing.
const DIRTY_RECHECK_MS = 5000;
const DIRTY_RECHECK_SLOW_MS = 30000;
const DIRTY_RECHECK_DENSE_TRIES = 6;

// Echo-confirmation window for a dispatched message: if no turn starts within
// this, the send is treated as failed (requeue + pause). Bumped from 20s — a
// large context makes turn-start slower, and 20s false-failed genuine sends.
const DISPATCH_ECHO_TIMEOUT_MS = 30000;
// …but if Claude is visibly WORKING at the deadline (churning on a huge context
// before writing turn-start), extend rather than fail — up to this many times
// (~2min total). Beyond that a genuinely-lost dispatch finally surfaces.
const MAX_DISPATCH_EXTENDS = 3;

// 500-error auto-retry backoff (seconds): paired ramp, then STOP. 14 attempts,
// ~63 min total. When a turn ENDS with an unresolved 5xx (Claude gave up after
// its own internal retries), joy-daemon re-sends the failed turn on this schedule
// until it succeeds, abort is pressed, or the schedule runs out.
const RETRY_SCHEDULE_SEC = [15, 15, 30, 30, 60, 60, 120, 120, 240, 240, 480, 480, 960, 960];

// Strip ANSI/terminal escape sequences (SGR colors, cursor moves, OSC) so
// mirrored command output doesn't render as garbage in the chat.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]|[\x00-\x08\x0b-\x1f\x7f]/g;
export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}


/** Wire shape — frozen. The app and the debug page consume this JSON. */
export interface SessionRecord {
  id: string;
  /** Live CPU/RAM of the agent's process tree — stamped by the single-session
   *  `get` op only (sampled; see domain/procStats). */
  process?: { cpuPercent: number; rssBytes: number; processCount: number; sampledAt: number };
  /** Which harness runs this session (claude|codex|opencode|pi). */
  agent?: string;
  claude_session_id?: string;
  current_model?: string;
  pid?: number;
  tmux_window: string;
  /** Per-session tmux server socket label (-L), null on the shared server. */
  tmux_socket?: string | null;
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
  /** Turn/dispatch/queue activity — the scripting "can I ask now?" signal (see busy()). */
  busy?: boolean;
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
  /** The durable acceptance ledger (domain/ledger.ts). Absent → the process's
   *  ledger for the current state dir (ledgerFor()). */
  ledger?: Ledger;
  /** The session coordinator (domain/coordinator.ts) that owns this
   *  session's commands. Absent → coordinatorFor(ledger). */
  coordinator?: SessionCoordinator;
  broadcast(event: string, data: unknown): void;
  addChatMessage(msg: ChatMessage): void;
  /** Called when a relay session is attached — the place to register session-scoped ops.
   *  Typed to AgentSession so the same deps drive both claude and codex sessions. */
  onRelayAttached?: (session: AgentSession, rs: RelaySession) => void;
  /** True if another session already tails this transcript — guards the unpinned
   *  newest-mtime discovery from adopting a sibling session's conversation when
   *  several sessions share a cwd. */
  isTranscriptClaimed?: (path: string, selfId: string) => boolean;
}

export interface SendOptions {
  seq?: number;
  source: DeliverySource;
  /** Mirror the message to the relay so the app's chat history shows it (web/rpc sends). */
  mirrorToRelay: boolean;
}

/** Slash commands joy handles itself, before the text reaches Claude (today: `/title`). */
const JOY_COMMANDS = new Set(["steer", "btw", "title", "login-code", "joy-prompt"]);

/**
 * Parse a joy-owned slash command the daemon intercepts BEFORE the text reaches Claude:
 * `/<name> <args>`. Only the names in JOY_COMMANDS are ours — every OTHER slash command
 * (`/compact`, project commands, …) returns null and passes straight through to Claude
 * untouched. Returns the lowercased name + remaining args, or null.
 */
/**
 * Does a submitted prompt earn the thinking LEASE (the window in which the
 * pane's "not generating" read is not allowed to clear thinking)?
 *
 * The lease exists for one failure: a long PRE-OUTPUT think, where a broken
 * pane matcher read idle six seconds into a minutes-long turn. A CLI slash
 * command is never that — /effort and /model open a picker, /status and
 * /context print and return — and none of them generate. Holding the pane off
 * for the full lease pinned busy() true, so the lane's Phase C never saw an
 * idle poll and the relay turn stayed open with every later message queued
 * behind it (`/effort high` wedged a session for 60s, 2026-09-03).
 */
export const THINKING_LEASE_MS = 170_000;
/** A slash command's lease. Most built-ins (/effort, /model, /status,
 *  /clear) never generate, and the full lease held them "busy" for 170s —
 *  but /compact, /init and every custom command DO generate, and with no
 *  lease at all two idle-looking reads in the pre-spinner second could end
 *  their turn early and let the next queued prompt in on top (codex
 *  review, 2026-09-04). Long enough to cover that second, short enough
 *  that a no-op command is over before anyone notices. */
export const SLASH_THINKING_LEASE_MS = 8_000;
/** SessionEnd → teardown grace: the hook runs INSIDE the exiting claude, so
 *  its pid is still alive at hook time. Confirm death after this many ms;
 *  a pid still alive then is a claude that did not exit (a /clear-class
 *  rotation, a restart replacement under the same id) — the pid probe keeps
 *  the last word. */
export const HOOK_SESSION_END_GRACE_MS = 1_500;
/** With hooks live the pane may CLEAR thinking only after this many
 *  consecutive not-generating reads (3s apart) past the lease — a tie-breaker
 *  for the one edge hooks do not report (Stop does not fire on a terminal
 *  Esc; the transcript's interrupt marker normally closes that). Never SETS. */
export const HOOK_TIEBREAK_IDLE_POLLS = 6;
/** A hook-reported permission wait the pane has shown no dialog for, this
 *  long, is stale (the human answered in the terminal and no later hook
 *  cleared it). */
export const HOOK_NEEDS_INPUT_STALE_MS = 10_000;
export function thinkingLeaseMs(prompt: string | null | undefined): number {
  return (prompt ?? "").trimStart().startsWith("/") ? SLASH_THINKING_LEASE_MS : THINKING_LEASE_MS;
}

/** Bytes of tool output forwarded to the app per call. The relay accepts 256KB
 *  of base64 per sealed row; a card wants far less than that, and a `find`
 *  over a repo can be megabytes. Head + tail so both the command's start and
 *  its exit line survive the cut. */
export const TOOL_RESULT_MAX_CHARS = 48_000;

/** The text of a Claude `tool_result` — a string, or content blocks whose text
 *  parts are joined — clamped for the wire. undefined when there is nothing
 *  textual (an image-only result), so the record stays as it was. */
export function toolResultText(content: unknown): string | undefined {
  let text: string;
  if (typeof content === "string") text = content;
  else if (Array.isArray(content)) {
    text = (content as Array<Record<string, unknown>>)
      .map((b) => (b && typeof b.text === "string" ? b.text : ""))
      .filter(Boolean)
      .join("\n");
  } else return undefined;
  if (!text) return undefined;
  if (text.length <= TOOL_RESULT_MAX_CHARS) return text;
  const keep = Math.floor(TOOL_RESULT_MAX_CHARS / 2);
  const dropped = text.length - keep * 2;
  return `${text.slice(0, keep)}\n\n… [${dropped.toLocaleString("en-US")} characters truncated] …\n\n${text.slice(-keep)}`;
}

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
  // Collapse ALL whitespace runs (newlines, tabs, repeated spaces) to a single space and
  // trim — so a multi-line send still matches Claude's echo even if it normalizes/ trims
  // whitespace (e.g. drops a trailing blank line) differently than we typed it.
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Detect a background-task lifecycle event in a parsed transcript entry — the
 * SINGLE source of truth for both the live tail (#onTranscriptEntry) and the
 * derive-from-transcript reconcile (#deriveBgTasks), so the two can't drift.
 *   launch:   a tool result with backgroundTaskId (run_in_background bash) or
 *             { isAsync, agentId } (async Agent) — keyed by that id.
 *   complete: a <task-notification> user entry carrying the same id in <task-id>.
 * Mirrors the gating in #onTranscriptEntry (user role, non-meta).
 */
/** Completion from a <task-notification> payload — or null when it's a Monitor
 *  INTERIM event. Monitors notify on every matched event with the same
 *  <task-id> as their terminal notification; only terminal ones carry a
 *  <status> tag (completed/failed/killed). Payloads with no <status> at all
 *  are legacy shell-task notifications (always terminal) — except interim
 *  monitor events, recognizable by their "Monitor event:" summary. */
/**
 * A user-role entry Claude Code wrote ITSELF rather than the human — background
 * task completions (`<task-notification>`, promptSource "system", origin.kind
 * "task-notification") and kin. Never eligible as the 5xx auto-retry prompt
 * (#110). Exported for tests.
 */
export function isSystemPromptEntry(entry: Record<string, unknown>, content: string): boolean {
  if (entry.promptSource === "system") return true;
  const origin = entry.origin as Record<string, unknown> | undefined;
  if (origin && typeof origin.kind === "string" && /notification/i.test(origin.kind)) return true;
  return /^\s*<task-notification\b/.test(content);
}

function completionFromNotification(payload: string): { kind: "complete"; id: string } | null {
  const m = /<task-id>([^<]+)<\/task-id>/.exec(payload);
  if (!m) return null;
  if (!/<status>/.test(payload) && /<summary>\s*Monitor event:/i.test(payload)) {
    // A TIMEOUT rides the interim-event shape (no <status>, "Monitor event:"
    // summary) but is terminal — the monitor is dead ("re-arm if needed").
    // Without this, a timed-out monitor stays outstanding forever (fny agent2
    // stuck at "1/2 completed", 2026-07-09).
    if (/Monitor timed out/i.test(payload)) return { kind: "complete", id: m[1] };
    return null;
  }
  return { kind: "complete", id: m[1] };
}

export function bgTaskEvent(entry: any): { kind: "launch"; id: string; source: "agent" | "shell" } | { kind: "complete"; id: string } | null {
  // complete: newer Claude delivers the <task-notification> as an `attachment`
  // entry (attachment.prompt holds the payload, commandMode "task-notification"),
  // NOT a user message — this is the common case and the one the original
  // string-only check missed, leaving counts stuck. Check it first.
  const att = entry?.attachment as Record<string, unknown> | undefined;
  if (entry?.type === "attachment" && att && typeof att.prompt === "string" && att.prompt.includes("<task-notification>")) {
    return completionFromNotification(att.prompt);
  }
  // complete (THIRD delivery form): when Claude is busy at notification time,
  // the payload gets ENQUEUED into Claude's own message queue and the
  // transcript records a `queue-operation` entry with the notification in
  // `content` — no user message, no attachment. Sometimes that queue-operation
  // is the ONLY record of the completion (measured 15/494 on a real 22MB
  // session), and missing it left those tasks outstanding forever — which also
  // blocked the outstanding==0 batch reset, fusing every later batch into one
  // ever-growing stuck count (the "61/76 completed" ghost). Duplicate
  // completion events are harmless: classifyBgTasks only counts a completion
  // that removes a live outstanding id.
  if (entry?.type === "queue-operation" && typeof entry.content === "string" && entry.content.includes("<task-notification>")) {
    return completionFromNotification(entry.content);
  }
  const msg = entry?.message as Record<string, unknown> | undefined;
  if (!msg || String(msg.role || "") !== "user" || entry?.isMeta) return null;
  const content = msg.content;
  if (typeof content !== "string") {
    const tur = entry?.toolUseResult as Record<string, unknown> | undefined;
    if (tur && typeof tur.backgroundTaskId === "string") return { kind: "launch", id: tur.backgroundTaskId, source: "shell" };
    if (tur && tur.isAsync === true && typeof tur.agentId === "string") return { kind: "launch", id: tur.agentId, source: "agent" };
    // Monitor tool: result is {taskId, timeoutMs, persistent}. Counted like a
    // shell background task (teal N/M) — it runs in the background and DOES
    // terminate: stream-end/timeout emit a <status> notification, and an
    // explicit TaskStop hits the stop branch below. timeoutMs required so a
    // plain TaskCreate result (also taskId-shaped) can't masquerade as one.
    if (tur && typeof tur.taskId === "string" && typeof tur.timeoutMs === "number") {
      return { kind: "launch", id: tur.taskId, source: "shell" };
    }
    // TaskStop: an explicitly stopped task never gets a <task-notification>,
    // so treat the stop tool_result as its completion — otherwise a stopped
    // long-running process leaves joy__longRunning stuck forever (and a
    // stopped finishing task would wedge the N/M count the same way).
    if (tur && typeof tur.task_id === "string" && /stopped/i.test(String(tur.message ?? ""))) {
      return { kind: "complete", id: tur.task_id };
    }
    return null;
  }
  // Older transcripts delivered the notification as a plain user-message string.
  if (content.includes("<task-notification>")) {
    return completionFromNotification(content);
  }
  return null;
}

/**
 * The agent tags a long-running background process (server/daemon/persistent
 * watcher) in its own text: <joy-bg id="<backgroundTaskId>" long-running … />.
 * Returns the ids of every such tag in this entry (assistant text only), so the
 * task tracker can count them as long-running processes instead of finishing
 * tasks — they never "complete", so they must never sit in the N/M counter.
 */
/**
 * <joy-notify message="…" detail="…" /> — the agent's explicit "this is worth
 * a push". `message` is the headline (what happened: "Deploy finished"),
 * `detail` the substance ("staging green after 42m"). Renamed from title/
 * message — "title" invited project-title-shaped junk instead of content
 * (2026-07-05). Legacy title/message tags still parse (title→headline).
 * WHEN to emit is prompt-contract judgment, not an enum.
 */
export function joyNotifyEvents(entry: any): Array<{ headline: string; detail: string | null }> {
  const msg = entry?.message as Record<string, unknown> | undefined;
  if (!msg || String(msg.role || "") !== "assistant") return [];
  const c = msg.content;
  let text = "";
  if (typeof c === "string") text = c;
  else if (Array.isArray(c)) {
    for (const p of c) if (p?.type === "text" && typeof p.text === "string") text += "\n" + p.text;
  }
  if (!text.includes("<joy-notify")) return [];
  const out: Array<{ headline: string; detail: string | null }> = [];
  const tagRe = /<joy-notify\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(text))) {
    const attr = (name: string) => {
      const a = new RegExp(`\\b${name}="([^"]*)"`).exec(m![0]);
      return a?.[1].trim() || null;
    };
    const legacyTitle = attr("title");
    const message = attr("message");
    const detail = attr("detail");
    // New form: message=headline, detail=body. Legacy form: title=headline, message=body.
    const headline = legacyTitle ? legacyTitle : message;
    const body = legacyTitle ? message : detail;
    if (!headline) continue;
    out.push({ headline: headline.slice(0, 60), detail: body ? body.slice(0, 180) : null });
  }
  return out;
}

/**
 * <joy-title value="…" /> — the agent re-titles the session when its primary
 * focus genuinely shifts (prompt contract: major work changes only, 2-6
 * words). Fixes the stuck-title problem: Claude writes its ai-title off the
 * first message and never revisits, while sessions here live for days and
 * pivot constantly. A user-set title (/title) LOCKS the title against both
 * this tag and ai-title re-titles until a bare /title unlocks.
 */
export function joyTitleValue(entry: any): string | null {
  const msg = entry?.message as Record<string, unknown> | undefined;
  if (!msg || String(msg.role || "") !== "assistant") return null;
  const c = msg.content;
  let text = "";
  if (typeof c === "string") text = c;
  else if (Array.isArray(c)) {
    for (const p of c) if (p?.type === "text" && typeof p.text === "string") text += "\n" + p.text;
  }
  if (!text.includes("<joy-title")) return null;
  const m = /<joy-title\b[^>]*\bvalue="([^"]+)"[^>]*>/i.exec(text);
  return m?.[1].trim() ? m[1].trim().slice(0, 60) : null;
}

export function joyBgLongRunningIds(entry: any): string[] {
  const msg = entry?.message as Record<string, unknown> | undefined;
  if (!msg || String(msg.role || "") !== "assistant") return [];
  const c = msg.content;
  let text = "";
  if (typeof c === "string") text = c;
  else if (Array.isArray(c)) {
    for (const p of c) if (p?.type === "text" && typeof p.text === "string") text += "\n" + p.text;
  }
  if (!text.includes("<joy-bg")) return [];
  const ids: string[] = [];
  const tagRe = /<joy-bg\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(text))) {
    if (!/\blong-running\b/i.test(m[0])) continue;
    const idm = /\bid="([^"]+)"/.exec(m[0]);
    if (idm) ids.push(idm[1]);
  }
  return ids;
}

/**
 * Replay ordered background-task events, splitting into FINISHING tasks (the N/M
 * counter, reset-on-empty-batch semantics) and LONG-RUNNING processes (ids in
 * `lrIds` — the agent's <joy-bg long-running> tags). A long-running launch is
 * counted only in `longRunning` (never the N/M, so it can't stick at 0/1); its
 * completion (server stopped) clears it. `lrIds` is the FULL set gathered up
 * front, so a launch is classified correctly even when its tag lands later.
 */
export interface BgGroup { outstanding: Set<string>; total: number; done: number; }

/** A launch (optionally timestamped) or a completion. */
export type BgEvent =
  | { kind: "launch"; id: string; source: "agent" | "shell"; atMs?: number }
  | { kind: "complete"; id: string };

/**
 * How long a launch may sit with no completion before it stops being counted.
 * A background agent or shell that has been "running" for six hours is not
 * running: its completion notification was lost (a compaction that dropped the
 * <task-notification>, a daemon restart mid-flight, an interrupted turn). The
 * derivation reads the WHOLE transcript, so without a bound one lost
 * notification pins the counter for the life of the session — and a stuck
 * count also suppresses the turn-done push ("done push skipped (bgTasks=1)").
 * One such launch from 2026-09-02 held a session at "agents 0/1" for 30 hours.
 */
export const BG_LAUNCH_TTL_MS = 6 * 60 * 60_000;

export function classifyBgTasks(
  events: BgEvent[],
  lrIds: Set<string>,
  nowMs: number = Date.now(),
): { shell: BgGroup; agent: BgGroup; longRunning: Set<string>; outstanding: Set<string>; total: number; done: number } {
  // Drop launches that aged out with no completion BEFORE classifying, so the
  // per-group batch accounting in step() never sees them. Un-timestamped
  // launches (live-tail events from before this ran) never age out.
  const completed = new Set(events.filter((e) => e.kind === "complete").map((e) => e.id));
  events = events.filter((e) => !(
    e.kind === "launch" && e.atMs !== undefined
    && !completed.has(e.id) && nowMs - e.atMs > BG_LAUNCH_TTL_MS
  ));
  const shell: BgGroup = { outstanding: new Set(), total: 0, done: 0 };
  const agent: BgGroup = { outstanding: new Set(), total: 0, done: 0 };
  const longRunning = new Set<string>();
  const step = (g: BgGroup, id: string) => {
    if (g.outstanding.has(id)) return;
    if (g.outstanding.size === 0) { g.total = 0; g.done = 0; } // fresh batch, per group
    g.outstanding.add(id); g.total++;
  };
  for (const ev of events) {
    if (ev.kind === "launch") {
      if (lrIds.has(ev.id)) { longRunning.add(ev.id); continue; }
      step(ev.source === "agent" ? agent : shell, ev.id);
    } else {
      if (longRunning.delete(ev.id)) continue;   // a tagged server was stopped
      if (agent.outstanding.delete(ev.id)) { agent.done++; continue; }
      if (shell.outstanding.delete(ev.id)) { shell.done++; }
    }
  }
  // Combined view for the union-based busy()/self-heal checks.
  const outstanding = new Set([...shell.outstanding, ...agent.outstanding]);
  return { shell, agent, longRunning, outstanding, total: shell.total + agent.total, done: shell.done + agent.done };
}

/**
 * Detect a Claude `/goal` status in a transcript entry. Claude emits an
 * `attachment` entry `{ type:'attachment', attachment:{ type:'goal_status',
 * met, sentinel, condition } }`. The goal is ACTIVE while met=false; met=true
 * means it was satisfied/cleared. Returns the condition + met, or null.
 */
export function goalStatusFromEntry(entry: any): { condition: string; met: boolean } | null {
  if (entry?.type !== "attachment") return null;
  const att = entry.attachment as Record<string, unknown> | undefined;
  if (!att || att.type !== "goal_status" || typeof att.met !== "boolean") return null;
  return { condition: typeof att.condition === "string" ? att.condition : "", met: att.met };
}

/** Slim wire shape pushed to the app (joy__queue) and returned by queue ops. */
export interface QueuedMessage {
  id: string;
  text: string;
  createdAt: number;
  /** For a handled /joy-prompt: the queue id of the instruction reinjection it
   *  enqueued, so a lane whose relay turn is cancelled can pluck it (#77). */
  reinjectionId?: string;
  /** Set when enqueue HANDLED the text itself (a joy-owned slash command) and
   *  queued nothing — the returned id is synthetic and will never be delivered.
   *  A caller that owns a relay turn must terminalize it instead of waiting for
   *  a dispatch that is never coming: seen live 2026-09-03, a command-send left
   *  a turn parked in the lane's start gate until unrelated activity flipped
   *  busy(), then held the session's execution slot with every later message
   *  queued behind it. */
  handled?: "command";
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
  /** In-memory only. Set once this dispatch's user bubble was mirrored to the
   *  relay, so the hook-confirm and the delayed-Enter paths mirror it exactly
   *  once between them (#483). */
  mirrored?: boolean;
  /** In-memory only. The runtime took this dispatch (a confirm path settled
   *  it) — the delayed-Enter callback still mirrors it exactly once (#483). */
  delivered?: boolean;
  /** In-memory only. The coordinator's attempt for this dispatch and the
   *  runtime ref (flattened text) its echo is matched on. */
  attemptId?: string;
  runtimeRef?: string;
}

/** Delivery outcome of ONE queued item, by id. The v2 lane needs proof that
 *  THIS prompt reached the agent; `busy()` cannot give it (for claude busy() is
 *  true from enqueue onward, so a turn could report started AND completed off a
 *  previous turn's flag while its own prompt was never typed — silent loss,
 *  observed live 2026-09-03). "unknown" = no record (e.g. after a restart), and
 *  the caller falls back to its heuristic. */
export type QueueItemState = "pending" | "delivered" | "cancelled" | "failed" | "unknown";

export interface QueueState {
  queue: QueuedMessage[];
  /** ALL undelivered items (visible chips + hidden app-sends + the in-flight
   *  dispatch) — the app's "N queued" indicator. Hidden items have chat
   *  bubbles instead of chips, but without this count the user had zero
   *  feedback that rapid sends were being held ("I don't see queuing"). */
  pendingCount: number;
  /** Hidden (app-sent) queued items, exposed so the app can offer
   *  cancel/edit-as-draft on them — "I want to edit them if I change my
   *  mind". Their delivery text can't be edited in place (the message is
   *  already an immutable server row), so the app's edit flow is
   *  cancel-here + move the text into its on-device drafts. */
  hidden: QueuedMessage[];
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
  /** Per-session tmux driver handle; absent → the shared singleton (legacy). */
  tmux?: TmuxDriver;
  /** Per-session server socket label; set → teardown uses kill-server. */
  tmuxSocket?: string | null;
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
  /** Cap the --continue backfill to ~this many bytes, applied when the transcript
   *  BINDS (continue's file isn't known at create, unlike --resume). 0 = uncapped. */
  backfillCapBytes?: number;
  /** The launch identity exported to this claude as JOY_LAUNCH_ID (window
   *  record `hookLaunchId`): hook events must echo it as launch_id. Absent for
   *  launches that predate it — those accept events without one. */
  hookLaunchId?: string;
}

export class Session {
  readonly agentFlavor = "claude" as const;
  readonly id: string;
  readonly tmuxWindow: string;
  readonly #tmux: TmuxDriver;
  readonly #tmuxSocket: string | null;
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
  #transcriptPollActive = false;
  #turn: { turnId: string; since: number } | null = null;
  // Last "thinking" value pushed to the relay. The pane poll (#pollThinking)
  // reconciles this against the live pane so the app's status matches the
  // window; the event-driven setters below give instant feedback in between.
  #thinking = false;
  // Outstanding background tasks (run_in_background bash + background agents),
  // keyed by Claude's backgroundTaskId, derived from the transcript. Keeps the
  // session "working" with an N/M count until they finish — survives turn-end,
  // unlike the pane-footer poll which flickers idle for ~3s at turn-end.
  #bgTasks = new Set<string>();
  // Incremental transcript scan backing #deriveBgTasks/#reconcileGoal — see
  // #deriveBgTasks for semantics (append-only parse from a byte offset).
  #scan: {
    path: string; offset: number;
    events: BgEvent[];
    lrIds: Set<string>;
    lastGoal: { condition: string; met: boolean; atMs: number } | null;
  } | null = null;
  // Long-running processes (servers/daemons the agent tagged <joy-bg long-running>).
  // Counted separately (joy__longRunning) and never in the N/M — they don't finish.
  #longRunning = new Set<string>();
  // Finishing-task ids cancelled by an abort. An interrupted turn never writes the
  // task's completion, so #deriveBgTasks would keep it "outstanding" forever and
  // the N/M counter would stick; these ids are filtered out of the derivation so
  // Stop clears the count. Task ids are unique per launch, so this never suppresses
  // a later real task.
  // Last pushed {tasks, longRunning} as a string key — dedups reconcile pushes by
  // DESIRED state (not this.metadata, which can lag a pending write and drop a clear).
  #lastBgKey: string | null = null;
  // Turn ids that already fired a "done" push — one notification per turn, no
  // matter how many times its transcript entry is re-read (replay, backfill).
  #notifiedTurns = new Set<string>();
  // Coalesces task-count pushes (see #scheduleTaskReconcile). Transcript backfill on recovery
  // replays a whole batch's launches+completions in milliseconds — pushing each
  // (0/3,1/3,2/3,null) as a separate metadata RPC let an intermediate value win
  // and the final `null` lose under restart contention, leaving a stuck "2/3".
  #tasksPushTimer: ReturnType<typeof setTimeout> | null = null;
  // Low-frequency self-heal: while a background-task count is outstanding,
  // periodically re-derive it from the transcript so an orphaned/stuck count
  // (a missed completion, a lost push) clears itself without a daemon restart.
  // Gated on an outstanding count, so idle sessions do zero work.
  #taskReconcileTimer: ReturnType<typeof setInterval> | null = null;
  // The agent's active /goal (null when none / met / cleared). Surfaced as
  // joy__goal so the app can show a goal bar.
  #goal: JoyGoalInfo | null = null;
  // Interactive auth/login URL the CLI is showing in its pane (null when none).
  // When the 401 login-needed note last fired (0 = never) — one per
  // 5-minute episode (see the api_error handler).
  #autoLoginAt = 0;
  // Surfaced as joy__login so the app can show a login bar. #loginUrlPending
  // debounces detection: a URL must persist across two polls before we push it.
  #login: JoyLoginInfo | null = null;
  #loginUrlPending: string | null = null;
  /** Latch for the auto-Enter on "Login successful. Press Enter to continue". */
  #loginContinuePressed = false;
  // Interactive CLI dialog (model picker / switch confirm / effort slider…)
  // currently occupying the pane — surfaced as joy__dialog ("answer this in
  // the terminal"). Same two-poll debounce contract as #login.
  #dialog: JoyDialogInfo | null = null;
  #dialogKey: string | null = null;
  #dialogPendingKey: string | null = null;
  // Distinct-dialog observation tracking (undebounced): key of the dialog
  // currently on the pane and when it was FIRST sighted — drives the causal
  // guard for dispatch confirmation, which must not wait for the debounce.
  #dialogObservedKey: string | null = null;
  #dialogFirstSeenAt = 0;
  // Consecutive #pollEnd passes where ONLY a pane dialog vouched for liveness
  // (no live pid, no running markers) — bounded grace, see #pollEnd.
  /** Consecutive #pollEnd passes with a dead pid and no child under the pane shell — pane text alone keeps the session alive for at most 12 of these. */
  #noProcessPasses = 0;
  // The archived-card publish fired when this session is killed — awaited by
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
  // Report the context tokens used (cumulative usage: input + cache-read +
  // cache-create) from the turn's final usage. The app owns the window/threshold;
  // we only send the raw count.
  #pushContextUsage(): void {
    const u = this.#turnUsage;
    if (!u || !this.#relay) return;
    const n = (k: string) => (typeof u[k] === "number" ? (u[k] as number) : 0);
    const used = n("input_tokens") + n("cache_read_input_tokens") + n("cache_creation_input_tokens");
    if (used > 0) void this.#relay.updateContext(used);
  }
  // 500-error auto-retry. #turn5xxStatus holds the last 5xx status seen in the
  // current turn; it's cleared the moment Claude produces real output (recovery)
  // and consumed on turn-end — if a turn ENDS with it still set, Claude gave up
  // on a server error, so we re-send the failed prompt (#lastUserText) on
  // RETRY_SCHEDULE_SEC. #retry holds the live backoff timer + attempt count.
  #retry: { attempts: number; timer: ReturnType<typeof setTimeout> | null } | null = null;
  // Last pane-derived retry banner key (`status:attempt/total`) we published —
  // the CLI's own API-retry spinner parsed from the pane (retryFromPane), the
  // only 529/overload signal since api_error transcript entries disappeared.
  #paneRetryKey: string | null = null;
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
  // --continue backfill cap (bytes). Unlike --resume the file isn't known at
  // create, so the cap is applied ONCE when the transcript binds (startTailer).
  #backfillCapBytes = 0;
  // The durable acceptance ledger: every queue mutation, dispatch attempt,
  // echo receipt and forwarded-uuid receipt lives there (domain/ledger.ts).
  // `#generation` fences this object's writes: after a restart the same id
  // belongs to the replacement and a late write from here is refused (#481).
  #ledger: Ledger;
  #generation: number;
  // Positive cache in front of ledger.hasReceipt for transcript uuids this
  // process already handled (bounded; the ledger is the truth).
  #uuidSeen = new Set<string>();
  // The most recent `!cmd` command, captured from <bash-input> so it can head
  // the bash-output card.
  #pendingBashCmd?: string;
  #trustHandled = false;

  // ── Hook authority (spike Wave F, candidate A, step one) ───────────────────
  // True once ANY hook event from THIS session's claude process reached the
  // daemon. Hooks are best-effort (hooks.ts): before the latch flips, the pane
  // rules stay in force unchanged; after it, hooks are the AUTHORITY for the
  // states they observe (turn live/idle, permission mode, exit, auth failure,
  // waiting-for-input, "my prompt landed") and the pane is a tie-breaker for
  // those. The latch never clears: one hook proves the forwarder is installed
  // for this process, a later gap is a missed EDGE — and the transcript stays
  // the durable fallback for every edge. The pane remains the ONLY source for
  // what hooks cannot see: draft text, dialogs, the login form, the shells
  // footer (docs/review-campaign-2026-09-claude-runtime-spike.md §3 A).
  #hooksLive = false;
  #hooksLiveAt = 0;
  /** The per-launch identity (see SessionInit.hookLaunchId) — THE ingress
   *  fence: a hook event that does not echo it is another process's (the
   *  retired predecessor under this route id, whose conversation id a
   *  --resume replacement even shares) and must change nothing here. */
  readonly #launchId: string | null;
  /** permission_mode from the most recent hook that carried one. */
  #hookPermissionMode: string | null = null;
  #hookPermissionModeAt = 0;
  /** What the window record currently says (undefined = not loaded yet), so a
   *  hook's mode is persisted only on change — PostToolUse fires per tool. */
  #persistedPermissionMode: string | null | undefined = undefined;
  /** setPermissionMode's last target — verified (or corrected) by the next
   *  hook that reports a mode, since no hook fires on Shift+Tab itself. */
  #modeSetTarget: { mode: string; at: number } | null = null;
  /** SessionEnd with an exit-class end_reason: teardown is confirmed by the
   *  pid dying within the grace, never by the hook alone (restart race). */
  #hookSessionEnd: { reason: string; at: number } | null = null;
  #hookSessionEndTimer: ReturnType<typeof setTimeout> | null = null;
  /** StopFailure(authentication_failed) opened an auth episode; closed by
   *  Notification(auth_success) or a fresh SessionStart. With hooks live,
   *  /login-code types only inside an episode (or a surfaced login form). */
  #authFailure: { errorType: string; since: number } | null = null;
  /** Hook-reported waiting-for-input: a permission prompt (PermissionRequest /
   *  Notification permission_prompt), an elicitation, agent_needs_input. Not
   *  idle_prompt — that is plain idleness, not a question. */
  #needsInput: { kind: string; tool?: string; since: number; agent?: string } | null = null;
  /** `since` of the needs-input episode a "permission" push already went out
   *  for — one push per episode, whichever hook opened it. */
  #needsInputPushedFor = 0;
  /** First poll at which a hook-reported permission wait was NOT on the pane
   *  (0 = seen on the last poll, or nothing to track). The pane tie-breaker
   *  clears the wait only after the dialog has been ABSENT this long — not
   *  after the wait is merely old (#reconcileDialog). */
  #needsInputAbsentSince = 0;
  /** The hook-reported TURN edge — the runtime's own turn state, separate from
   *  the transcript's #turn bookkeeping (which stays open until the tailer
   *  reaches turn_duration). null until a hook has said either way. With
   *  hooks live the dispatch/clear gates and busy() consume THIS (see
   *  #turnRunning / #hookSaysIdle); the transcript's #turn is then output-
   *  drain bookkeeping, and the pane's generating footer a safety check only. */
  #hookTurn: { open: boolean; at: number } | null = null;

  // ── Dispatch ───────────────────────────────────────────────────────────────
  // The queue itself is the session coordinator's (domain/coordinator.ts):
  // EVERY app→Claude text — relay app-send, HTTP/RPC /send, explicit
  // queue-add, 5xx auto-retry — is a ledger row it owns, and this session is
  // the claude DRIVER (claudeDriver.ts): it dispatches ONE command at a time
  // through the pane gate (nothing types until Claude is genuinely idle AND
  // the input box is empty), and reports the runtime's verdict back.
  #coordinator: SessionCoordinator;
  #driver: ClaudeDriver;
  #unsubscribeQueue: () => void = () => {};
  // The message typed-but-not-yet-confirmed. Nothing else dispatches until
  // Claude proves it took it (echo confirmation) or the echo window closes.
  // Holds the whole item so every confirm path can name it.
  #dispatchInFlight: QueuedItem | null = null;
  // Resolves the driver's submit for the in-flight item with the runtime's
  // verdict (#settleDispatch); the dispatch loop waits on it.
  #dispatchSettle: ((r: SubmitResult) => void) | null = null;
  // Wakes the dispatch loop's gate wait early (turn end, resume, a steer
  // releasing the pane) instead of waiting out its retry delay.
  #gateWake: (() => void) | null = null;
  // The runtime ref (flattened text) of the last dispatch the runtime took —
  // a transcript turn-start right after it is that command's, not a foreign
  // turn; cleared at turn end.
  #lastConfirmedRef: string | null = null;
  #dispatchTimer: ReturnType<typeof setTimeout> | null = null;
  // How many times the current dispatch's echo timeout has been EXTENDED because
  // Claude is visibly working (slow turn-start on a huge context) — bounded so a
  // genuinely-lost dispatch still surfaces. Reset on confirm / requeue.
  #dispatchExtends = 0;
  // When the current in-flight dispatch typed + submitted (epoch ms) — the
  // causal guard for dialog-based delivery confirmation.
  #dispatchSubmittedAt: number | null = null;
  // Last #noteHold line (throttle clock) — see #noteHold.
  #holdLoggedAt = 0;
  // A human-typed draft captured from the input box right before a dispatch-
  // driven clear wiped it (drain gate / steer). Restored — typed back, never
  // submitted — once the queue is idle again, so text someone typed directly
  // into the pane survives an app send instead of being destroyed by it.
  // Flattened to one line (paneInputText collapses newlines). In-memory only.
  #preservedDraft: string | null = null;
  // User-set title lock (see joyTitleValue / windowRecord.titleLockedByUser).
  #titleLocked = false;
  // Last ai-title VALUE seen from the transcript. Claude re-emits its (often
  // ancient) ai-title verbatim on every resume without re-generating it — a
  // repeat carries no new information and must not stomp a fresher agent
  // (<joy-title>) title. Only a genuinely NEW ai-title value applies.
  // PERSISTED (windowRecord.lastAiTitle): held only in memory, this reset on
  // every restart, so the replay saw the stale value as new and stomped the
  // title right back — the "title is stuck" report of 2026-09-03.
  #lastAiTitle: string | null = null;
  // The pending delayed-Enter (submit) for a just-typed message. Cancellable so an
  // abort/kill/confirm/timeout in the settle window can't let a stale Enter fire
  // into the pane (re-submitting an aborted message, or submitting into a turn).
  #submitTimer: ReturnType<typeof setTimeout> | null = null;
  // Pending delayed-Enter for a /steer send — separate from #submitTimer so steering
  // (which submits mid-turn) and the dispatch submit don't cancel each other.
  #steerSubmitTimer: (ReturnType<typeof setTimeout> & { onSuperseded?: () => void; text?: string }) | null = null;
  // The PANE-WRITER LEASE (#34/#476): the identity of the writer that owns the
  // input box right now — a /steer from its call until its Enter lands, or a
  // draft restore from its capture to its type. The drain pump, the dirty-clear
  // and the draft restore all stand down while it is held: they used to run
  // concurrently with a steer, so a drain retry that captured the box mid-steer
  // read the steered text as a stray human draft, C-u'd it away, and the
  // steer's Enter then submitted an empty box while the receipt/mirror recorded
  // it as sent. It carries an IDENTITY, not a flag: a steer superseded by a
  // newer one releases nothing when it settles — the shared flag it used to
  // clear in its finally let the drain type a queued prompt while the newer
  // steer was still in its capture (#34, review residual).
  #paneOwner: symbol | null = null;
  // The exclusive capture→type section of the current pane writer (a steer or
  // a draft restore), awaited by the next writer so two never interleave in
  // the box — a steer arriving while an earlier one is still typing waits for
  // that type to finish before it captures, clears and supersedes it.
  #paneSection: Promise<void> | null = null;
  // The in-progress dispatch's capture→type section, awaited by #steer and
  // the draft restore so their capture never interleaves with a pass that is
  // between "captured empty" and "typed".
  #drainDone: Promise<void> | null = null;

  /** Clear a pending steer submit AND settle its awaiting promise — a
   *  superseded steer's caller must not hang (its text was deliberately
   *  replaced; the newer steer owns delivery). Returns the superseded steer's
   *  text (still sitting in the box) so the superseding steer can clear it
   *  without preserving it as a human draft. */
  #cancelSteerSubmit(): string | null {
    if (this.#steerSubmitTimer) {
      const text = this.#steerSubmitTimer.text ?? null;
      clearTimeout(this.#steerSubmitTimer);
      this.#steerSubmitTimer.onSuperseded?.();
      this.#steerSubmitTimer = null;
      return text;
    }
    return null;
  }
  // Count of FAILED clear episodes (C-u loop ran, box still dirty) for the current
  // drain: two failed episodes spaced 750ms → pause with the input_dirty banner.
  // Reset once the box is empty / on dispatch / when the pane isn't ready.
  #clearAttempts = 0;
  // Set when a dispatch failed to land (no turn started) or the input box is
  // dirty and unclearable — stops auto-draining so we don't shovel messages into
  // a wedged/odd state. Cleared by resume. #pauseReason says why (for the app).
  #queuePaused = false;
  #pauseReason: QueuePauseReason | undefined;
  // Self-heal probe for an input_dirty pause (see #recheckDirtyPause).
  #dirtyRecheckTimer: ReturnType<typeof setTimeout> | null = null;
  #dirtyRecheckAttempts = 0;

  constructor(init: SessionInit, deps: SessionDeps) {
    this.id = init.id;
    this.tmuxWindow = init.tmuxWindow;
    this.#tmux = init.tmux ?? defaultTmux;
    this.#tmuxSocket = init.tmuxSocket ?? null;
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
    this.#backfillCapBytes = init.backfillCapBytes ?? 0;
    this.#launchId = init.hookLaunchId ?? null;
    // Title lock survives restarts via the window record.
    const rec = loadWindowRecord(this.id);
    this.#titleLocked = rec?.titleLockedByUser === true;
    // The locked title comes back WITH the lock (#474): a replacement that
    // restored only the lock had no summary of its own, so its card kept the
    // transcript's old ai-title and the user's title was lost.
    if (this.#titleLocked && rec?.userTitle) this.summary = rec.userTitle;
    // No persisted value = first run since this became durable. Seed from the
    // transcript's CURRENT ai-title so the replay treats it as already-seen
    // rather than "new" — otherwise the first restart after the upgrade stomps
    // the title one last time. A genuinely new ai-title later still applies.
    this.#lastAiTitle = rec?.lastAiTitle ?? this.#readLatestAiTitle();
    if (!rec?.lastAiTitle && this.#lastAiTitle) {
      saveWindowRecord(this.id, { lastAiTitle: this.#lastAiTitle });
    }
    this.#deps = deps;
    this.#ledger = deps.ledger ?? ledgerFor();
    // A new generation per object: the previous one (a crashed daemon's, or
    // the retired object's) closes and its in-flight dispatches become an
    // explicit `unknown` — Claude re-dispatches those, as it always has (a
    // typed-but-unconfirmed prompt is retyped; a late echo of the first
    // typing still matches its attempt and is not mirrored as a duplicate).
    this.#generation = this.#ledger.openGeneration(this.id, "claude");
    // The coordinator owns the queue rows a previous daemon left (B1): they
    // dispatch on the first idle exactly like freshly queued messages; a
    // dispatch it left mid-flight is reconciled once this driver is ready.
    this.#coordinator = deps.coordinator ?? coordinatorFor(this.#ledger);
    this.#driver = new ClaudeDriver(this.#runtimePort(), this.#generation);
    this.#coordinator.adopt(this.id, this.#driver);
    this.#unsubscribeQueue = this.#coordinator.subscribe((ev) => {
      if (ev.type === "command" && ev.sessionId === this.id) this.#onCommandEvent(ev.commandId, ev.state);
      if ((ev.type === "session" || ev.type === "command") && ev.sessionId === this.id) this.#broadcastQueue();
    });
    const restored = this.status !== "ended" ? this.#ledger.listPending(this.id).length : 0;
    if (restored) process.stderr.write(`[queue-store] ${this.id}: ${restored} undelivered item(s) in the ledger await this generation\n`);
    // The driver is ready from construction: the pane gate inside every
    // dispatch decides the real readiness (a "starting" session types its
    // first prompt to bootstrap the transcript). A dispatch the previous
    // generation left unconfirmed is reconciled when `ready` lands — give the
    // transcript replay a beat to pair its echo first (then it is already
    // running, never retyped).
    if (this.status !== "ended") {
      const unknown = this.#ledger.listPending(this.id, ["unknown"]).length > 0;
      if (!unknown) this.#driver.emit({ kind: "ready" });
      else setTimeout(() => { if (this.status !== "ended") this.#driver.emit({ kind: "ready" }); }, 2_000).unref?.();
    }
  }

  /** What the driver reads from / does through this session. */
  #runtimePort() {
    return {
      sessionId: this.id,
      awaitGate: (cmd: CommandView, signal: AbortSignal) => this.#awaitGate(cmd, signal),
      dispatch: (cmd: CommandView, attempt: AttemptRef, signal: AbortSignal) => this.#dispatchOne(cmd, attempt, signal),
      steer: (cmd: CommandView, attempt: AttemptRef, signal: AbortSignal) => this.#steer(cmd, attempt, signal),
      interrupt: () => this.#interruptPane(),
      runtimeRef: (text: string) => flattenForMatch(text),
      handleCommand: (text: string, opts: { source: string; mirrorToRelay: boolean; seq?: number | null }) => this.#handleCommand(text, opts),
      resume: () => this.resumeQueue(),
    };
  }

  /** A cancel that lands on the in-flight dispatch (#35): typed with its
   *  Enter still pending → drop the Enter and discard it (the text stays in
   *  the box until the next gate clears it — docs/pane-input-clearing.md);
   *  Enter already out → settle the submit as accepted so the coordinator's
   *  interrupt (Escape) proceeds without waiting out the echo window. */
  #onCommandEvent(commandId: string, state: string): void {
    const inflight = this.#dispatchInFlight;
    if (state !== "cancelling" || !inflight || inflight.id !== commandId) return;
    this.#dispatchCancelledAt = Date.now();
    if (this.#dispatchSubmittedAt === null) {
      this.#clearSubmitTimer();
      this.#dlog(`cancelled ${commandId} before its submit landed`);
      this.#settleDispatch("cancel before submit", { kind: "rejected", permanent: false, detail: "cancelled before submit" });
    } else {
      this.#settleDispatch("cancel after submit", { kind: "accepted" }, { echo: false });
    }
  }

  /** When a cancel last settled the in-flight dispatch: a Stop right after
   *  must still send Escape (the typed text / a fired Enter may be in the
   *  pane) instead of reading the box as unambiguously idle. */
  #dispatchCancelledAt = 0;

  /** Test/diagnostic access to the coordinator this session is adopted by. */
  get coordinator(): SessionCoordinator { return this.#coordinator; }

  /** Test/diagnostic access to the session's ledger generation. */
  get ledgerGeneration(): number { return this.#generation; }

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
      agent: "claude",
      claude_session_id: this.claudeSessionId,
      pid: this.pid,
      tmux_window: this.tmuxWindow,
      tmux_socket: this.#tmuxSocket,
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
      busy: this.busy(),
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
    const pane = this.#tmux.captureCached(this.tmuxWindow);
    if (pane.ok && paneShowsClaudeRunning(pane.out)) return; // Claude is visibly up
    // An open dialog hides all "running" markers but IS a live claude — e.g. a
    // /model dispatched into a still-starting session (no transcript exists
    // until the dialog resolves, so status stays 'starting' past the deadline).
    if (pane.ok && dialogFromPane(pane.out) != null) return;
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
   *
   * The option ORDER is not stable across claude versions — current builds list
   * "No, exit" first — so never hard-code a digit: a blind "1" answers *no* and
   * the daemon kills the very session it just spawned (the pane drops back to a
   * shell and every dispatch queues forever). Locate the trust line in the
   * rendered menu and drive the cursor to it instead.
   */
  #watchTrustPrompt(attempts = 0): void {
    if (this.status === "ended" || this.status === "active" || this.#trustHandled) return;
    const pane = this.#tmux.captureCached(this.tmuxWindow);
    if (pane.ok && /Yes, I trust this folder|Is this a project you (created|trust)/i.test(pane.out)) {
      const keys = trustPromptKeys(pane.out);
      if (keys) {
        void this.#tmux.key(this.tmuxWindow, ...keys); // fire-and-forget (sync watcher)
        this.#trustHandled = true;
        return;
      }
      // Prompt text matched but the menu hasn't painted its options yet — keep
      // polling rather than guessing at a selection.
    }
    if (attempts < 60) setTimeout(() => this.#watchTrustPrompt(attempts + 1), 700);
  }

  /**
   * Wire a relay session (the session card): banner reconciles, receipt sink,
   * the attach hook. The ONE wiring path — used by launch and recovery alike.
   * Returns false (and stops the relay session) if this session already ended,
   * guarding against kill racing the async relay creation.
   */
  attachRelay(rs: RelaySession, allowEnded = false): boolean {
    // Normally refuse an ended session (guards a kill racing async relay
    // creation). Recovery passes allowEnded so a finished session's card
    // (detached state, title) is still published.
    if (this.status === "ended" && !allowEnded) {
      rs.stop();
      return false;
    }
    // A detached session (ended, window still around) keeps its card published
    // with joy__state='detached', which the app renders red — distinct from
    // "daemon gone" (machine presence lapses → offline).
    if (this.status === "ended") rs.pausePull();
    this.#relay = rs;
    this.relaySessionId = rs.relaySessionId;

    // Reconcile a stale retry banner. If the card says we were retrying but no
    // retry is live in memory, clear it. That's the daemon-restart case:
    // recover() rebuilds the Session with #retry=null, but joy__retry persisted
    // on the relay's card, so the app would otherwise show a stuck
    // "retrying N/…". (Idempotent — no-op if unset.)
    if (!this.#retry) void rs.updateRetry(null);
    // Same reconcile for a stale persisted thinking flag (see clearThinkingMeta).
    if (!this.#thinking) void rs.clearThinkingMeta();
    // Same reconcile for a stale login bar: #reconcileLogin only clears
    // joy__login when the in-memory #login flag is set, so a daemon restart
    // while the bar was up (fresh #login=null, URL gone from the pane) left it
    // stuck server-side forever. updateLogin(null) no-ops when already clear.
    if (!this.#login) void rs.updateLogin(null);
    // Same for a stale dialog banner (daemon restart while a dialog was up).
    if (!this.#dialog) void rs.updateDialog(null);
    // Same reconcile for the compacting banner: a daemon restart mid-compaction
    // rebuilds the Session with #compacting=null while joy__compacting persisted
    // server-side. The in-memory backstop timer is also gone, so without this the
    // banner could stick until the next compaction. (Idempotent — no-op if unset.)
    if (!this.#compacting) void rs.updateCompacting(null);
    // Reconcile the background-task count against the transcript (the truth),
    // not a blanket clear: after a daemon restart #bgTasks is rebuilt empty
    // while joy__tasks persisted server-side, so re-derive the real outstanding
    // set — this both clears orphans AND preserves a genuinely still-running
    // task's count (which a blanket clear would have wrongly dropped). Runs on
    // every (re)attach — recovery and plain reconnect both heal.
    // Clear the dedup key first so this (re)attach always re-pushes, even if the
    // desired state is unchanged but the server-side metadata drifted while detached.
    this.#lastBgKey = null;
    this.#reconcileBgTasks();
    // Re-derive the active /goal from the transcript (restart/reconnect safe).
    this.#reconcileGoal();
    // Low-frequency self-heal while a count is outstanding, so a stuck count
    // clears without waiting for a restart/reconnect (no-op when none outstanding).
    if (this.#taskReconcileTimer) clearInterval(this.#taskReconcileTimer);
    // Not for ended sessions (recovery attaches relays to those for file/git
    // RPCs): end() already ran and can never run again, so an interval armed
    // here would leak — ticking for the daemon's lifetime and pinning the
    // Session + RelaySession.
    if (this.status !== "ended") {
      this.#taskReconcileTimer = setInterval(() => {
        if (this.status === "ended" || (this.#bgTasks.size === 0 && this.#longRunning.size === 0)) return;
        this.#reconcileBgTasks();
      }, 60_000);
    }
    // Reflect the current queue on (re)attach — recovery/reconnect included.
    void rs.updateQueue(this.#coordinator.snapshot(this.id));
    // Receipts are written ON SERVER ACK now (codex review finding 1): the
    // relay stamps each transcript entry's receipt on its group's last row
    // and calls back here once that row is durably appended. Registered
    // before anything below can queue rows, and it flushes acks buffered
    // from a restart drain that outran this attach.
    rs.setReceiptSink((r) => { this.#noteUuid(r.uuid); });
    // Reconcile the model mirror. A model change seen while no relay was
    // attached (daemon-restart replay) sets currentModel WITHOUT mirroring it,
    // and the change-gate means it never re-fires for the same model — the app
    // then shows the stale model forever ("opus yolo" while the pane ran
    // fable, 2026-07-08). updateModelCode no-ops when already in sync.
    if (this.currentModel) void rs.updateModelCode(this.currentModel);

    this.#deps.onRelayAttached?.(this, rs);
    rs.start();
    this.#deps.broadcast("session_update", this.toJSON());

    // Push the existing conversation title on attach. On recovery the tailer
    // runs before the relay exists, so the ai-title entry it sees can't be
    // forwarded — read the latest one straight from the transcript here.
    // NOT when the user locked the title and this instance has no summary of
    // its own (a restart/recovery replacement): the transcript's ai-title is
    // exactly the title the lock exists to suppress, and publishing it here
    // stomped the user's `/title` while the lock stayed active — the relay
    // card already holds the user's title, so leave it alone (#474).
    const title = this.summary ?? (this.#titleLocked ? null : this.#readLatestAiTitle());
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
  end(reason: "killed" | "process_exited" | "restart"): boolean {
    if (this.status === "ended") return false;

    this.#tailer?.close();
    this.#tailer = null;
    this.#closeOpenTools(); // before the relay detaches below — don't strand tool spinners
    this.#turn = null;
    if (this.#retry?.timer) clearTimeout(this.#retry.timer);
    this.#retry = null;
    if (this.#tasksPushTimer) { clearTimeout(this.#tasksPushTimer); this.#tasksPushTimer = null; }
    if (this.#taskReconcileTimer) { clearInterval(this.#taskReconcileTimer); this.#taskReconcileTimer = null; }
    this.#turn5xxStatus = null;
    if (this.#dispatchTimer) { clearTimeout(this.#dispatchTimer); this.#dispatchTimer = null; }
    if (this.#hookSessionEndTimer) { clearTimeout(this.#hookSessionEndTimer); this.#hookSessionEndTimer = null; }
    this.#needsInput = null;
    this.#clearDirtyRecheck();
    this.#clearCompacting(); // every end path — a kill mid-compaction leaked the 10-min backstop timer
    // Clear the dialog banner on BOTH end paths while the relay is still
    // attached: #pollThinking stops at status==='ended', so a teardown racing
    // the 3s reconcile (e.g. process_exited right after the dialog resolved)
    // would otherwise pin ACTION NEEDED on a detached session forever.
    if (this.#dialog) { this.#dialog = null; this.#dialogKey = null; }
    void this.#relay?.updateDialog(null);
    this.#clearSubmitTimer();
    this.#cancelSteerSubmit();
    // A dispatch mid-flight ends with the process: its verdict is unknown to
    // this generation (the coordinator's retire settles the row — a restart's
    // replacement reconciles it; a kill interrupts it). Queued rows stay for
    // a restart / process exit, are interrupted on a kill.
    if (this.#dispatchInFlight) this.#settleDispatch(`end(${reason})`, { kind: "unknown", detail: `session ended (${reason}) during dispatch` });
    this.#gateWake?.();
    this.#unsubscribeQueue();
    this.#coordinator.retire(this.id, reason);

    this.status = "ended";
    this.endReason = reason;
    this.lastActiveAt = Date.now();

    // Stop paying the periodic pane-snapshot sweep for this window. A later
    // user-driven pane view (captureFresh) transparently re-tracks it.
    this.#tmux.untrack(this.tmuxWindow);

    if (reason === "process_exited") {
      // Detached: keep the card holder attached so the app sees
      // joy__state='detached' → red "detached" (machine presence going away
      // is what turns it offline). Clear thinking first: #pollThinking stops
      // the instant status==='ended', so a stale thinking:true (Claude
      // usually died mid-turn) would otherwise stick on the dead session.
      this.#setThinking(false);
      this.#clearCompacting();
      if (this.#relay) {
        void this.#relay.updateJoyState("detached");
        this.#relay.pausePull();
      }
    } else {
      // Killed → archived: publish the archived card, detach, kill the window.
      if (this.#relay) {
        // Keep the promise so killSession can await the real result.
        if (reason !== "restart") this.#archivePromise = this.#relay.archive();
        this.#relay.stop();
        this.#relay = null;
      }
      // An intentional kill takes the window record with it (the other
      // adapters already do); a restart keeps it for the replacement (#43).
      if (reason !== "restart") this.#recordTerminated = deleteWindowRecord(this.id);
      void (this.#tmuxSocket
        ? (this.#tmux.runSync("kill-server"), disposeTmuxHandle(this.#tmuxSocket), Promise.resolve())          // own server: OS reclaims everything
        : this.#tmux.command(["kill-window", "-t", this.tmuxWindow])); // legacy shared server
    }

    this.#deps.broadcast("session_update", this.toJSON());
    return true;
  }

  /** Resolve once the kill-path archived-card publish settles (true if archived
   *  or there was nothing to archive). Lets killSession report a real failure so the app
   *  runs its own fallback archive instead of trusting an unconditional success. */
  /** #567 residual: false once an intentional kill could NOT durably commit a
   *  termination marker (the record's unlink AND its tombstone both refused).
   *  The kill op reports that instead of ok — a restart would otherwise
   *  recover the "killed" session — and the delete is retried on every record
   *  scan and on the next kill of this id. */
  #recordTerminated = true;
  recordTerminated(): boolean { return this.#recordTerminated; }

  async awaitArchive(): Promise<boolean> {
    return this.#archivePromise ? await this.#archivePromise : true;
  }

  /**
   * Force this session gone: an active one ends as "killed"; a detached one
   * (already ended, window still around) gets archived and its window removed.
   * Returns true if anything was torn down. Used by "kill all sessions".
   */
  forceKill(): boolean {
    if (this.status !== "ended") return this.end("killed");
    if (this.#relay) {
      this.#archivePromise = this.#relay.archive();
      this.#relay.stop();
      this.#relay = null;
    }
    void (this.#tmuxSocket
        ? (this.#tmux.runSync("kill-server"), disposeTmuxHandle(this.#tmuxSocket), Promise.resolve())          // own server: OS reclaims everything
        : this.#tmux.command(["kill-window", "-t", this.tmuxWindow])); // legacy shared server
    this.endReason = "killed";
    this.#recordTerminated = deleteWindowRecord(this.id); // a detached session killed on purpose leaves nothing to resurrect (#43)
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
    this.#coordinator.accept({ sessionId: this.id, text, seq: opts.seq, source: opts.source, mirrorToRelay: opts.mirrorToRelay, visible: false });
    return { buffered: false };
  }

  // ── Dispatch state ──────────────────────────────────────────────────────────

  /**
   * True when the session is doing or holding ANY work: an open turn, a
   * dispatch awaiting its echo, a pending submit Enter, the thinking flag, or
   * queued commands. This is the scripting-facing "can I ask now?" signal —
   * the CLI's exclusive send refuses (busy error) instead of queueing, so a
   * program never silently lines up behind an in-flight turn.
   */
  busy(): boolean {
    return !!(this.#turnRunning() || this.#dispatchInFlight || this.#submitTimer || this.#thinking)
      || this.#coordinator.snapshot(this.id).pendingCount > 0;
  }

  /** Has the coordinator been asked to cancel this command? Consulted at
   *  every gate boundary of a dispatch (R9). */
  #cancelRequested(commandId: string): boolean {
    const row = this.#coordinator.command(commandId);
    return !row || row.cancelRequestedAt != null || row.state === "cancelling" || row.state === "cancelled";
  }

  /** Has this transcript uuid already been handled (mirrored or matched)?
   *  Cache first, then the ledger's retained receipt. */
  #hasUuid(uuid: string): boolean {
    if (this.#uuidSeen.has(uuid)) return true;
    return this.#ledger.hasReceipt(this.id, "transcript_uuid", uuid);
  }
  /** Remember a handled transcript uuid: in the cache now, in the ledger durably. */
  #noteUuid(uuid: string, extra: { commandId?: string; attemptId?: string } = {}): void {
    this.#uuidSeen.add(uuid);
    if (this.#uuidSeen.size > 2000) { for (const u of this.#uuidSeen) { this.#uuidSeen.delete(u); if (this.#uuidSeen.size <= 1500) break; } }
    try { this.#ledger.addReceipt(this.id, { kind: "transcript_uuid", ref: uuid, commandId: extra.commandId, attemptId: extra.attemptId }); }
    catch (e) { process.stderr.write(`[${this.id}] receipt for ${uuid} failed: ${e instanceof Error ? e.message : e}\n`); }
  }
  /** Stage an item in the ledger (the acceptance) — throws when it cannot be
   *  committed: LedgerWriteError (disk) or SessionEndedError (#553). */
  #accept(item: QueuedItem, origin: string): { deduped: "none" | "pending" | "receipt"; id: string; existing?: QueuedItem } {
    const r = this.#ledger.acceptCommand({
      sessionId: this.id, id: item.id, text: item.text, origin, source: item.source, seq: item.seq,
      visible: item.visible, mirrorToRelay: item.mirrorToRelay, createdAt: item.createdAt,
    });
    if (r.deduped === "none") return { deduped: "none", id: r.id };
    const existing = r.row ? { id: r.row.id, text: r.row.text, createdAt: r.row.createdAt, source: r.row.source as DeliverySource, mirrorToRelay: r.row.mirrorToRelay, seq: r.row.seq ?? undefined, visible: r.row.visible } : undefined;
    return { deduped: r.deduped, id: r.id, existing };
  }
  /** The in-flight item goes back to the head of the queue: its attempt is
   *  settled (`unknown` keeps it matchable for a late echo, #31;
   *  `superseded` retires it) and the ledger row returns to queued. */
  #unstage(item: QueuedItem, attemptOutcome: "unknown" | "superseded"): void {
    try {
      if (item.attemptId) { this.#ledger.settleAttempt(item.attemptId, attemptOutcome, { command: null, generation: this.#generation }); if (attemptOutcome === "superseded") item.attemptId = undefined; }
      this.#ledger.transition(item.id, ["submitting", "accepted", "unknown"], "queued");
    } catch (e) {
      process.stderr.write(`[${this.id}] ledger unstage ${item.id} failed: ${e instanceof Error ? e.message : e}\n`);
    }
  }

  /**
   * Joy-owned commands, handled at accept time — before the text is queued or
   * reaches Claude (the coordinator completes their row in the accept
   * transaction; nothing is dispatched for them):
   *   /steer <msg>  a command of origin `steer`: typed straight into the pane
   *                 ahead of the FIFO, mid-turn if a turn is running, through
   *                 the same pane serialization as every other write (#34).
   *   /btw <q>      Claude Code's BUILT-IN side-question command — joy's only
   *                 job is transport: steer the literal "/btw <q>" NOW.
   *   /title <text> set the session's conversation title (the summary the app shows).
   *   /login-code   type the code into the live login form (#482).
   *   /joy-prompt   re-deliver the CURRENT instruction block in-band as a
   *                 hidden follow-up command (attention decays in long sessions).
   */
  #handleCommand(text: string, opts: { source: string; mirrorToRelay: boolean; seq?: number | null }): HandledCommand | null {
    const cmd = parseJoyCommand(text);
    if (!cmd) return null;
    const bg = (p: Promise<unknown>, what: string) => { p.catch((e) => process.stderr.write(`[${this.id}] ${what} failed: ${e instanceof Error ? e.message : e}\n`)); };
    if (cmd.name === "steer" && cmd.args.trim()) return { steer: cmd.args };
    if (cmd.name === "btw" && cmd.args.trim()) return { steer: text };
    if (cmd.name === "title") { this.#setTitle(cmd.args, { byUser: true }); this.#dlog("handled title as a joy command — nothing queued"); return { handled: true }; }
    if (cmd.name === "login-code" && cmd.args.trim()) { bg(this.#submitLoginCode(cmd.args), "/login-code"); return { handled: true }; }
    if (cmd.name === "joy-prompt") { void opts; return { handled: true, reinjection: joyPromptReinjection(OPTIONS_SYSTEM_PROMPT) }; }
    this.#dlog(`handled ${cmd.name} as a joy command — nothing queued`);
    return { handled: true };
  }

  /**
   * A steer command (origin `steer`): type a message straight into the pane
   * and submit it NOW — mid-turn if a turn is running — through the SAME pane
   * serialization as every other writer (the coordinator runs one pane
   * operation at a time, #34: a steer never interleaves with a dispatch's
   * capture→type or a draft restore). Resolves `accepted` once the Enter
   * actually lands (the relay pull awaits that, so the cursor covers the
   * whole delivery); the UserPromptSubmit hook / the transcript echo then
   * prove delivery. A pane with no live input box (dialog, not ready) or a
   * dirty box the C-u loop cannot empty PARKS it — `rejected` as busy, so the
   * coordinator retries it once the runtime is idle again — never typed over
   * a dialog whose digits would select options (#33).
   */
  async #steer(cmd: CommandView, _attempt: AttemptRef, signal: AbortSignal): Promise<SubmitResult> {
    if (this.status === "ended" || signal.aborted) return { kind: "unknown", detail: "session ended before the steer was typed" };
    const text = cmd.text;
    const parked = (why: string): SubmitResult => ({ kind: "rejected", permanent: false, busy: true, detail: `parked: ${why}` });
    // Settle any PENDING steer submit before touching the pane (5.6-sol
    // verify round 2): cancelling it only after our capture/clear/type awaits
    // let the old timer fire MID-STAGING — submitting our half-typed text
    // while acknowledging the old steer.
    let superseded = this.#cancelSteerSubmit();
    // Own the pane for the whole steer (#34): the lease is THIS steer's
    // identity from here until its Enter lands. Taking it before any await
    // stands the dirty-clear and a draft restore down. The exclusive section
    // is then awaited so a writer already past its capture (a draft restore,
    // a dispatch mid-type) finishes typing before this one captures.
    const lease = Symbol("steer");
    this.#paneOwner = lease;
    let section: Promise<void> | null = null;
    let releaseSection: () => void = () => {};
    try {
      while (this.#paneSection) await this.#paneSection;
      while (this.#drainDone) await this.#drainDone;
      if ((this.status as string) === "ended" || signal.aborted) return { kind: "unknown", detail: "session ended before the steer was typed" };
      if (this.#paneOwner !== lease) {
        this.#dlog("steer superseded before it captured — nothing typed");
        return parked("pane taken by another writer");
      }
      if (this.#cancelRequested(cmd.id)) return { kind: "rejected", permanent: false, detail: "cancelled before the steer was typed" };
      superseded = this.#cancelSteerSubmit() ?? superseded;
      section = new Promise<void>((r) => { releaseSection = r; });
      this.#paneSection = section;
      // No dispatch gate here (steering types alongside an in-flight turn), so clear any
      // leftover ourselves — guarded on the box actually holding text (never clear a box
      // that reads empty). See docs/pane-input-clearing.md for why C-u, not C-c.
      const pane = await this.#captureBox();
      // A steer needs a LIVE input box to land in. With a dialog up (permission
      // prompt, AskUserQuestion, "Switch model?", the trust dialog) there is no
      // box: the digits of the steer text select options and its Enter
      // confirms the highlighted default (#33). Same for a capture that failed
      // or shows no box at all: unknown is not "safe to type".
      const box = pane.ok ? paneInputText(pane.out) : null;
      if (!pane.ok || box === null || dialogFromPane(stripAnsi(pane.out)) !== null) {
        const why = !pane.ok ? "pane capture failed" : "no live input box (dialog or not ready)";
        this.#dlog(`steer parked on the queue head — ${why}`);
        return parked(why);
      }
      if (box) {
        // A superseded steer's own text is not a human draft — clear it, never restore it.
        if (superseded === null || flattenForMatch(box) !== flattenForMatch(superseded)) this.#preserveDraft(box);
        if (!(await this.#clearBoxWithCtrlU())) {
          this.#pauseDispatch("input_dirty");
          return parked("input box holds text the C-u loop could not clear");
        }
        await sleep(CLEAR_SETTLE_MS);
      }
      if (!(await this.#typeLines(text))) {
        // Typing failed → nothing reached the pane; the pull must not confirm this seq.
        this.#pauseDispatch("dispatch_failed");
        return parked("typing into the pane failed");
      }
      // Typed: the exclusive section ends here. The lease itself is held
      // until the Enter lands.
      releaseSection();
      if (this.#paneSection === section) this.#paneSection = null;
      // Submit after the settle delay (paste-detection swallows an immediate Enter).
      // The promise resolves when the Enter LANDS and rejects when it fails.
      const landed = await new Promise<boolean>((resolve, reject) => {
        const timer = setTimeout(async () => {
          this.#steerSubmitTimer = null;
          try {
            if (this.status === "ended") { resolve(false); return; } // dead session — nothing to deliver to
            const e = await this.#tmux.key(this.tmuxWindow, "Enter");
            if (!e.ok) { reject(new Error("steer: submit Enter failed")); return; }
            if (cmd.mirrorToRelay) this.#relay?.send(encodeUserMessage(text));
            this.#setThinking(true);
            this.#thinkingLeaseUntil = Date.now() + thinkingLeaseMs(text);
            resolve(true);
          } catch (e) { reject(e as Error); }
        }, ENTER_SUBMIT_DELAY_MS);
        // Superseded by a newer writer before its Enter: the text never got
        // Enter — it must not read as delivered; the coordinator retries it.
        const onSuperseded = () => resolve(false);
        this.#steerSubmitTimer = Object.assign(timer, { onSuperseded, text }) as typeof timer;
      }).catch((e: Error) => { this.#dlog(`steer submit failed: ${e.message}`); return null; });
      if (landed === null) return { kind: "unknown", detail: "steer: submit Enter failed" };
      if (!landed) return parked("steer superseded before submit");
      return { kind: "accepted" };
    } finally {
      releaseSection(); // no-op once released after the type
      if (section && this.#paneSection === section) this.#paneSection = null;
      // Only the steer that still HOLDS the lease releases the pane and wakes
      // the dispatch gate; a superseded one settles silently (#34).
      if (this.#paneOwner === lease) {
        this.#paneOwner = null;
        this.#maybeDrainQueue();
      }
    }
  }

  /**
   * Fresh capture of the pane WITH terminal attributes (capture-pane -e) for
   * every input-box read. The dim attribute is the only thing that tells
   * Claude's ghost placeholder from a typed draft that starts with `Try "`
   * (#478); the parsers strip the codes themselves for everything else.
   */
  #captureBox(): Promise<{ ok: boolean; out: string }> {
    return this.#tmux.captureFresh(this.tmuxWindow, { color: true });
  }

  /** Re-enable auto-drain after a paused (failed/dirty) dispatch. The app's
   *  banner for input_dirty says "tap to CLEAR and resume" — so honor it:
   *  wipe the stray box text first, otherwise the next drain re-detects the
   *  dirt and instantly re-pauses (an unresumable banner loop, found live by
   *  the e2e suite). Async best-effort: the drain kicks after the clear. */
  resumeQueue(): void {
    const wasDirty = this.#pauseReason === "input_dirty";
    const wasPaused = this.#queuePaused;
    this.#queuePaused = false;
    this.#pauseReason = undefined;
    this.#clearAttempts = 0;
    this.#clearDirtyRecheck(); // the human beat the self-heal probe to it
    if (wasPaused) this.#driver.emit({ kind: "resumed" });
    this.#broadcastQueue();
    if (wasDirty) {
      void this.#clearInputIfDirty(true).then(() => this.#maybeDrainQueue());
      return;
    }
    this.#maybeDrainQueue();
  }

  /** Halt auto-drain and record why, so the app can show a precise banner. */
  #pauseDispatch(reason: QueuePauseReason): void {
    this.#queuePaused = true;
    this.#pauseReason = reason;
    this.#clearAttempts = 0;
    this.#driver.emit({ kind: "paused", reason });
    this.#broadcastQueue();
    // input_dirty is the one pause whose blocking condition is externally
    // VERIFIABLE (the box is empty or it isn't), so it self-heals; the
    // dispatch_* pauses mean a message may have half-landed and only a human
    // can judge whether re-sending is safe.
    this.#clearDirtyRecheck();
    if (reason === "input_dirty") { this.#dirtyRecheckAttempts = 0; this.#armDirtyRecheck(); }
  }

  #armDirtyRecheck(): void {
    if (this.#dirtyRecheckTimer) clearTimeout(this.#dirtyRecheckTimer);
    // Dense probes first (the common case is buffered C-u presses landing a
    // beat after we gave up), then a slow heartbeat so an abandoned paused
    // session costs ~nothing while still healing whenever the box comes good.
    const delay = this.#dirtyRecheckAttempts < DIRTY_RECHECK_DENSE_TRIES
      ? DIRTY_RECHECK_MS
      : DIRTY_RECHECK_SLOW_MS;
    this.#dirtyRecheckTimer = setTimeout(() => {
      this.#dirtyRecheckTimer = null;
      void this.#recheckDirtyPause();
    }, delay);
  }

  #clearDirtyRecheck(): void {
    if (this.#dirtyRecheckTimer) { clearTimeout(this.#dirtyRecheckTimer); this.#dirtyRecheckTimer = null; }
    this.#dirtyRecheckAttempts = 0;
  }

  /** True while an input_dirty self-heal probe should still run — the pause we
   *  armed for must still be the one in effect (not resumed, not re-paused for
   *  another reason, session alive). */
  #dirtyRecheckWanted(): boolean {
    return this.status !== "ended" && this.#queuePaused && this.#pauseReason === "input_dirty";
  }

  /**
   * Lift an input_dirty pause once the input box is provably clean again.
   *
   * WHY (live forensics, boite 2026-08-17): #queuePaused is a LATCH — nothing
   * re-evaluated it. But "unclearable" is frequently a timing illusion: a busy
   * claude processes buffered C-u presses LATE (docs/pane-input-clearing.md),
   * so the presses that "failed" land moments later and empty the box. The
   * session then sat paused forever with a perfectly clean box, and even the
   * banner's tap-to-resume was needed to notice. This is the missing patience:
   * the same verification, repeated, allowed only ever to RELAX the block.
   *
   * Strictly empty ("") heals — a null box (no live input box: dialog, menu,
   * not ready) is "unknown", not "clean", exactly as the dispatch gate treats
   * it, and human-typed text keeps the pause so we never silently discard a
   * draft. A false heal is cheap: #drainOnce independently re-verifies an
   * empty box on a fresh capture before it types anything.
   */
  async #recheckDirtyPause(): Promise<void> {
    if (!this.#dirtyRecheckWanted()) return;
    this.#dirtyRecheckAttempts += 1;
    const pane = await this.#captureBox();
    // Re-check after the await: a resume, an end, or a different pause may have
    // landed while the capture was in flight.
    if (!this.#dirtyRecheckWanted()) return;
    if (pane.ok && paneInputText(pane.out) === "") {
      process.stderr.write(`[queue] input box clean again for ${this.id} — resuming\n`);
      this.#queuePaused = false;
      this.#pauseReason = undefined;
      this.#clearAttempts = 0;
      this.#clearDirtyRecheck();
      this.#driver.emit({ kind: "resumed" });
      this.#broadcastQueue();
      this.#maybeDrainQueue();
      return;
    }
    this.#armDirtyRecheck();
  }

  clearQueue(): void {
    for (const c of this.#coordinator.snapshot(this.id).commands) if (c.state === "queued") this.#coordinator.cancel(c.id);
  }

  /** Publish the queue state (debug SSE + the app's card): the coordinator's
   *  snapshot plus this session's own pause. */
  #broadcastQueue(): void {
    // A retired instance publishes nothing: after end("restart") the SAME
    // session id belongs to the replacement (#481).
    if (this.status === "ended") return;
    const state = { ...this.#coordinator.snapshot(this.id), paused: this.#queuePaused, ...(this.#queuePaused && this.#pauseReason ? { pauseReason: this.#pauseReason } : {}) };
    this.#deps.broadcast("queue_update", { session_id: this.claudeSessionId, ...state });
    // Push to the app via session metadata so it doesn't have to poll.
    void this.#relay?.updateQueue(state);
  }

  /** Texts the coordinator still has to deliver (queued or in flight). */
  #pendingTexts(): string[] {
    return this.#coordinator.snapshot(this.id).commands.filter((c) => c.state !== "running" && c.state !== "cancelling").map((c) => c.text);
  }
  #pendingCount(): number { return this.#coordinator.snapshot(this.id).pendingCount; }

  /**
   * Clear the live input box IF it currently holds real text (see
   * docs/pane-input-clearing.md for the full design + forensics). `idleOnly`
   * adds the dispatch-gate guards (no open turn / in-flight dispatch /
   * generating). Honest three-way result:
   *   "cleared" — a clear episode ran and the box verifiably reads empty
   *   "dirty"   — an episode ran but text remains (stalled/damaged pane, or
   *               more lines than the press budget); caller must NOT type
   *   "skipped" — nothing attempted (guards failed, capture failed, or the
   *               box was already empty/absent); not a failed attempt
   */
  async #clearInputIfDirty(idleOnly: boolean): Promise<"cleared" | "dirty" | "skipped"> {
    if (idleOnly && (this.#turnRunning() || this.#dispatchInFlight)) return "skipped";
    if (this.#paneOwner) return "skipped"; // the box text is a steer / restore in progress, not leftover (#34)
    const pane = await this.#captureBox(); // FRESH — stale here = concatenation
    // captureFresh can take a control-mode round-trip; re-check the idle guards after
    // it: a turn / dispatch may have begun while it was in flight, in which case the
    // text in the box is no longer stale leftover and must not be cleared.
    if (idleOnly && (this.#turnRunning() || this.#dispatchInFlight)) return "skipped";
    if (this.#paneOwner) return "skipped";
    if (!pane.ok) return "skipped";
    if (idleOnly && ((paneShowsGenerating(pane.out) && !this.#hookSaysIdle()) || !paneShowsReadyPrompt(pane.out))) return "skipped";
    const box = paneInputText(pane.out);
    if (box === "" || box === null) return "skipped"; // empty / no box → nothing to clear
    this.#preserveDraft(box);
    return (await this.#clearBoxWithCtrlU()) ? "cleared" : "dirty";
  }

  /**
   * Remember box text about to be cleared so it can be restored after the queue
   * drains — UNLESS it's a pending send's own leftover (a timed-out dispatch is
   * re-queued with its text still in the box; preserving that would deliver the
   * message TWICE: once re-dispatched from the queue, once as a restored
   * "draft"). Anything else in the box is treated as human-typed. That includes
   * an aborted-but-unsubmitted message (abort leaves its text in the box by
   * design — docs/pane-input-clearing.md): it comes back as an editable draft
   * rather than silently vanishing, same visibility hazard as today.
   */
  #preserveDraft(box: string): void {
    const flat = flattenForMatch(box);
    const isPendingSend = this.#pendingTexts().some((t) => flattenForMatch(t) === flat)
      || (this.#dispatchInFlight !== null && flattenForMatch(this.#dispatchInFlight.text) === flat);
    if (!isPendingSend) {
      this.#preservedDraft = box;
      this.#driver.emit({ kind: "draft_preserved", text: box });
    }
  }

  /**
   * Type a preserved human draft back into the box — literal keys only, NEVER
   * Enter — once the dispatch queue is fully idle. Only restores into a
   * verified-EMPTY box: if the user has started typing again (or no live box is
   * on screen), hold the draft and try again at the next idle trigger rather
   * than merging two texts. Typing while Claude is generating is safe — keys
   * buffer into the box (docs/pane-input-clearing.md).
   */
  async #restoreDraftIfAny(): Promise<void> {
    const draft = this.#preservedDraft;
    if (!draft || this.status === "ended") return;
    if (this.#pendingCount() > 0 || this.#dispatchInFlight || this.#paneOwner) return; // box is needed again — keep holding
    // CLAIM the draft before the first await and run one restore at a time: a
    // command echo started a restore and then kicked the drain, which started
    // a second restore before the first capture resolved — both saw an empty
    // box and the draft was typed twice (#476). The claim is handed back on
    // every path that cannot proceed, so a later idle trigger retries.
    this.#preservedDraft = null;
    const handBack = () => { this.#preservedDraft = this.#preservedDraft ?? draft; };
    const lease = Symbol("restore");
    let section: Promise<void> | null = null;
    let releaseSection: () => void = () => {};
    try {
      // Wait for any writer already in its section and any drain pass in
      // flight, THEN take the pane lease: from here to the type every other
      // writer stands down, so the checks below stay true across the awaits.
      while (this.#paneSection) await this.#paneSection;
      while (this.#drainDone) await this.#drainDone;
      if ((this.status as string) === "ended" || this.#pendingCount() > 0 || this.#dispatchInFlight || this.#paneOwner) { handBack(); return; }
      this.#paneOwner = lease;
      section = new Promise<void>((r) => { releaseSection = r; });
      this.#paneSection = section;
      const pane = await this.#captureBox();
      // Fence AFTER the capture (#476 residual): the session may have ended
      // for a restart while it was in flight — the retired instance then typed
      // the draft into its replacement's window — a steer may have taken the
      // lease, or a message may have been queued. None of those may be typed
      // over; hand the draft back for the next idle trigger.
      if ((this.status as string) === "ended" || this.#paneOwner !== lease || this.#pendingCount() > 0 || this.#dispatchInFlight) { handBack(); return; }
      if (!pane.ok || paneInputText(pane.out) !== "") { handBack(); return; } // capture failed / user typed anew / no box — never merge
      if (!(await this.#typeLines(draft))) handBack(); // typing failed — keep for retry
    } finally {
      releaseSection();
      if (section && this.#paneSection === section) this.#paneSection = null;
      if (this.#paneOwner === lease) {
        this.#paneOwner = null;
        // A drain refused while the lease was held (a message queued mid-
        // restore) needs its trigger back; an empty queue needs nothing (and a
        // kick would re-run this restore on a failed capture, unbounded).
        if (this.#pendingCount() > 0) this.#maybeDrainQueue();
      }
    }
  }

  /**
   * Clear a NON-EMPTY input box with a verified C-u loop. WHY C-u AND NOT C-c
   * (do not "fix" this back — docs/pane-input-clearing.md has the 2026-07-02
   * forensics): a healthy claude clears a filled box with one C-c, but when
   * claude stalls/stops, the pane's interactive-bash parent takes the tty back
   * in COOKED mode while claude's TUI stays painted — and in that state ^C is
   * not a keypress, it's SIGINT: it goes to bash (silent no-op) or, once claude
   * is foreground again, KILLS the claude session (reproduced live, twice).
   * ^U can never become a signal; extra C-u's on an empty box are harmless
   * no-ops, so late-processed buffered presses are safe too.
   *
   * C-u kills ONE line per press (~2 presses per line with the line break), so
   * the press budget scales with the box's rendered height. Returns true only
   * when a fresh capture confirms the box reads empty. Three consecutive
   * presses with NO change to the box text is the stalled-pane fingerprint
   * (keys aren't being processed) — bail early and report dirty rather than
   * blind-blasting the budget.
   */
  async #clearBoxWithCtrlU(): Promise<boolean> {
    const first = await this.#captureBox();
    if (!first.ok) return false;
    let prev = paneInputText(first.out);
    if (prev === "" || prev === null) return true; // already empty
    const budget = Math.min(40, paneInputLineSpan(first.out) * 2 + 4);
    let stalled = 0;
    for (let i = 0; i < budget; i++) {
      const cu = await this.#tmux.key(this.tmuxWindow, "C-u");
      if (!cu.ok) return false;
      const re = await this.#captureBox();
      if (!re.ok) return false; // can't verify → report dirty, never claim success
      const remaining = paneInputText(re.out);
      if (remaining === "" || remaining === null) return true;
      stalled = remaining === prev ? stalled + 1 : 0;
      if (stalled >= 3) return false; // pane not processing keys — stop, report dirty
      prev = remaining;
    }
    return false; // budget exhausted with text left
  }

  /** The gate a dispatch of OURS waits on: promptReadiness minus the
   *  in-flight check (we are the one in flight) — the pane's box/dialog
   *  safety checks come after, on a fresh capture. */
  #gateReadiness(): { ready: boolean; reason: string } {
    if (this.status === "ended") return { ready: false, reason: "session ended" };
    if (this.#queuePaused) return { ready: false, reason: `queue paused (${this.#pauseReason ?? "?"})` };
    if (this.#turnRunning()) return { ready: false, reason: this.#hooksLive && this.#hookTurn?.open ? "turn running (hook)" : "turn running (transcript)" };
    if (this.#paneOwner) return { ready: false, reason: "pane leased (steer / draft restore)" };
    return { ready: true, reason: "clear to send" };
  }

  /**
   * THE readiness decision — the one answer every dispatch and clear gate
   * consumes (#drainOnce, #clearInputIfDirty, #holdReason, busy()), and the
   * method a Claude driver on the session coordinator will call. It is the
   * RUNTIME's state: the turn as the authority sees it (with hooks live, the
   * Stop/StopFailure/idle edge closes it whatever the transcript's tail or the
   * pane's footer still show — see #turnRunning), the queue's own pause, the
   * dispatch in flight and the pane lease. What it deliberately leaves out is
   * everything only a FRESH pane read can answer — a draft in the box, a
   * dialog, the login form, a generating footer while no hook has spoken —
   * which the gates check next, never instead.
   */
  promptReadiness(): { ready: boolean; reason: string } {
    if (this.status === "ended") return { ready: false, reason: "session ended" };
    if (this.#queuePaused) return { ready: false, reason: `queue paused (${this.#pauseReason ?? "?"})` };
    if (this.#dispatchInFlight) return { ready: false, reason: `dispatch ${this.#dispatchInFlight.id} still in flight` };
    if (this.#turnRunning()) return { ready: false, reason: this.#hooksLive && this.#hookTurn?.open ? "turn running (hook)" : "turn running (transcript)" };
    if (this.#paneOwner) return { ready: false, reason: "pane leased (steer / draft restore)" };
    return { ready: true, reason: "clear to send" };
  }

  /** The runtime turn as the authority sees it (busy(), `joy check`). */
  turnOpen(): boolean { return this.#turnRunning(); }

  /** Sleep `ms` inside the dispatch gate, woken early by #maybeDrainQueue. */
  #waitGate(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      let done = false;
      const finish = () => { if (done) return; done = true; clearTimeout(t); if (this.#gateWake === finish) this.#gateWake = null; signal.removeEventListener("abort", finish); resolve(); };
      const t = setTimeout(finish, ms);
      this.#gateWake = finish;
      signal.addEventListener("abort", finish, { once: true });
    });
  }

  // ── Dispatch tracing ────────────────────────────────────────────────────────
  // The dispatch path used to log only failures, so a message that reached the
  // relay, was staged, and then sat behind a gate left NO trace at all — the
  // 2026-09-03 "queued but never sent" reports were undiagnosable after the
  // fact. These lines cover the whole lifecycle (queued → typed → submitted →
  // confirmed) plus a throttled line naming the gate whenever a staged message
  // waits. Text is never logged, only its length.
  #dlog(msg: string): void {
    process.stderr.write(`[dispatch] ${this.id} ${msg}\n`);
  }

  /** Which gate is currently holding the queue (for #noteHold) — the same
   *  decision the drain consumes, so the log never names a gate that is not
   *  the one holding (it used to say "turn running" off the transcript's
   *  #turn after a hook had already closed it). */
  #holdReason(): string {
    return this.promptReadiness().reason;
  }

  /** Log a held head item at most every 30s, and only once it has waited 10s —
   *  a drain retries twice a second, so an unthrottled line would be noise. */
  #noteHold(reason: string): void {
    const head = this.#dispatchInFlight ?? this.#gateItem;
    if (!head) return;
    const waited = Date.now() - head.createdAt;
    if (waited < 10_000) return;
    const now = Date.now();
    if (now - this.#holdLoggedAt < 30_000) return;
    this.#holdLoggedAt = now;
    this.#dlog(`held ${head.id} ${Math.round(waited / 1000)}s — ${reason}`);
  }

  /** Wake the dispatch gate (turn-end / resume / a writer releasing the
   *  pane) and, with nothing left to deliver, restore a preserved human
   *  draft (rare: gated on the field). */
  #maybeDrainQueue(): void {
    if (this.#preservedDraft && !this.#dispatchInFlight && this.#pendingCount() === 0) {
      void this.#restoreDraftIfAny();
      return;
    }
    this.#gateWake?.();
  }

  /** The command waiting at the gate (for #noteHold), before it is in flight. */
  #gateItem: QueuedItem | null = null;

  /**
   * Dispatch ONE command (the driver's submit): wait at the gate until Claude
   * is genuinely idle AND the input box is empty, type it, arm the delayed
   * Enter, and resolve with the runtime's verdict once a confirm path settles
   * it (#settleDispatch) or the echo window closes. The gate AWAITS a FRESH
   * pane capture where a stale read would cause data loss:
   *   1. NOT generating ("esc to interrupt") — unless the hooks say idle: the
   *      pane's real-time signal is what stops a dispatch into a live turn.
   *   2. AT the ready prompt (not a dialog/spinner) — repaint lag → recheck shortly.
   * Then REQUIRE an EMPTY box: dispatch ONLY when paneInputText === "" — a null box
   * (no live input box detected) is "not ready", NOT "empty", so it retries; stuck
   * TEXT is cleared with a verified C-u episode (#clearInputIfDirty). PATIENCE
   * MATTERS here: a busy claude processes buffered keys LATE, so a single quick
   * re-capture misreads "busy" as "unclearable" (see docs/pane-input-clearing.md).
   * Two full failed episodes, spaced 750ms, are required before pausing with the
   * input_dirty banner — the wait then continues until the pause lifts. A
   * cancel is consulted at every gate boundary (R9): a cancelled command is
   * never typed.
   */
  async #awaitGate(view: CommandView, signal: AbortSignal): Promise<"ready" | "cancelled" | "retired"> {
    const item: QueuedItem = {
      id: view.id, text: view.text, createdAt: view.createdAt,
      source: view.source as DeliverySource, mirrorToRelay: view.mirrorToRelay,
      seq: view.seq ?? undefined, visible: view.visible,
    };
    this.#gateItem = item;
    try {
      for (;;) {
        if (signal.aborted || this.status === "ended") return "retired";
        if (this.#cancelRequested(item.id)) return "cancelled";
        const gate = this.#gateReadiness();
        if (!gate.ready) { this.#noteHold(gate.reason); await this.#waitGate(this.#queuePaused ? 1_000 : 500, signal); continue; }
        const pane = await this.#captureBox();
        if (signal.aborted || (this.status as string) === "ended") return "retired";
        if (this.#cancelRequested(item.id)) return "cancelled";
        if (!this.#gateReadiness().ready) continue; // re-check after the await
        // The generating footer is a hard veto only while the pane is the
        // authority: with hooks live and the last turn edge saying idle, a frame
        // still painting "esc to interrupt" is stale — the ready-prompt and empty-
        // box checks below remain (hook authority owns readiness, the pane owns
        // what it alone can see: drafts and dialogs).
        if (!pane.ok || (paneShowsGenerating(pane.out) && !this.#hookSaysIdle()) || !paneShowsReadyPrompt(pane.out)) {
          this.#clearAttempts = 0; // a not-ready/busy pane ends any in-progress clear episode
          this.#noteHold(!pane.ok ? "pane capture failed" : "pane busy or not at the prompt");
          await this.#waitGate(500, signal);
          continue;
        }
        const box = paneInputText(pane.out);
        if (box !== "") {
          if (box === null) { this.#clearAttempts = 0; this.#noteHold("no input box on screen"); await this.#waitGate(500, signal); continue; } // not-ready, not empty
          // Stuck text → run a verified clear episode. Only a FAILED episode ("dirty":
          // keys went out but the box still holds text) counts toward the pause;
          // "skipped" means state changed under us (turn started / not ready), which
          // ends the episode without blame. Two failed episodes spaced 750ms → pause:
          // the spacing gives a busy claude time to process buffered keys before we
          // declare the pane unclearable (docs/pane-input-clearing.md).
          const res = await this.#clearInputIfDirty(true);
          if (res === "cleared") { this.#clearAttempts = 0; await this.#waitGate(200, signal); continue; }
          if (res === "skipped") { this.#clearAttempts = 0; await this.#waitGate(500, signal); continue; }
          this.#noteHold("input box holds text we could not clear");
          this.#clearAttempts += 1;
          if (this.#clearAttempts >= 2) {
            process.stderr.write(`[queue] input box dirty + unclearable for ${this.id} — paused\n`);
            this.#pauseDispatch("input_dirty");
            continue; // the wait above holds until the pause lifts (resume / self-heal)
          }
          await this.#waitGate(750, signal);
          continue;
        }
        return "ready"; // box === "" → empty, safe to type.
      }
    } finally {
      this.#gateItem = null;
    }
  }

  /** Type ONE command the gate cleared, arm its delayed Enter, and resolve
   *  with the runtime's verdict once a confirm path settles it. */
  async #dispatchOne(view: CommandView, attempt: AttemptRef, signal: AbortSignal): Promise<SubmitResult> {
    if (signal.aborted || this.status === "ended") return { kind: "unknown", detail: "session retired during dispatch" };
    if (this.#cancelRequested(view.id)) return { kind: "rejected", permanent: false, detail: "cancelled before dispatch" };
    const item: QueuedItem = {
      id: view.id, text: view.text, createdAt: view.createdAt,
      source: view.source as DeliverySource, mirrorToRelay: view.mirrorToRelay,
      seq: view.seq ?? undefined, visible: view.visible, attemptId: attempt.attemptId, runtimeRef: attempt.runtimeRef,
    };
    this.#clearAttempts = 0;
    this.#dispatchInFlight = item;
    // null until THIS item's delayed Enter actually lands (#armSubmit) — reset
    // the moment the item goes in flight, BEFORE the first awaited write. The
    // dialog causal guard treats null as +Infinity, so a dialog first sighted
    // before our submit can never be credited to this dispatch; a cancel /
    // abort reads null as "typed, Enter not out" (#35).
    this.#dispatchSubmittedAt = null;
    this.#dispatchExtends = 0;
    const settled = new Promise<SubmitResult>((resolve) => { this.#dispatchSettle = resolve; });
    this.#broadcastQueue();
    // The capture→type section: a steer or a draft restore arriving now waits
    // for it (#34) so two writers never interleave in the box.
    let releaseSection: () => void = () => {};
    this.#drainDone = new Promise<void>((r) => { releaseSection = r; });
    const stillOurs = () => (this.status as string) !== "ended" && this.#dispatchInFlight === item;
    try {
      // Type DIRECTLY — the gate proved the pane is ready + empty, and a
      // "starting" session must type now to bootstrap its transcript. Awaited:
      // the keystrokes go over control mode and a failure must reach the catch below.
      await this.#typeIntoTmux(item.text, { seq: item.seq, source: item.source, mirrorToRelay: item.mirrorToRelay });
    } catch (e) {
      releaseSection(); this.#drainDone = null;
      if (!stillOurs()) {
        process.stderr.write(`[queue] ${this.id}: dispatch ${item.id} write failed after the session was ${(this.status as string) === "ended" ? `ended (${this.endReason})` : "settled"} — abandoned (#481)\n`);
        return settled;
      }
      // Send failed outright — nothing reached the pane: pause, the
      // coordinator retries once the pause lifts.
      process.stderr.write(`[queue] dispatch send failed for ${this.id}: ${e}\n`);
      this.#pauseDispatch("dispatch_failed");
      this.#settleDispatch("typing failed", { kind: "rejected", permanent: false, busy: true, detail: "dispatch_failed" });
      return settled;
    }
    releaseSection(); this.#drainDone = null;
    if (!stillOurs()) {
      // Typed into a window that no longer belongs to a live dispatch (a
      // cancel or an end settled it meanwhile): drop the submit Enter
      // #typeIntoTmux just armed and arm no echo timeout for it.
      this.#clearSubmitTimer();
      return settled;
    }
    this.#holdLoggedAt = 0; // the hold is over — the next one logs promptly
    this.#dlog(`typed ${item.id} (chars=${item.text.length}) — Enter pending`);
    // Arm the echo-confirmation timeout: a successful dispatch produces a new turn.
    // If none appears, the message didn't land.
    this.#dispatchTimer = setTimeout(() => this.#onDispatchTimeout(), DISPATCH_ECHO_TIMEOUT_MS);
    return settled;
  }

  /** THE settlement of the in-flight dispatch: release the slot, resolve the
   *  driver's submit with the verdict and — when the runtime took it — report
   *  the echo (the transcript path reports its own, with the uuid receipt).
   *  A command (`!bash`, `/slash`) never runs a turn of its own: its delivery
   *  IS its completion, so its turn end is reported at once. */
  #settleDispatch(how: string, result: SubmitResult, opts: { echo?: boolean } = {}): void {
    const item = this.#dispatchInFlight;
    if (!item) return;
    this.#dispatchInFlight = null;
    this.#dispatchExtends = 0;
    if (this.#dispatchTimer) { clearTimeout(this.#dispatchTimer); this.#dispatchTimer = null; }
    const settle = this.#dispatchSettle;
    this.#dispatchSettle = null;
    this.#dlog(`${result.kind === "accepted" ? "confirmed" : result.kind} ${item.id} by ${how}`);
    if (result.kind === "accepted") {
      item.delivered = true;
      this.#lastConfirmedRef = item.runtimeRef ?? flattenForMatch(item.text);
      const ref = item.runtimeRef ?? flattenForMatch(item.text);
      if (opts.echo !== false) this.#driver.emit({ kind: "echo", runtimeRef: ref });
      const isCommand = /^\s*!/.test(item.text) || /^\/[a-zA-Z][\w:-]*(?:\s|$)/.test(item.text);
      if (isCommand) this.#driver.emit({ kind: "turn_ended", runtimeRef: ref, status: "completed" });
    }
    settle?.(result);
    this.#broadcastQueue();
    if (result.kind === "accepted") void this.#restoreDraftIfAny();
  }

  /** Delivery confirmed by a post-submit interactive DIALOG (not by echo):
   *  slash commands like /model open one and may resolve via Esc with NO echo
   *  ever — waiting on the echo would requeue a consumed command. Called from
   *  #reconcileDialog on dialog appearance (~6s: two debounce polls) and from
   *  the timeout as a backstop. Slash-only by design: a plain message cannot
   *  open a dialog, and confirming one here would be silent message loss. */
  #confirmDispatchOnDialog(dialogSince: number): void {
    const inflight = this.#dispatchInFlight;
    if (!inflight || !inflight.text.trimStart().startsWith("/")) return;
    // Causal guard: the dialog must have APPEARED after this dispatch
    // submitted. Mostly automatic (the drain gate refuses to type while a
    // dialog is up — no ready prompt), but a pre-existing dialog that raced
    // the gate's capture must not confirm a command it didn't come from.
    if (dialogSince < (this.#dispatchSubmittedAt ?? Number.POSITIVE_INFINITY)) return;
    this.#clearSubmitTimer();
    this.#settleDispatch("dialog", { kind: "accepted" });
  }

  /** Called from onTranscriptEntry when a new turn starts (byTurnStart) or a
   *  text-matched user echo lands — confirms the dispatch landed. A turn start
   *  is only circumstantial: it defers to a FRESH box read (async) before it
   *  credits anything; the echo is direct evidence and settles at once. */
  #confirmDispatchIfAwaiting(opts?: { byTurnStart?: boolean }): void {
    if (!this.#dispatchInFlight) return;
    // A dispatch whose submit Enter is still PENDING cannot be what started this
    // turn — the message hasn't been submitted yet. Confirming here is how a
    // message gets silently LOST (caught live by e2e Test 5): the previous
    // answer's late transcript entries open a fresh turn id right after the
    // drain typed the next queued message; the unconditional confirm dropped
    // that message as "delivered" AND cancelled its pending Enter, stranding
    // its text in the box. Leave it in flight: #armSubmit reschedules around
    // the open turn and the transcript user-echo (text-matched) confirms it —
    // or the dispatch echo timeout requeues it. Never confirm on turn-start alone.
    if (this.#submitTimer) return;
    if (opts?.byTurnStart) {
      // HOOK AUTHORITY (#32): with hooks live, a plain prompt of ours that
      // really submitted fires UserPromptSubmit with its exact text, and that
      // hook (or the transcript's text-matched user echo) confirms it. A turn
      // starting WITHOUT either is by definition not ours — a <task-notification>,
      // a Claude-side queued message, typing in the terminal — so it never
      // confirms the in-flight prompt, whatever the box shows (the box read
      // below is the hook-less fallback, and it can misread). Slash and `!`
      // commands are exempt: UserPromptSubmit does not fire for a built-in
      // command, and a command that produced a turn is confirmed by the
      // <command-name> echo, its dialog, or this turn-start as before.
      const cmdLike = /^\s*[/!]/.test(this.#dispatchInFlight.text);
      if (this.#hooksLive && !cmdLike) {
        this.#dlog(`turn started but hooks are live and no UserPromptSubmit matched ${this.#dispatchInFlight.id} — foreign turn, not confirming (#32)`);
        return;
      }
      void this.#confirmOnTurnStartWithFreshBox(this.#dispatchInFlight, cmdLike);
      return;
    }
    this.#settleDispatch("transcript echo", { kind: "accepted" }, { echo: false }); // the transcript path reported the echo with its uuid receipt
  }

  /** The hook-less (and command) turn-start confirmation, against a FRESH box
   *  read. A SENT Enter is not a SUBMITTED message: paste-detection can absorb
   *  it as a newline, leaving the prompt in the box. If a foreign turn then
   *  starts (a <task-notification>, a Claude-side queued message, typing in
   *  the terminal), this used to credit it to our dispatch — "delivered" —
   *  while the prompt still sat unsent, later to be C-u'd away as a "human
   *  draft" (#32). The box is the evidence, and it must be a LIVE read: the
   *  cached snapshot is a periodic sweep that can predate the type, so it
   *  showed an empty box while the real one held the unsent text (617dc734
   *  review). When the pane positively shows our text still in it, this turn
   *  is not ours; when there is NO evidence (capture failed, no live box) a
   *  plain prompt is not credited either — absence of a box read is not
   *  delivery; the text-matched echo, the hook or the timeout decide. A
   *  command (`/x`, `!x`) with no box on screen is the one case still
   *  credited: its turn typically hides the box (/compact, a dialog), it never
   *  echoes as user text, and a requeue would run it twice. */
  async #confirmOnTurnStartWithFreshBox(item: QueuedItem, cmdLike: boolean): Promise<void> {
    const pane = await this.#captureBox();
    // The world may have moved during the read: the echo/hook settled it, a
    // timeout requeued it, the item was cancelled, or a new submit is pending.
    if (this.status === "ended" || this.#dispatchInFlight !== item || this.#submitTimer) return;
    const box = pane.ok ? paneInputText(pane.out) : null;
    if (!cmdLike && box === null) {
      this.#dlog(`turn started but the input box is unknown (${pane.ok ? "no live box" : "capture failed"}) — not confirming ${item.id} on a turn start (#32)`);
      return;
    }
    if (box) {
      const flatBox = flattenForMatch(box);
      const flatSent = flattenForMatch(item.text);
      if (flatBox === flatSent || flatBox.startsWith(flatSent) || flatSent.startsWith(flatBox)) {
        this.#dlog(`turn started but ${item.id} is still in the input box (fresh read) — not confirming (#32)`);
        return;
      }
    }
    this.#settleDispatch("turn start", { kind: "accepted" });
  }

  #onDispatchTimeout(): void {
    this.#dispatchTimer = null;
    const inflight = this.#dispatchInFlight;
    if (!inflight) return;
    // Before declaring failure, check whether Claude is actually WORKING on the
    // message. A large context (600k+ tokens) can make turn-start take longer
    // than the echo window — the message DID land, Claude is just churning on it
    // before writing the first transcript entry. Pausing here false-fails EVERY
    // send on such a session ("queued message failed to send" that keeps
    // recurring). If the pane shows generation/work, EXTEND the window instead of
    // pausing — bounded, so a genuinely-lost dispatch (a dialog ate it, Claude
    // wasn't ready) still surfaces after the extensions are spent.
    const pane = this.#tmux.captureCached(this.tmuxWindow);
    const working = pane.ok && (paneShowsGenerating(pane.out) || paneShowsWorking(pane.out));
    if (working && this.#dispatchExtends < MAX_DISPATCH_EXTENDS) {
      this.#dispatchExtends += 1;
      this.#dispatchTimer = setTimeout(() => this.#onDispatchTimeout(), DISPATCH_ECHO_TIMEOUT_MS);
      return;
    }
    // The command opened an interactive DIALOG (model picker / switch confirm /
    // effort slider): the CLI is waiting on a human. For a SLASH COMMAND this
    // is delivery CONFIRMATION — the command executed far enough to open its
    // dialog, and an Esc-close may produce NO echo at all, so holding the
    // window would eventually requeue an already-consumed command and resume
    // would re-type it (double execution; gpt-5.6-sol review finding 1).
    // Confirm and move on: the drain gate's ready-prompt check holds any
    // queued messages until the dialog resolves, and #reconcileDialog kicks
    // the drain when it clears.
    if (pane.ok && dialogFromPane(pane.out) != null) {
      if (inflight.text.trimStart().startsWith("/")) {
        // Backstop for the reconcile-time confirm (no relay → no 3s poll).
        this.#confirmDispatchOnDialog(Date.now());
        if (!this.#dispatchInFlight) return;
        // Causal guard refused (dialog predates the dispatch) → fall through
        // to the plain-message bounded hold below.
      }
      // A PLAIN message cannot open a dialog — this one is blocked by a dialog
      // someone opened in the terminal. Auto-confirming would risk silent
      // message LOSS (the text may be sitting in the hidden input box), so
      // hold instead — but BOUNDED, unlike the slash case: a matcher false
      // positive must not pin a lost dispatch forever.
      if (this.#dispatchExtends < MAX_DISPATCH_EXTENDS * 3) {
        this.#dispatchExtends += 1;
        this.#dispatchTimer = setTimeout(() => this.#onDispatchTimeout(), DISPATCH_ECHO_TIMEOUT_MS);
        return;
      }
    }
    // No turn started in time and Claude isn't visibly working → the message
    // didn't land. The row goes back to queued (a transient, uncounted
    // rejection) and the queue pauses so we don't pile more into a bad state;
    // resume re-clears the box and re-types it. The attempt stays matchable
    // for a LATE echo (#31): the documented late-landing cases (tailer bound
    // after the echo window, a 600k-context turn start slower than the
    // extension budget, a narrow pane hiding "esc to interrupt") echo AFTER
    // this point — the coordinator pairs that echo with this attempt by its
    // ref, the command runs instead of being re-typed, and the transcript
    // path lifts this pause (the late-echo self-heal).
    this.#clearSubmitTimer();
    this.#pauseDispatch("dispatch_timeout");
    process.stderr.write(`[queue] dispatch for ${this.id} never echoed — paused\n`);
    this.#settleDispatch("echo timeout", { kind: "rejected", permanent: false, busy: true, detail: "dispatch_timeout" });
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
    const pane = this.#tmux.captureCached(this.tmuxWindow);
    // HOOK AUTHORITY: the footer is read only where it is live — under a
    // located input box. No box (dialog, login form, spinner-only frame,
    // capture failure) means the footer is not on screen, and the parser's
    // "no marker → default" would be a guess; the last hook-reported mode is
    // the truth there. WITH a box the NEWER evidence wins: a Shift+Tab in the
    // terminal fires no hook, so a footer repainted after the last hook is
    // fresher than the hook value — but a cached frame captured BEFORE the
    // last hook is the stale side (the sweep can predate a whole turn), and
    // then the hook's mode is the truth (#480 residual). A frame of unknown
    // age (no timestamp) keeps the footer-wins rule.
    const hookMode = this.#hooksLive ? this.#hookPermissionMode : null;
    if (!pane.ok) return hookMode;
    if (hookMode && !paneShowsReadyPrompt(pane.out)) return hookMode;
    if (hookMode && pane.at !== undefined && pane.at < this.#hookPermissionModeAt) return hookMode;
    return parsePermissionModeFromPane(pane.out);
  }

  /** Hook authority snapshot (tests, debug). */
  hookState(): { live: boolean; since: number; launchId: string | null; permissionMode: string | null; permissionModeAt: number; needsInput: { kind: string; tool?: string; since: number } | null; authFailure: { errorType: string; since: number } | null; sessionEnd: { reason: string; at: number } | null } {
    return {
      live: this.#hooksLive, since: this.#hooksLiveAt, launchId: this.#launchId,
      permissionMode: this.#hookPermissionMode, permissionModeAt: this.#hookPermissionModeAt,
      needsInput: this.#needsInput, authFailure: this.#authFailure, sessionEnd: this.#hookSessionEnd,
    };
  }

  /** Hook-reported waiting-for-input (see #needsInput) — `joy check`'s
   *  needs_input for claude, where no approval object exists. */
  needsInput(): { kind: string; tool?: string; since: number } | null {
    return this.#needsInput;
  }

  /** With hooks live: has a hook (Stop / StopFailure / idle) closed the turn
   *  AFTER the transcript's open turn began? Then #turn is bookkeeping for
   *  output still being tailed (its turn_duration entry lags), not a running
   *  turn — busy() and the drain gate must not wait on it. */
  #turnClosedByHook(): boolean {
    const h = this.#hookTurn;
    return this.#hooksLive && h !== null && !h.open && (this.#turn === null || h.at >= this.#turn.since);
  }
  /** The runtime turn as the authority sees it: the transcript's turn unless a
   *  later hook closed it (hooks live). */
  #turnRunning(): boolean {
    return this.#turn !== null && !this.#turnClosedByHook();
  }
  /** Hooks are live and the last hook turn edge says IDLE — the pane's
   *  generating footer is then a stale frame, not a dispatch veto (the box and
   *  dialog checks still apply). */
  #hookSaysIdle(): boolean {
    return this.#hooksLive && this.#hookTurn !== null && !this.#hookTurn.open;
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
    // FRESH reads on BOTH sides of the cycle (#480 residual): the cached
    // snapshot is a periodic sweep that can predate the last Shift+Tab, so a
    // stale footer already naming the target used to return success — and
    // persist the wrong mode — without one key sent or one live pane read.
    const current = await this.#readPermissionModeFresh();
    if (current === null) return { ok: false, error: "could not read the permission mode (no live footer)" };
    const ci = CYCLE.indexOf(current);
    if (ci < 0) return { ok: false, error: `unrecognized current mode: ${current}` };
    const steps = (ti - ci + CYCLE.length) % CYCLE.length;
    for (let i = 0; i < steps; i++) {
      const r = await this.#tmux.key(this.tmuxWindow, "BTab");
      // A failed key leaves the mode somewhere mid-cycle: report it instead
      // of verifying a cycle that never happened (a failed send used to be
      // ignored and the stale footer then "verified" the target).
      if (!r.ok) return { ok: false, error: `Shift+Tab ${i + 1}/${steps} failed: ${r.error ?? "tmux send-keys failed"}` };
      await sleep(120); // footer needs a beat to repaint between cycles
    }
    if (steps > 0) await sleep(250);
    const after = await this.#readPermissionModeFresh();
    // No hook fires on Shift+Tab: the fresh footer read verifies now, and the
    // next hook carrying permission_mode re-verifies (correcting the record if
    // the footer lied — #480's false success can no longer persist).
    if (this.#hooksLive) this.#modeSetTarget = { mode: target, at: Date.now() };
    if (after === target) {
      // The persistence cache advances only on a SUCCESSFUL write (as in
      // #notePermissionMode): a failed save left behind a cache that said
      // "done", so the next hook carrying the same mode never retried it.
      if (saveWindowRecord(this.id, { claudePermissionMode: after })) this.#persistedPermissionMode = after;
      else process.stderr.write(`[hook] ${this.id} setPermissionMode(${target}) verified but the record write FAILED — the next hook retries it\n`);
    }
    return after === target
      ? { ok: true, mode: after }
      : { ok: false, mode: after ?? undefined, error: `landed on ${after ?? "unknown"}` };
  }

  /** The permission mode off a FRESH capture's live footer; null when no live
   *  box is on screen (dialog, login form, spinner-only frame) or the capture
   *  failed. Unlike detectPermissionMode this never substitutes the last
   *  hook-reported mode: a Shift+Tab fires no hook, so around a cycle the hook
   *  value is exactly the stale reading that must not verify it (#480). */
  async #readPermissionModeFresh(): Promise<string | null> {
    const pane = await this.#captureBox();
    if (!pane.ok || !paneShowsReadyPrompt(pane.out)) return null;
    return parsePermissionModeFromPane(pane.out);
  }

  /** Stop: every command in flight is cancelled durably and the Escape path
   *  runs (the coordinator retries it until the turn's end confirms). */
  async abort(): Promise<{ ok: boolean; error?: string }> {
    return this.#coordinator.abortRunning(this.id);
  }

  /** Escape → Claude Code interactive interprets as "interrupt generation". */
  async #interruptPane(): Promise<InterruptResult> {
    // Snapshot the pending submit BEFORE the awaited capture: if a NEW dispatch
    // starts during that await, this (now possibly stale) abort must not cancel it.
    const submitBefore = this.#submitTimer;
    // …and the dispatch it belongs to: a submit that appears during the await
    // for the SAME in-flight item is that item finishing its typing, not a new
    // send (#35) — see below.
    const inflightBefore = this.#dispatchInFlight;
    // Stop = "stop trying": a scheduled 5xx auto-retry is cancellable work even
    // when the pane is idle (the failed prompt is not in flight, Claude sits at
    // an empty ready box during the backoff). It used to be cleared only past
    // the idle guard below, so a Stop during the backoff returned success and
    // the still-armed timer typed the stopped prompt again (#475).
    if (this.#retry) {
      this.#emitAgentNote(`Auto-retry cancelled`, Date.now(), this.claudeSessionId);
      this.#clearRetry();
    }
    this.#turn5xxStatus = null;

    // Block abort only when the session is unambiguously IDLE: an EMPTY ready box,
    // not generating, and no open turn / in-flight dispatch / pending submit. The
    // empty-box requirement is what makes this robust — a turn that's thinking either
    // shows "esc to interrupt" (empty box) OR holds text in the box, so it never
    // reads empty+idle. (#turn lags turn-start, and "esc to interrupt" is HIDDEN by
    // box text, both verified — neither is reliable alone.) Bias toward NOT blocking:
    // a stray Escape on idle is a no-op (Escape doesn't clear the box), whereas a
    // wrong block means "Stop did nothing". FRESH capture — a stale read here could
    // wrongly block a real abort.
    const pane = await this.#captureBox();
    // A genuinely NEW send appeared while we awaited the capture → this abort is
    // stale: the state it was issued against is gone and a fresh message is now in
    // flight. Return before touching anything (no Escape-interrupt, no clear). Note
    // a NULL #submitTimer here means the pre-abort submit simply FIRED (a turn is
    // starting) — that we still interrupt below; only a different, non-null timer is
    // a new send. EXCEPT when that timer belongs to the dispatch that was already
    // in flight when abort began: the drain types line by line over the FIFO and
    // arms the Enter only afterwards, so a cancel landing in the typing window
    // used to see "new timer ≠ snapshot" and walk away while the Enter fired and
    // the cancelled prompt ran to completion (#35). Same item → cancellable.
    const sameDispatchTyped = inflightBefore !== null && this.#dispatchInFlight === inflightBefore
      && this.#dispatchSubmittedAt === null;
    if (this.#submitTimer !== null && this.#submitTimer !== submitBefore && !sameDispatchTyped) return { kind: "noop" };
    // Require !#thinking: during the PRE-OUTPUT phase of a turn (long
    // initial cogitation) the transcript has no entries yet (#turn null), the
    // dispatch is already echo-confirmed (#dispatchInFlight null), and the
    // pane can momentarily lack the "esc to interrupt" marker mid-repaint —
    // all idle signals read false-idle and the abort was silently swallowed
    // (caught live by the e2e suite). The daemon's own thinking flag knows a
    // turn is in flight; trust it. (Outstanding background tasks do NOT make
    // an idle session abortable — Escape can't reach them; see below.)
    if (!this.#turn && !this.#dispatchInFlight && !this.#submitTimer && !this.#thinking &&
        Date.now() - this.#dispatchCancelledAt > 2_000 &&
        pane.ok &&
        paneShowsEmptyReadyPrompt(pane.out) && !paneShowsGenerating(pane.out)) {
      // Unambiguously idle: nothing to interrupt — a command still recorded
      // as running ended without a terminal we saw, and idle is the verdict.
      this.#driver.emit({ kind: "idle" });
      return { kind: "noop" };
    }
    // Cancel the pending submit Enter — but ONLY the one that was pending when abort
    // BEGAN, and only if one existed at all: submitBefore === null means the Enter
    // already FIRED before abort was called (dispatch delivered, awaiting its echo /
    // turn-start) — with a bare === both sides are null and the old check wrongly
    // classified that as "typed but not submitted", discarding + neutralizing a
    // message Claude already received (its later echo then mirrored as a duplicate
    // user bubble). A fired-or-never-armed submit has nothing to cancel. The one
    // addition: the in-flight item that finished typing DURING our capture and
    // armed its Enter just now (#35) — its Enter has not landed, so it is
    // cancellable exactly like a submit that was pending from the start.
    const sameSubmit = (submitBefore !== null && this.#submitTimer === submitBefore)
      || (sameDispatchTyped && this.#submitTimer !== null);
    if (sameSubmit) {
      // Aborting a message that was typed but NOT yet submitted (its Enter was still
      // pending): cancel that Enter AND discard the dispatch — Stop means the message is
      // gone, not re-queued. Clear the echo-timeout (else it would fire, re-queue the
      // aborted message, and pause the queue) and neutralize its receipt (it never
      // submitted, so it'll never echo — leaving the receipt would wrongly suppress a
      // later identical real message). The leftover text stays in the box — see the
      // no-clear note at the end of abort() for why that's deliberate.
      this.#clearSubmitTimer();
      if (this.#dispatchInFlight) {
        // Stop means the message is gone, not re-queued: cancel it durably,
        // then settle the submit — no echo will come.
        this.#coordinator.cancel(this.#dispatchInFlight.id);
        this.#settleDispatch("abort before submit", { kind: "rejected", permanent: false, detail: "aborted before submit" });
      }
    }
    const esc = await this.#tmux.key(this.tmuxWindow, "Escape");
    if (!esc.ok) return { kind: "failed", error: esc.error ?? "tmux send-keys failed" }; // the agent was NOT interrupted (#8)
    this.#setThinking(false);
    this.#needsInput = null; // Escape dismisses a permission prompt too
    // Interrupting mid-tool means Claude won't write that tool's result — close any
    // open tools so their cards don't spin forever.
    this.#closeOpenTools();
    // Show the user that the Stop landed. Emitted while #turn is still open so the
    // note lands inside the interrupted turn (a bare pending-submit abort has no
    // open turn, so #emitAgentNote opens+closes a standalone one).
    this.#emitAgentNote("Interrupted", Date.now(), this.claudeSessionId);
    // Escape ends the current turn, but an INTERRUPTED turn never produces a
    // turn-end in the transcript — so #turn would stay set forever. The drain gate
    // (#canDrain requires !#turn) would then block every following message, and
    // #drainOnce returns BEFORE arming a retry when #canDrain is false, so nothing
    // ever re-attempts: the next message the user sends hangs undispatched. Close
    // the turn explicitly here — emit a 'cancelled' turn-end (so the app closes the
    // turn too) and clear local turn state — then kick the queue so a message sent
    // right after the abort goes through.
    if (this.#turn) {
      this.#relay?.send(encodeTurnEnd("cancelled", { turn: this.#turn.turnId, time: Date.now() }));
      this.#turnUsage = null;
      this.#turn = null;
    }
    // The Escape landed: whatever was executing is over — the coordinator
    // confirms the cancel on this (the transcript's interrupt marker follows).
    this.#lastConfirmedRef = null;
    this.#driver.emit({ kind: "turn_ended", status: "cancelled" });
    this.#maybeDrainQueue();
    // Background tasks are DELIBERATELY untouched by abort: Escape interrupts
    // Claude's turn, not the background processes — the monitor keeps watching,
    // the build keeps building, and their <task-notification> completions still
    // arrive and parse (stream-end, TaskStop, and timeout forms all covered).
    // An earlier version cancelled the whole count here on the "completions
    // never land after an interrupt" premise; that stopped being true and it
    // wiped live status the moment the user pressed Stop (2026-07-09).
    // DELIBERATELY NO BOX CLEAR HERE — abort sends Escape and nothing else.
    // Abort used to arm a delayed clear (#abortClearTimer) to wipe leftover box
    // text; removed 2026-07-02 (docs/pane-input-clearing.md). Two reasons:
    //  1. It's redundant for correctness: every daemon type-site (#drainOnce,
    //     #steer) independently verifies an empty box and clears before typing,
    //     and the discard semantics above are enforced by receipt
    //     neutralization, not by the box being visually empty.
    //  2. It's the single riskiest moment to fire control keys: right after an
    //     interrupt is exactly when the pane may be stalled or job-control-
    //     cooked (keys are then swallowed, buffered for late delivery into
    //     whatever state comes next, or — as C-c/SIGINT — able to kill claude).
    // Accepted trade-off: an aborted-but-unsubmitted message stays visible in
    // the tmux pane until the next send's gate clears it (or indefinitely on an
    // abandoned session), where a human attached to the pane could submit it
    // with a stray Enter. Do not "fix" that by re-adding an abort-time clear.
    return { kind: "sent" };
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
      // One `literal` per line with a named Enter between them, like #typeLines:
      // under control mode the command line is serialized by tmuxQuoteArg, which
      // refuses a raw newline, so a multi-line literal failed outright with
      // "tmux send-keys failed" and nothing was typed (#39). (The disconnected
      // spawn path passed argv and happened to work — same text, two outcomes.)
      const lines = script.split(/\r\n|\r|\n/);
      for (let i = 0; i < lines.length; i++) {
        if (i > 0 && !(await this.#tmux.key(this.tmuxWindow, "Enter")).ok) return { ok: false, segments: lines.length, error: "tmux send-keys failed" };
        if (lines[i] !== "" && !(await this.#tmux.literal(this.tmuxWindow, lines[i])).ok) return { ok: false, segments: lines.length, error: "tmux send-keys failed" };
      }
      return { ok: true, segments: lines.length };
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
        ? (await this.#tmux.key(this.tmuxWindow,...seg.names)).ok
        : (await this.#tmux.literal(this.tmuxWindow,seg.text)).ok;
      if (!ok) return { ok: false, segments: segments.length, error: "tmux send-keys failed" };
    }
    return { ok: true, segments: segments.length };
  }

  async pane(color = false): Promise<{ ok: true; text: string }> {
    // -e includes ANSI SGR escape sequences (colors, bold, …) so the app can
    // render the TUI in color; without it the capture is plain text. A FRESH read
    // over control mode (colour stays uncached) — falls back to spawn while
    // disconnected. scrollbackLines = one extra screenful of history above the
    // visible region, so the app's pane view scrolls back twice as far as the
    // screen shows (#viewRows tracks the viewer's height via resize()).
    return { ok: true, text: (await this.#tmux.captureFresh(this.tmuxWindow, { color, scrollbackLines: this.#viewRows })).out };
  }

  // Viewer height (rows) from the last resize() — sizes the pane view's
  // scrollback capture. Default matches the resize clamp's typical phone view.
  #viewRows = 50;

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
    this.#viewRows = r; // pane view scrollback tracks the viewer's height
    const res = await this.#tmux.command(["resize-window", "-t", this.tmuxWindow, "-x", String(c), "-y", String(r)]);
    return { ok: res.ok };
  }

  // Cache keyed by (path, size, mtime): the transcript view refetches on focus,
  // and a whole-file parse of a multi-MB transcript blocks the event loop for
  // every session's timers. Unchanged file → same parsed array.
  #transcriptCache: { path: string; size: number; mtimeMs: number; lines: unknown[] } | null = null;

  transcript(): { lines: unknown[] } {
    if (!this.transcriptPath || !existsSync(this.transcriptPath)) return { lines: [] };
    let st: { size: number; mtimeMs: number };
    try { st = statSync(this.transcriptPath); } catch { return { lines: [] }; }
    const c = this.#transcriptCache;
    if (c && c.path === this.transcriptPath && c.size === st.size && c.mtimeMs === st.mtimeMs) {
      return { lines: c.lines };
    }
    const lines = readFileSync(this.transcriptPath, "utf-8").split("\n")
      .filter((l) => l.trim())
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
    this.#transcriptCache = { path: this.transcriptPath, size: st.size, mtimeMs: st.mtimeMs, lines };
    return { lines };
  }

  /**
   * Emit a standalone agent-side note (e.g. slash-command output) as a
   * response. Wraps it in a transient turn when none is open so the app
   * renders it left-aligned like Claude's replies, not as an outbound message.
   */
  /**
   * Replay-dedup + freshness gate for synthetic agent notes derived from
   * USER-type transcript entries (slash-command stdout — /model, /compact
   * notices — and !cmd output cards). The assistant path skips
   * already-forwarded entries via forwardedUuids, but these notes recorded NO
   * receipt at all, so every daemon restart's transcript replay re-pushed
   * every historical /model output, compaction notice, and bash card into the
   * chat ("a bunch of messages about switching to fable opus", 2026-07-04).
   * Two gates:
   *  - receipt: emit once per entry uuid, persisted across restarts;
   *  - freshness: an entry older than the tailer bind (60s grace) is history
   *    being replayed, not new output — record its receipt but never emit.
   *    This also stops a resume/--continue backfill from re-announcing old
   *    /model outputs onto a fresh card, and covers uuid-less entries.
   */
  #shouldEmitNote(entry: Record<string, unknown>, entryTimeMs: number): boolean {
    const uuid = typeof entry.uuid === "string" ? entry.uuid : "";
    const fresh = entryTimeMs >= this.#tailBoundAt - 60_000;
    if (uuid && this.#relay && this.relaySessionId) {
      if (this.#hasUuid(uuid) || this.#pendingNoteUuids.has(uuid)) return false;
      // In-memory dedupe NOW (this process won't re-emit) in a set SEPARATE
      // from the persisted receipt: the ledger receipt is stamped by
      // #emitAgentNote and written on the relay's ack; pre-recording it here
      // would make the ack a no-op and the note's receipt would never be
      // saved (#484). A crash between emit and ack re-emits on replay:
      // at-least-once, matching the assistant path.
      this.#pendingNoteUuids.add(uuid);
      if (this.#pendingNoteUuids.size > 500) {
        for (const u of this.#pendingNoteUuids) { this.#pendingNoteUuids.delete(u); if (this.#pendingNoteUuids.size <= 400) break; }
      }
      this.#nextNoteReceipt = uuid;
    }
    return fresh;
  }

  /** Note uuids emitted by THIS process whose outbound receipt has not been
   *  acked yet — in-memory replay dedupe only, never persisted (#484). */
  #pendingNoteUuids = new Set<string>();

  /** Entry types the daemon knows how to handle — the semantic-health
   *  baseline. Unknown types are fine in small numbers (forward compat);
   *  a long unbroken streak means the format moved under us. */
  static #KNOWN_ENTRY_TYPES = new Set([
    // Baseline measured against real transcripts (2026-07-12): the top-level
    // types Claude Code 2.1.x writes today.
    "user", "assistant", "system", "attachment", "queue-operation",
    "summary", "last-prompt", "file-history-snapshot", "progress",
    "agent-name", "ai-title", "custom-title", "mode", "permission-mode",
  ]);
  #unknownEntryStreak = 0;
  /** Hook-proposed transcript binding awaiting confirmation by activity on
   *  that exact path (review finding 4 / audit #6). Never load-bearing alone. */
  #pendingHookBinding: { sid: string; path: string; at: number } | null = null;

  /** Receipt uuid staged by #shouldEmitNote for the #emitAgentNote that
   *  immediately follows it (same synchronous block) — stamped onto the
   *  note's last queued relay row. */
  #nextNoteReceipt: string | null = null;

  #emitAgentNote(text: string, timeMs: number, sid?: string): void {
    if (this.#relay) {
      const opened = !this.#turn;
      const turnId = this.#turn?.turnId ?? crypto.randomUUID();
      if (opened) {
        this.#turn = { turnId, since: Date.now() };
        this.#relay.send(encodeTurnStart({ turn: turnId, time: timeMs }));
      }
      this.#relay.send(encodeTextEvent(text, { turn: turnId, time: timeMs }));
      if (opened) {
        this.#relay.send(encodeTurnEnd("completed", { turn: turnId, time: timeMs }));
        this.#turn = null;
      }
      // Note receipt (staged by #shouldEmitNote) rides the note's LAST row.
      if (this.#nextNoteReceipt && this.relaySessionId) {
        this.#relay.stampReceiptOnLastQueued({ uuid: this.#nextNoteReceipt, turn: "note" });
      }
    }
    this.#nextNoteReceipt = null;
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
      this.#emitAgentNote(`API ${status}: auto-retry exhausted after ${RETRY_SCHEDULE_SEC.length} attempts — giving up`, Date.now(), sid);
      this.#clearRetry();
      return;
    }
    const delaySec = RETRY_SCHEDULE_SEC[made];
    const attempt = made + 1;
    const nextAt = Date.now() + delaySec * 1000;
    if (this.#retry?.timer) clearTimeout(this.#retry.timer);
    this.#retry = { attempts: attempt, timer: setTimeout(() => this.#fireRetry(sid), delaySec * 1000) };
    void this.#relay?.updateRetry({ attempt, total: RETRY_SCHEDULE_SEC.length, nextAt, status });
    this.#emitAgentNote(`API ${status} — retrying in ${formatRetryDelay(delaySec)} (attempt ${attempt}/${RETRY_SCHEDULE_SEC.length})`, Date.now(), sid);
  }

  /** Fire a scheduled retry: re-send the failed prompt through the queue. */
  #fireRetry(sid?: string): void {
    if (!this.#retry) return;
    this.#retry.timer = null;
    const text = this.#lastUserText;
    if (!text) {
      this.#emitAgentNote(`Auto-retry: no prompt to re-send — giving up`, Date.now(), sid);
      this.#clearRetry();
      return;
    }
    // Re-send via the queue so it waits for the ready prompt, types, and a fresh
    // turn confirms it landed. If that turn 5xx-fails again, #turn5xxStatus is
    // re-armed and the turn-end handler calls #scheduleRetry for the next step.
    // mirrorToRelay so the re-sent prompt shows in chat (its bubble was the prior
    // turn's); visible:false — it's a system re-send, not an editable queue chip.
    try { this.#coordinator.accept({ sessionId: this.id, text, source: "rpc", mirrorToRelay: true, visible: false, origin: "reinjection" }); }
    catch (e) { process.stderr.write(`[retry] ${this.id}: could not queue the re-send: ${e instanceof Error ? e.message : e}\n`); }
  }

  /** Tear down any pending retry (timer + banner). */
  #clearRetry(): void {
    if (this.#retry?.timer) clearTimeout(this.#retry.timer);
    this.#retry = null;
    void this.#relay?.updateRetry(null);
  }

  /** A LOCAL slash command echoes as <command-name> markup — never as plain
   *  text, and the CLI fires no UserPromptSubmit for it. A daemon dispatch of
   *  "/goal clear" therefore executed fine but was never CONFIRMED: the echo
   *  timeout re-queued the already-run command and paused the queue (it then
   *  ran AGAIN on resume — seen live 2026-07-09). Confirm by command token.
   *  Reached from BOTH transcript shapes: legacy user-role string entries and
   *  the current CLI's system/local_command entries (2.1.198 moved the whole
   *  local-command family there — the user-branch fix was dead on arrival). */
  #confirmCommandEcho(content: string): void {
    const m = /<command-name>([^<]+)<\/command-name>/.exec(content);
    const echoedCmd = m?.[1]?.trim();
    const inflight = this.#dispatchInFlight;
    if (!echoedCmd || !inflight || inflight.text.trim().split(/\s+/)[0] !== echoedCmd) return;
    process.stderr.write(`[queue] ${this.id} command echo confirmed dispatch (${echoedCmd})\n`);
    this.#clearSubmitTimer();
    // No plain-text echo will EVER come for this dispatch: the command echo
    // IS its delivery (and its completion — see #settleDispatch).
    this.#settleDispatch("command echo", { kind: "accepted" });
    this.#maybeDrainQueue();
  }

  /** `<bash-input>` echo (either transcript shape): remember the command to
   *  head its output card and confirm the `!cmd` dispatch it proves (#40). */
  #noteBashInput(content: string): void {
    const m = /<bash-input>([\s\S]*?)<\/bash-input>/.exec(content);
    this.#pendingBashCmd = m ? stripAnsi(m[1]).trim() : "";
    this.#confirmBashEcho(this.#pendingBashCmd);
  }

  /** Bash output (`!cmd`, either transcript shape) → a structured card the app
   *  renders as a tool call: command in the header, stdout/stderr in the body.
   *  Parts are base64'd so arbitrary output can't break the block. Terminal
   *  escape codes stripped. */
  #emitBashCard(content: string, entry: Record<string, unknown>, entryTimeMs: number, sid: string | undefined): void {
    const so = /<bash-stdout>([\s\S]*?)<\/bash-stdout>/.exec(content);
    const se = /<bash-stderr>([\s\S]*?)<\/bash-stderr>/.exec(content);
    const stdout = so ? stripAnsi(so[1]).replace(/\s+$/, "") : "";
    const stderr = se ? stripAnsi(se[1]).replace(/\s+$/, "") : "";
    const cmd = this.#pendingBashCmd ?? "";
    this.#pendingBashCmd = undefined;
    if (this.#shouldEmitNote(entry, entryTimeMs)) {
      const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
      this.#emitAgentNote(`<bash-run><cmd>${b64(cmd)}</cmd><stdout>${b64(stdout)}</stdout><stderr>${b64(stderr)}</stderr></bash-run>`, entryTimeMs, sid);
    }
  }

  /** A `!cmd` dispatch never produces a user-text echo, a turn start, or a
   *  UserPromptSubmit hook (the CLI runs it locally) — so the only evidence it
   *  landed is its `<bash-input>` echo. Without this, delivery rested on the
   *  hook alone; on hook-less sessions the 30s timeout requeued an already-run
   *  `!make deploy` and "resume" ran it a second time (#40). Confirm when the
   *  echoed command equals the in-flight text minus its leading `!`. */
  #confirmBashEcho(echoedCmd: string): void {
    const inflight = this.#dispatchInFlight;
    if (!inflight || !echoedCmd) return;
    const m = /^\s*!\s*([\s\S]*)$/.exec(inflight.text);
    if (!m || flattenForMatch(m[1]) !== flattenForMatch(echoedCmd)) return;
    process.stderr.write(`[queue] ${this.id} bash echo confirmed dispatch (!${echoedCmd.slice(0, 40)})\n`);
    this.#clearSubmitTimer();
    this.#settleDispatch("bash echo", { kind: "accepted" });
    this.#maybeDrainQueue();
  }

  /**
   * Type `text` into the pane PRESERVING newlines: one `literal` per line with a C-j
   * (a real in-box linefeed, NOT a submit) between them. A single-line message is one
   * `literal` — unchanged. Does NOT clear or submit: the dispatch gate ensures the box
   * is empty first and #armSubmit owns the delayed Enter. NB no pre-clear control char
   * (C-u/C-c) is sent right before the C-j burst — that's what
   * Claude's paste-detection used to fold into the message as a stray \x15. Awaited in
   * order via the FIFO; returns false if any send fails (caller rolls back).
   */
  async #typeLines(text: string): Promise<boolean> {
    const lines = text.split(/\r\n|\r|\n/);
    for (let i = 0; i < lines.length; i++) {
      if (i > 0 && !(await this.#tmux.key(this.tmuxWindow, "C-j")).ok) return false;
      if (lines[i] !== "" && !(await this.#tmux.literal(this.tmuxWindow, lines[i])).ok) return false;
    }
    return true;
  }

  /** Type a message into the pane + record receipt + bump thinking. */
  async #typeIntoTmux(text: string, opts: SendOptions): Promise<void> {
    // The dispatch attempt (runtime_ref = the flattened text the echo is
    // matched on — we type REAL newlines, Claude echoes them multi-line, both
    // sides flatten) was committed by #drainOnce before this call. Commands
    // (`!bash`, `/slash`) never produce a user-text echo; their attempts are
    // settled by the command/bash echo or dialog confirms instead.
    // No pre-clear: the drain gate only dispatches into a box it has confirmed EMPTY
    // (clearing any leftover with the verified C-u loop first), so a C-u here is redundant — and
    // a control char right before the C-j burst is exactly what paste-detection folded
    // into the message as a stray \x15. Type goes over control mode (or spawn while
    // disconnected) IN ORDER via the FIFO; on failure throw so the drain re-queues
    // (and retires the attempt: nothing reached the pane, no echo will match it).
    if (!(await this.#typeLines(text))) {
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
   * /title <text>: set the session's conversation title directly. Titles are the relay
   * "summary" (normally Claude's generated ai-title); this overrides it with the user's
   * text and pushes it the same way — relay summary + a local session_update broadcast —
   * so the app shows it instead of "New Chat". A later ai-title entry can still overwrite
   * it (same as renaming in Claude). Bare `/title` (no text) is a no-op.
   *
   * A user's title (and a bare-`/title` unlock) is DURABLE FIRST (#474
   * residual): the record write used to be fire-and-forget, so on a full
   * or read-only state dir the command was acknowledged and the live
   * summary changed while the record kept the old title+lock — the next
   * replacement restored that, and the user's title silently vanished.
   * Now nothing in memory changes and nothing is published until the
   * title+lock commit lands; a failed write throws WindowRecordWriteError
   * out of the command handler, which the coordinator has not recorded
   * yet, so the caller sees a refusal (joy-send → `not_durable`, a relay
   * turn → failed) and the previous title and lock stand. The patch carries
   * launchCwd (as the pi/opencode title paths do) so a session that has no
   * record yet — a legacy window recovered without one — gets one rather
   * than a refusal.
   */
  #setTitle(title: string, opts?: { byUser?: boolean }): void {
    const t = title.trim();
    if (!t) {
      // Bare /title from the user = UNLOCK + revert to Claude's latest ai-title.
      if (opts?.byUser && this.#titleLocked) {
        if (!saveWindowRecord(this.id, { launchCwd: this.cwd, titleLockedByUser: false, userTitle: null })) throw new WindowRecordWriteError(this.id, "title unlock");
        this.#titleLocked = false;
        const ai = this.#readLatestAiTitle();
        if (ai) { this.summary = ai; void this.#relay?.updateSummary(ai); this.#deps.broadcast("session_update", this.toJSON()); }
      }
      return;
    }
    if (opts?.byUser) {
      if (!saveWindowRecord(this.id, { launchCwd: this.cwd, titleLockedByUser: true, userTitle: t })) throw new WindowRecordWriteError(this.id, "title");
      this.#titleLocked = true;
    }
    this.summary = t;
    void this.#relay?.updateSummary(t);
    this.#deps.broadcast("session_update", this.toJSON());
  }

  /** Mirror a dispatch's user bubble to the relay EXACTLY ONCE per item (#483):
   *  both the hook-confirm path and the delayed-Enter path may reach this for
   *  the same dispatch, in either order. */
  #mirrorDispatch(item: QueuedItem, text: string): void {
    if (item.mirrored) return;
    item.mirrored = true;
    this.#relay?.send(encodeUserMessage(text));
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
      if (!target || this.#dispatchInFlight !== target) return;  // dispatch gone (timeout/abort) → abandon
      // A turn flag is set at the submit mark. Our message hasn't submitted yet (this IS
      // the submit), so it can't have started a turn — this is almost always a stale /
      // lagging turn flag. Don't ONE-SHOT abandon (that strands the typed text until the
      // 20s timeout); RESCHEDULE and submit once the turn clears. Bounded by the dispatch
      // timeout: if it never clears, the item is re-queued and #dispatchInFlight changes,
      // so the guard above then abandons this chain.
      if (this.#turnRunning()) { this.#armSubmit(opts); return; }
      // Mirror + flip thinking ONLY after the Enter has actually gone out over the
      // wire — so the app never shows "sent" before the pane submitted. A failed
      // Enter (disconnect) leaves it unsent; the dispatch echo timeout surfaces it.
      const e = await this.#tmux.key(this.tmuxWindow, "Enter");
      if (!e.ok) return;
      // Re-validate AFTER the awaited Enter (it may have queued behind other control
      // commands): a kill / dispatch-timeout / abort that flipped state mid-await must
      // not let us publish stale "sent/thinking". (#turn can't have flipped from our
      // own Enter yet — the turn isn't detected until claude writes turn-start — so
      // this only catches an externally-changed state.) A dispatch the
      // UserPromptSubmit hook already confirmed DELIVERED during the await is not
      // stale state: the Enter went out and Claude took it. Treating it as
      // abandoned skipped the mirror, and the transcript echo was then eaten by
      // the pending receipt — the prompt ran but appeared in no chat (#483).
      const st: string = this.status; // re-read: it may have flipped to "ended" during the await
      const delivered = target.delivered === true;
      if (st === "ended" || !target || (this.#dispatchInFlight !== target && !delivered)) return;
      if (this.#dispatchInFlight === target && this.#turnRunning()) return;
      if (this.#dispatchInFlight === target) this.#dispatchSubmittedAt = Date.now(); // Enter is out — dialogs after this are ours
      this.#dlog(`submitted ${target.id}`);
      if (opts.mirrorToRelay) this.#mirrorDispatch(target, opts.text);
      this.#setThinking(true);
      // Trusted edge — the pane can't clear it — EXCEPT for a slash command,
      // which never generates (see takesThinkingLease). This is the dispatch
      // path: /clear fires no UserPromptSubmit hook, so the hook-side
      // exemption never ran, the lease held for 170s after every /clear, and
      // the relay turn stayed open with the user's next messages queued
      // behind it (fny 47457b0f, 2026-09-04: /clear at 10:12:51 completed
      // at 10:15:44).
      this.#thinkingLeaseUntil = Date.now() + thinkingLeaseMs(opts.text);
    }, ENTER_SUBMIT_DELAY_MS);
  }

  // ── Transcript watching ─────────────────────────────────────────────────────

  // 500ms cadence for the first 60s (trust prompts, slow first runs), then a
  // 5s heartbeat FOREVER. A session that recovers before its transcript exists
  // must still bind whenever Claude finally writes one — giving up leaves the
  // session permanently blind: dispatch confirmation, bg tasks, goal and
  // mirrored turns all silently stop working.
  pollForTranscript(attempts = 0): void {
    if (attempts === 0) {
      if (this.#transcriptPollActive) return; // a poll chain is already running
      this.#transcriptPollActive = true;
    }
    if (this.#tailer || this.status === "ended") {
      this.#transcriptPollActive = false;
      return;
    }
    if (this.transcriptPath) {
      // A pinned transcript — the --resume target, or a fresh session's own
      // --session-id file. Tail it once it appears (a fresh one is created by
      // Claude on first turn). Do NOT fall back to mtime discovery: that's the
      // race that let two sessions in one cwd tail each other's transcript.
      if (existsSync(this.transcriptPath)) {
        this.#transcriptPollActive = false;
        this.startTailer(this.transcriptPath);
        return;
      }
    } else {
      // Unpinned legacy path: discover the newest transcript in the cwd —
      // skipping one already tailed by a sibling session in the same cwd.
      const path = findLatestTranscript(cwdToTranscriptDir(this.cwd), this.startedAt);
      if (path && !this.#deps.isTranscriptClaimed?.(path, this.id)) {
        this.#transcriptPollActive = false;
        this.startTailer(path);
        return;
      }
    }
    if (attempts === 120) {
      process.stderr.write(`[transcript] WARN: no transcript found for ${this.id} after 60s — dropping to slow poll (5s) until one appears\n`);
    }
    setTimeout(() => this.pollForTranscript(attempts + 1), attempts < 120 ? 500 : 5000);
  }

  /**
   * Attach (or with force=true, re-attach) the JSONL tailer. force is the
   * seam for the future /branch//fork/--resume handling, where Claude rotates
   * its session id and starts writing a new transcript file.
   */
  /** When the current tailer bound — the freshness horizon for synthetic agent
   *  notes (#shouldEmitNote): entries older than this are history being
   *  replayed, not new output. */
  #tailBoundAt = 0;

  startTailer(transcriptPath: string, force = false): void {
    if (this.#tailer) {
      if (!force) return;
      this.#tailer.close();
      this.#tailer = null;
      // A checkpoint armed for the OLD file must not fire against the new
      // binding (#37) — the new tailer's first entry re-arms it.
      if (this.#checkpointTimer) { clearTimeout(this.#checkpointTimer); this.#checkpointTimer = null; }
    }
    this.transcriptPath = transcriptPath;
    // --continue backfill cap: --continue replays a full-history transcript from
    // offset 0, flooding the relay for a huge session. --resume caps this at
    // create (its file is known), but --continue's file isn't known until it
    // binds — so compute the turn-snapped tail offset HERE, once. Guard on a
    // zero start offset (resume-by-id already set its own) so this can't fight
    // that path, and clear the cap after so a forced re-tail won't re-skip.
    if (this.#backfillCapBytes > 0 && this.#transcriptStartOffset === 0) {
      this.#transcriptStartOffset = cappedTailOffset(transcriptPath, this.#backfillCapBytes);
    }
    this.#backfillCapBytes = 0;
    this.#tailBoundAt = Date.now();
    // Identity guard (5.6-sol verify #6): a queued callback from a CLOSED
    // old tailer must not process entries as if from the new binding — it
    // could confirm a staged binding against the wrong file. Each callback
    // checks it still belongs to the ACTIVE tailer.
    let self: TranscriptTailer | null = null;
    this.#tailer = self = tailJsonl(
      transcriptPath,
      (entry) => {
        if (this.#tailer !== self) return; // stale tailer — rebound since
        this.onTranscriptEntry(entry);
        this.#deps.broadcast("transcript_entry", { session_id: this.claudeSessionId, entry });
        this.#scheduleCheckpoint(transcriptPath);
      },
      () => this.status !== "ended",
      this.#transcriptStartOffset,
      // Tailer health (codex review finding 6): a format/read breakdown used
      // to look exactly like an idle session. Surface a one-shot loud note so
      // the user learns the daemon needs an update instead of assuming Claude
      // went quiet.
      (h) => {
        const what = h.kind === "parse"
          ? "transcript format unrecognized — a Claude Code update likely changed it; update joy-daemon"
          : "transcript unreadable — daemon cannot read the session transcript";
        this.#emitAgentNote(`${what} (${h.consecutive} consecutive failures)`, Date.now(), this.claudeSessionId);
      },
    );
  }

  /** Debounced transcript-checkpoint persist (codex review finding 8): the
   *  tail offset after the last processed entry, written at most every 5s.
   *  Safe to advance immediately after processing — an entry's outbound rows
   *  are already in the persisted relay queue by then, so a restart resuming
   *  AT the checkpoint re-mirrors nothing and misses nothing. */
  #checkpointTimer: ReturnType<typeof setTimeout> | null = null;
  #scheduleCheckpoint(_transcriptPath: string): void {
    if (this.#checkpointTimer) return;
    this.#checkpointTimer = setTimeout(() => {
      this.#checkpointTimer = null;
      // The ACTIVE binding at fire time, never the path captured when the
      // timer was armed: a /clear rebinds the tailer inside the 5s window, and
      // the stale closure then persisted {path: OLD file, offset: NEW tailer's
      // offset} — recover() prefers a checkpoint whose file exists, so a
      // restart re-bound the dead pre-/clear conversation at a bogus offset
      // (nothing mirrored, every dispatch timing out) (#37).
      const transcriptPath = this.transcriptPath;
      if (!transcriptPath || !this.#tailer) return;
      // HOLD the checkpoint while the outbox can't persist (5.6-sol audit
      // #2): advancing past entries whose mirror rows exist only in memory
      // makes a crash lose the rows AND the replay window that would have
      // re-mirrored them. Held checkpoints just mean a bigger (receipt-
      // deduped) replay after restart — safe, merely slower.
      if (this.#relay?.outboundPersistDegraded) {
        process.stderr.write(`[checkpoint] ${this.id}: outbound persistence degraded — holding checkpoint\n`);
        return;
      }
      const off = this.#tailer?.offset() ?? 0;
      if (off > 0 && this.status !== "ended") {
        // Committed only once every outbox row of this session so far is
        // acked (pending until then): a crash before that replays from the
        // previous checkpoint instead of skipping the rows (#67).
        try { this.#ledger.setCheckpoint(this.id, "claude_transcript", transcriptPath, off, { throughSeq: "latest" }); }
        catch (e) { process.stderr.write(`[checkpoint] ${this.id}: ledger write failed: ${e instanceof Error ? e.message : e}\n`); }
      }
    }, 5_000);
  }

  /** True if the pid is alive — a plain syscall, NOT a spawned `kill` binary
   *  (this runs every 5s per session; fork+exec for it was pure waste). */
  static #pidAlive(pid: number): boolean {
    try { process.kill(pid, 0); return true; } catch { return false; }
  }

  /** PID-death detection: poll every 5s; on exit, run the full teardown. */
  #pollEnd(): void {
    if (this.status === "ended") return;
    // A pid that is the pane's LOGIN SHELL is not Claude's pid (#30): create()
    // resolves the pid ~800ms after typing the launch command and falls back to
    // the shell when a slow profile (nvm/pyenv/conda) has not forked claude
    // yet. The shell is immortal, so "pid alive" never became false and a
    // later Claude exit was never detected — the card stayed "running" and the
    // lane kept offering prompts into a dead pane. Treat it as unresolved: try
    // to re-resolve from the shell's child each tick, and once the session is
    // active, a shell with NO child is a Claude that exited (the startup
    // watchdog owns the not-yet-forked case while status is "starting").
    if (this.pid !== undefined && this.status !== "starting" && this.pid === this.#paneShellPid()) {
      const fresh = this.#resolvePidFromPane();
      if (fresh !== undefined) {
        process.stderr.write(`[end] ${this.id}: pid ${this.pid} was the pane shell — re-resolved claude as ${fresh} (#30)\n`);
        this.pid = fresh;
        this.#noProcessPasses = 0;
      } else {
        const pane = this.#tmux.captureCached(this.tmuxWindow);
        const textAlive = pane.ok && (dialogFromPane(pane.out) != null || paneShowsClaudeRunning(pane.out));
        this.#noProcessPasses += 1;
        if (!textAlive || this.#noProcessPasses > 12) {
          process.stderr.write(`[end] ${this.id}: pid ${this.pid} is the pane shell and it has no child → claude exited → detached (#30)\n`);
          this.end("process_exited");
          return;
        }
      }
      setTimeout(() => this.#pollEnd(), 5000);
      return;
    }
    if (this.pid !== undefined && !Session.#pidAlive(this.pid)) {
      // The cached pid can be stale or plain wrong: launch grabs the shell's
      // first child 800ms in (which may not be claude), and claude can re-exec
      // itself (self-update). A dead cached pid while Claude runs on caused
      // false "detached" sessions. Before declaring death, re-resolve from the
      // pane itself; only end when the pane also shows no live Claude.
      const fresh = this.#resolvePidFromPane();
      if (fresh !== undefined) {
        this.pid = fresh;
        this.#noProcessPasses = 0; // real process evidence resets the grace
      } else {
        const pane = this.#tmux.captureCached(this.tmuxWindow);
        // An open dialog hides every "claude is running" marker (verified live:
        // model picker/confirm/effort all read running=false) — but a dialog on
        // screen IS a live claude. Without this, a stale pid + open dialog
        // would tear the session down as process_exited. BOUNDED grace though:
        // pane TEXT is not process evidence — a dead claude can leave dialog
        // content on screen (frozen pane, dialog above the returned shell
        // prompt), so after ~1 min of dialog-only liveness we require real
        // markers again and tear down (gpt-5.6-sol review finding 4).
        // Pane TEXT is not process evidence. A dialog or the "running"
        // markers on screen buy a bounded grace (~1 min) for the cases where
        // the pid is momentarily unresolvable (mid re-exec), after which a
        // dead pid with no child under the shell is a dead claude — whatever
        // the frozen frame says. ONE counter for both heuristics: a frame
        // that matched both (the folder-trust prompt does) let each reset
        // the other and never expired (Astra on 2f803b14).
        const dialogText = pane.ok && dialogFromPane(pane.out) != null;
        const runningText = pane.ok && paneShowsClaudeRunning(pane.out);
        this.#noProcessPasses += 1;
        const textAlive = (dialogText || runningText) && this.#noProcessPasses <= 12;
        if (!textAlive) {
          process.stderr.write(`[end] ${this.id}: pid ${this.pid} gone, no child under the pane shell${dialogText || runningText ? " (frozen frame ignored after 60s)" : ""} → detached\n`);
          this.end("process_exited");
          return;
        }
        // The pane still shows Claude (pid unresolvable right now — e.g. mid
        // re-exec). Keep watching; the next tick re-resolves.
      }
    } else {
      this.#noProcessPasses = 0; // pid alive — grace not in use
    }
    setTimeout(() => this.#pollEnd(), 5000);
  }

  /** The pane's login-shell pid (#{pane_pid}), memoized — it never changes for
   *  the life of the window, and #pollEnd asks every 5s (#30). */
  #shellPid: number | undefined;
  #paneShellPid(): number | undefined {
    if (this.#shellPid !== undefined) return this.#shellPid;
    const shell = this.#tmux.runSync("display-message", "-t", this.tmuxWindow, "-p", "#{pane_pid}");
    if (!shell.ok) return undefined;
    const pid = parseInt(shell.out.trim());
    if (isNaN(pid)) return undefined;
    this.#shellPid = pid;
    return pid;
  }

  /** Re-derive Claude's pid from the pane's shell: its live first child. */
  #resolvePidFromPane(): number | undefined {
    const shellPid = this.#paneShellPid();
    if (shellPid === undefined) return undefined; // window gone → let the caller end the session
    const child = parseInt(run("pgrep", "-P", String(shellPid)).out.split("\n")[0]);
    if (!isNaN(child) && child !== this.pid && Session.#pidAlive(child)) return child;
    return undefined;
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
  /** Trusted-positive thinking lease (codex review finding 7): after a
   *  hook/echo-confirmed submit, the PANE POLL may not clear thinking — a
   *  broken spinner matcher cleared it ~6s into a long pre-output think,
   *  releasing held drafts early. Only trusted negative edges (Stop hook,
   *  turn-end/error, abort, Notification) or lease expiry clear it; every
   *  accepted clear voids the lease. Sized just under the app's 3-min TTL. */
  #thinkingLeaseUntil = 0;

  #setThinking(thinking: boolean): void {
    if (!thinking) this.#thinkingLeaseUntil = 0; // any accepted clear ends the lease
    this.#thinking = thinking;
    this.#relay?.setThinking(thinking);
  }

  /** A task launch/completion or a <joy-bg> tag changes the split, so schedule a
   *  single coalesced re-derive on a short trailing timer — a burst (the recovery
   *  backfill, or several launches in a turn) collapses to ONE derive+push of the
   *  final state. Derive-based (not incremental) because a task's long-running
   *  classification arrives in a SEPARATE, later entry than its launch, so only a
   *  full re-scan sees both together. */
  #scheduleTaskReconcile(): void {
    if (this.#tasksPushTimer) return; // already scheduled
    this.#tasksPushTimer = setTimeout(() => {
      this.#tasksPushTimer = null;
      this.#reconcileBgTasks();
    }, 150);
  }

  /** Replay the whole transcript to compute the TRUE background state, split in
   *  two: FINISHING tasks (the N/M counter, reset-on-empty-batch semantics) and
   *  LONG-RUNNING processes (ids the agent tagged <joy-bg long-running> — servers/
   *  daemons that never "complete", so they're counted separately and never sit
   *  in the N/M where they'd stick at 0/1). */
  #deriveBgTasks(): ReturnType<typeof classifyBgTasks> {
    const emptyG = { outstanding: new Set<string>(), total: 0, done: 0 };
    const empty = { shell: { ...emptyG }, agent: { ...emptyG }, longRunning: new Set<string>(), outstanding: new Set<string>(), total: 0, done: 0 };
    if (!this.transcriptPath || !existsSync(this.transcriptPath)) return empty;
    // Incremental scan: transcripts are append-only, so parse only the bytes
    // added since the last derive (a whole-file re-parse ran every 150ms-coalesced
    // event AND every 60s for the life of any long-running process — ~100ms of
    // blocking JSON.parse per tick on multi-MB transcripts). The cache holds the
    // ordered task events, long-running ids, and the latest goal_status; it
    // resets when the transcript rotates (path change) or shrinks (rewrite).
    if (this.#scan?.path !== this.transcriptPath) this.#scan = null;
    const scan = this.#scan ?? (this.#scan = {
      path: this.transcriptPath, offset: 0,
      events: [], lrIds: new Set<string>(), lastGoal: null,
    });
    try {
      const size = statSync(scan.path).size;
      if (size < scan.offset) { scan.offset = 0; scan.events = []; scan.lrIds = new Set(); scan.lastGoal = null; }
      if (size > scan.offset) {
        const fd = openSync(scan.path, "r");
        try {
          const buf = Buffer.alloc(size - scan.offset);
          readSync(fd, buf, 0, buf.length, scan.offset);
          // Consume only complete lines; a trailing partial line (mid-write or a
          // split multi-byte char) is left for the next pass.
          const end = buf.lastIndexOf(0x0a);
          if (end >= 0) {
            scan.offset += end + 1;
            for (const line of buf.subarray(0, end).toString("utf-8").split("\n")) {
              if (!line.trim()) continue;
              let entry: unknown;
              try { entry = JSON.parse(line); } catch { continue; }
              const ev = bgTaskEvent(entry);
              // Stamp launches so a completion that never arrives can age out
              // (see classifyBgTasks) instead of pinning the counter forever.
              if (ev) scan.events.push(ev.kind === "launch"
                ? { ...ev, atMs: Date.parse(String((entry as { timestamp?: string }).timestamp || "")) || Date.now() }
                : ev);
              for (const id of joyBgLongRunningIds(entry)) scan.lrIds.add(id);
              const g = goalStatusFromEntry(entry);
              if (g) {
                const atMs = Date.parse(String((entry as { timestamp?: string }).timestamp || "")) || Date.now();
                scan.lastGoal = { ...g, atMs };
              }
            }
          }
        } finally { closeSync(fd); }
      }
    } catch {
      // Transient fs error (stat/open EBUSY, rotation race): fall back to the
      // cached scan instead of returning empty — an empty result wrongly
      // CLEARED a live N/M count, and the 60s self-heal then gated itself off
      // (it no-ops when nothing is outstanding).
      if (!this.#scan) return empty;
    }
    // Replay, classifying each task by lrIds (the long-running tag can trail its
    // launch by a few entries, which is why classification happens at the end).
    return classifyBgTasks(scan.events, scan.lrIds);
  }

  /** Re-derive from the transcript and push BOTH the finishing N/M (joy__tasks)
   *  and the live long-running-process count (joy__longRunning), each cleared to
   *  null when empty. Also the self-heal for a stuck/orphaned count. */
  #reconcileBgTasks(): void {
    const d = this.#deriveBgTasks();
    this.#bgTasks = d.outstanding; // union — busy()/self-heal want "any finishing task"
    this.#longRunning = d.longRunning;
    // Clean split: shell/bash finishing tasks → joy__tasks (teal); background
    // AGENTS → joy__agents (magenta, ranks above teal). No combined fallback —
    // the app renders both natively.
    const tasks = d.shell.outstanding.size > 0 ? { done: d.shell.done, total: d.shell.total } : null;
    const agents = d.agent.outstanding.size > 0 ? { done: d.agent.done, total: d.agent.total } : null;
    const longRunning = d.longRunning.size > 0 ? d.longRunning.size : null;
    const key = JSON.stringify({ tasks, agents, longRunning });
    if (key === this.#lastBgKey) return;
    const relay = this.#relay;
    if (!relay) return;
    void relay.updateBgTasks(tasks, agents, longRunning).then(() => { this.#lastBgKey = key; }, () => { });
  }

  /** Apply a parsed /goal status: a met=false goal is ACTIVE (push it, keeping
   *  `since` stable while the condition is unchanged); met=true clears it. */
  #applyGoalStatus(status: { condition: string; met: boolean }, atMs: number): void {
    const next: JoyGoalInfo | null = status.met
      ? null
      : { condition: status.condition, since: this.#goal?.condition === status.condition ? this.#goal.since : atMs };
    if (next?.condition === this.#goal?.condition && next?.since === this.#goal?.since) return; // no change
    this.#goal = next;
    void this.#relay?.updateGoal(next);
  }

  /** Re-derive the active goal from the transcript (the LAST goal_status wins)
   *  and push it — used on (re)attach so a restart doesn't drop/stick the bar.
   *  Rides the shared incremental scan instead of re-reading the whole file. */
  #reconcileGoal(): void {
    this.#deriveBgTasks(); // advance the shared scan to the end of the transcript
    const latest = this.#scan?.lastGoal ?? null;
    process.stderr.write(`[goal] ${this.id} reconcile: lastGoal=${latest ? `met=${latest.met}` : "none"}\n`);
    this.#goal = null; // force #applyGoalStatus to treat the derived value as fresh
    if (latest) this.#applyGoalStatus(latest, latest.atMs);
    else void Promise.resolve(this.#relay?.updateGoal(null)).catch((e) => process.stderr.write(`[goal] updateGoal(null) failed: ${e}\n`));
  }

  setHandoff(info: import("../relay/relay").JoyHandoffInfo | null): void { saveWindowRecord(this.id, { handoff: info }); void this.#relay?.updateHandoff(info); }
  /** PreCompact hook fired: Claude is compacting. Surface the "compacting"
   *  status and arm a backstop timeout in case the compact_boundary record that
   *  normally clears it never arrives (compaction can run for minutes — see the
   *  174s observed — so the window is generous). */
  /**
   * Claude Code hook event (POST /sessions/:id/hook from the generated
   * joy-hook.mjs — see hooks.ts). Hooks are LIVE STATE EDGES: instant,
   * machine-generated signals for exactly the states the pane/transcript
   * heuristics infer with lag or guesswork. They TIGHTEN state, they never
   * carry it alone — a session without hooks (adopted orphan, old settings
   * snapshot, daemon downtime while firing) behaves exactly as before.
   */
  onHookEvent(ev: Record<string, unknown>): { ok: boolean } {
    if (this.status === "ended") return { ok: false };
    const name = String(ev.event ?? "");
    const str = (k: string) => (typeof ev[k] === "string" && ev[k] ? String(ev[k]) : null);
    if (!name) return { ok: false };
    // IDENTITY FENCE — before anything below changes authority. The route is
    // the joy session id, which a restart's replacement inherits, so a
    // delayed forwarder request from the PREDECESSOR process can reach this
    // object. Two identities ride the wire and both are checked first:
    //
    // 1. LAUNCH: the daemon exported a per-launch identity into this claude's
    //    env and the forwarder echoes it as launch_id. An event that does not
    //    carry OURS is another process's — the predecessor a restart retired
    //    under this same route id (a same-conversation --resume replacement
    //    even shares its sid, which the sid check cannot see), or a claude
    //    launched by hand without the env. A session recorded WITHOUT a launch
    //    id (launched before the field existed, or adopted) has nothing to
    //    fence on and accepts any launch; the live-process check in
    //    #armHookSessionEnd backstops that case.
    // 2. CONVERSATION: an event for a conversation other than the bound one is
    //    a stale process's (or a sibling's). SessionStart is the legitimate
    //    rotation (/clear mints a new id; the case below adopts it), a
    //    "starting" session has nothing bound yet, and a staged (hook-
    //    proposed, not yet activity-confirmed) sid is this process's own.
    //
    // A fenced-out event changes nothing: no latch, no mode, no pending end
    // withdrawn or armed, no turn edge, no confirm.
    const launch = str("launch_id");
    if (this.#launchId && launch !== this.#launchId) {
      process.stderr.write(`[hook] ${this.id} ${name} from launch ${launch ?? "(none)"} ≠ ours ${this.#launchId} — ignored (not this process)\n`);
      return { ok: false };
    }
    const sid = str("session_id");
    if (sid && this.claudeSessionId && sid !== this.claudeSessionId && name !== "SessionStart"
        && this.status !== "starting" && this.#pendingHookBinding?.sid !== sid) {
      process.stderr.write(`[hook] ${this.id} ${name} for sid ${sid} ≠ bound ${this.claudeSessionId} — ignored (not this process)\n`);
      return { ok: false };
    }
    // ACTOR: a subagent's event (agent_id — tool hooks fire for subagents
    // too) says nothing about the MAIN agent's turn, wait or mode. It still
    // proves the process lives (latch, pending end), and PermissionRequest is
    // honoured per actor; everything else below is main-agent state.
    const actor = str("agent_id");
    // Any event from this process flips the authority latch — even one the
    // switch below does not know (a newer hook set is still proof the
    // forwarder is installed). SessionEnd is the one event that must NOT
    // clear a pending end; every other one proves the process lives on.
    this.#markHooksLive(name);
    if (name !== "SessionEnd" && this.#hookSessionEnd) {
      process.stderr.write(`[hook] ${this.id} ${name} after SessionEnd(${this.#hookSessionEnd.reason}) — the process lives on, teardown withdrawn\n`);
      this.#hookSessionEnd = null;
      if (this.#hookSessionEndTimer) { clearTimeout(this.#hookSessionEndTimer); this.#hookSessionEndTimer = null; }
    }
    // permission_mode is the MAIN agent's only on the main agent's own events:
    // a subagent runs under its own mode, and SubagentStop reports the
    // subagent's — neither may be persisted as the session's mode.
    if (!actor && name !== "SubagentStop") this.#notePermissionMode(str("permission_mode"), name);
    switch (name) {
      case "PreCompact": {
        this.markCompacting(str("trigger") ?? "auto");
        return { ok: true };
      }
      case "SessionEnd": {
        // Claude is EXITING (or rotating its conversation). Exit-class reasons
        // tear the session down as process_exited — the pane's frozen frame
        // and the 60s text grace no longer decide liveness (#30's shell-pid
        // case included: the shell being alive was never evidence). clear /
        // resume rotate the conversation inside a live process (SessionStart
        // follows) and end nothing. The hook runs INSIDE the exiting process,
        // so the pid is still alive here: confirm after a short grace, and a
        // pid that is still alive then wins (a replacement under the same id
        // whose predecessor's hook arrived late must never be torn down).
        // The wire field is `reason` (Claude Code's SessionEnd input); the
        // forwarder ships it as end_reason and older forwarders shipped only a
        // (never-present) input.end_reason — so a real /clear read as "other"
        // and an unresolved-pid session was detached on a rotation. Accept both.
        const reason = str("end_reason") ?? str("reason") ?? "other";
        if (reason === "clear" || reason === "resume") {
          process.stderr.write(`[hook] ${this.id} SessionEnd reason=${reason} — conversation rotation, session stays\n`);
          return { ok: true };
        }
        if (sid && this.claudeSessionId && sid !== this.claudeSessionId) {
          process.stderr.write(`[hook] ${this.id} SessionEnd for sid ${sid} ≠ bound ${this.claudeSessionId} — ignored\n`);
          return { ok: true };
        }
        if (this.status === "starting") {
          // The startup watchdog owns a claude that dies before its first
          // transcript entry (and a restart replacement is "starting" while
          // its predecessor's late SessionEnd could still arrive).
          process.stderr.write(`[hook] ${this.id} SessionEnd reason=${reason} while starting — left to the startup watchdog\n`);
          return { ok: true };
        }
        process.stderr.write(`[hook] ${this.id} SessionEnd reason=${reason} — confirming exit in ${HOOK_SESSION_END_GRACE_MS}ms\n`);
        this.#hookSessionEnd = { reason, at: Date.now() };
        this.#needsInput = null;
        this.#armHookSessionEnd();
        return { ok: true };
      }
      case "SessionStart": {
        // Authoritative transcript binding: claude tells us its session id and
        // transcript path at startup — no mtime discovery, no cwd-collision
        // races, and a pending --continue backfill cap computes against the
        // TRUE file at bind (startTailer). Fires on startup/resume/clear.
        const sid = str("session_id");
        const tp = str("transcript_path");
        process.stderr.write(`[hook] ${this.id} SessionStart sid=${sid ?? "?"} source=${str("source") ?? "?"}\n`);
        if (str("source") === "startup") this.#authFailure = null; // a fresh process starts with whatever creds it has
        this.#needsInput = null;
        // STAGED binding (review finding 4, built per 5.6-sol audit #6): the
        // hook proposes {sid, path}; transcript ACTIVITY on that exact path
        // confirms it (see the starting-activation block) — persisting a sid
        // even when entries stop carrying entry.sessionId, without hooks ever
        // carrying the binding alone. Conflicts with an already-learned sid
        // are logged loudly, not silently overwritten.
        const learnedConflict = !!(sid && this.claudeSessionId && sid !== this.claudeSessionId && this.status !== "starting");
        if (learnedConflict && str("source") === "clear") {
          // /clear ROTATES the conversation: Claude minted a new session id
          // and the old one is finished. The hook is authoritative here —
          // keeping the learned id left restart/resume pointing at the dead
          // conversation (fny 47457b0f, 2026-09-04). Adopt and persist it.
          process.stderr.write(`[hook] ${this.id} SessionStart after /clear: ${this.claudeSessionId} → ${sid} (adopted)\n`);
          this.claudeSessionId = sid!;
          saveWindowRecord(this.id, { claudeSessionId: sid! });
        } else if (learnedConflict) {
          // A LEARNED (transcript-confirmed) sid outranks a hook claim — log
          // loudly, stage for activity-confirmation, but do NOT overwrite
          // (5.6-sol verify #6: mismatch was logged and then clobbered anyway).
          process.stderr.write(`[hook] ${this.id} SessionStart sid MISMATCH: hook=${sid} learned=${this.claudeSessionId} — keeping learned\n`);
        } else if (sid && this.status !== "starting") {
          // Already-active session: the hook refines an existing binding.
          this.claudeSessionId = sid;
        }
        // Starting sessions get the sid ONLY via activity confirmation (the
        // staged-binding contract: hooks never carry the binding alone).
        if (sid && tp) this.#pendingHookBinding = { sid, path: tp, at: Date.now() };
        if (tp && tp !== this.transcriptPath) {
          if (this.#tailer) {
            // Bound to a DIFFERENT file (mtime discovery guessed wrong, or a
            // /clear rotated the conversation) — rebind. Receipts dedup the
            // replay — and when the target file has a persisted checkpoint,
            // resume THERE: a full from-zero replay of a long transcript is
            // no longer receipt-covered once the logs prune (audit #6).
            const cp = this.#ledger.getCheckpoint(this.id, "claude_transcript");
            this.#transcriptStartOffset = (cp && cp.ref === tp) ? cp.offset : 0;
            process.stderr.write(`[hook] ${this.id} rebinding transcript ${this.transcriptPath} → ${tp} (offset ${this.#transcriptStartOffset})\n`);
          }
          this.startTailer(tp, true);
        } else if (!this.#tailer && tp) {
          this.transcriptPath = tp; // file may not exist yet — the pinned-poll picks it up
          this.pollForTranscript();
        }
        return { ok: true };
      }
      case "UserPromptSubmit": {
        // A prompt was REALLY submitted — the authoritative version of the
        // signals the dispatch pipeline infers from echo timers and turn
        // starts. Thinking flips on at the submit instant (the "thinking never
        // shows at turn start" gap), and a text match against the in-flight
        // dispatch confirms delivery outright — no echo-timeout heuristics,
        // no confirm-on-foreign-turn races.
        this.#setThinking(true);
        this.#needsInput = null;
        this.#hookTurn = { open: true, at: Date.now() };
        const prompt = str("prompt");
        // Trusted edge — the pane can't clear it. See takesThinkingLease for
        // why a slash command is exempt.
        this.#thinkingLeaseUntil = Date.now() + thinkingLeaseMs(prompt);
        this.#idlePolls = 0;
        const flat = prompt ? flattenForMatch(prompt) : null;
        if (flat && this.#dispatchInFlight && flat === flattenForMatch(this.#dispatchInFlight.text)) {
          process.stderr.write(`[hook] ${this.id} UserPromptSubmit confirmed dispatch\n`);
          const item = this.#dispatchInFlight;
          // The hook proves the submit landed: mirror the bubble here if the
          // Enter callback has not yet (it may still be awaiting its write) —
          // exactly once between the two paths (#483).
          if (item.mirrorToRelay) this.#mirrorDispatch(item, item.text);
          this.#clearSubmitTimer(); // our delayed Enter would fire into an empty box — harmless, but don't
          this.#settleDispatch("UserPromptSubmit", { kind: "accepted" });
        } else if (flat) {
          // The prompt reached Claude by ANOTHER route (a steer whose Enter
          // landed, typing in the pane): the coordinator pairs the echo with
          // the steer's attempt, or records a foreign turn. A copy of the same
          // text still QUEUED would re-deliver later as a duplicate turn (seen
          // live with a steered "/goal clear" stuck in the spool): cancel it.
          this.#driver.emit({ kind: "echo", runtimeRef: flat });
          const dup = this.#coordinator.snapshot(this.id).commands.find((c) => c.state === "queued" && flattenForMatch(c.text) === flat);
          if (dup) {
            process.stderr.write(`[hook] ${this.id} UserPromptSubmit dropped queued duplicate ${dup.id}\n`);
            this.#coordinator.cancel(dup.id);
          }
        }
        // THE turn edge: this prompt's turn is open (ours when the ref pairs
        // with an attempt, foreign otherwise — a turn start never confirms a
        // dispatch by itself, #32).
        this.#driver.emit({ kind: "turn_started", runtimeRef: flat ?? this.#lastConfirmedRef });
        return { ok: true };
      }
      case "Stop": {
        // Turn finished. The transcript's end_turn/turn_duration entries also
        // land, but this fires first — thinking clears instantly and the next
        // queued message dispatches without waiting for tailer lag. With
        // hooks live this is THE idle edge; the pane's "esc to interrupt"
        // read is a tie-breaker only (#pollThinking). THE turn edge: the
        // transcript's #turn may stay open until the tailer reaches
        // turn_duration and the pane may still paint the generating footer —
        // neither holds the queue or busy() once this has fired (#turnRunning).
        this.#setThinking(false);
        this.#needsInput = null;
        this.#hookTurn = { open: false, at: Date.now() };
        this.#idlePolls = 0;
        this.#lastConfirmedRef = null;
        this.#driver.emit({ kind: "turn_ended", status: "completed" });
        this.#maybeDrainQueue();
        return { ok: true };
      }
      case "StopFailure": {
        // The turn FAILED (rate_limit | overloaded | authentication_failed |
        // billing_error). Not generating any more. authentication_failed opens
        // the auth episode that gates /login-code (#482): with hooks live the
        // code is typed only while an episode is open or a login form has
        // been surfaced — never into a chat pane that merely quotes the URL.
        // No queue drain here: a queued prompt typed into a session that just
        // failed for auth/billing/limits fails the same way; the transcript's
        // turn_duration (or the next Stop) drains as before.
        const errorType = str("error_type") ?? "unknown";
        process.stderr.write(`[hook] ${this.id} StopFailure error_type=${errorType}\n`);
        this.#setThinking(false);
        this.#needsInput = null;
        this.#hookTurn = { open: false, at: Date.now() };
        this.#idlePolls = 0;
        this.#lastConfirmedRef = null;
        this.#driver.emit({ kind: "turn_ended", status: "failed", detail: errorType });
        const now = Date.now();
        if (errorType === "authentication_failed") {
          this.#authFailure = { errorType, since: now };
          if (now - this.#autoLoginAt > 5 * 60_000) {
            this.#autoLoginAt = now;
            this.#emitAgentNote("Claude auth failed — send /login to reauthenticate (a login prompt will appear here)", now, this.claudeSessionId);
          }
        } else {
          this.#emitAgentNote(`Claude stopped: ${errorType.replace(/_/g, " ")}`, now, this.claudeSessionId);
        }
        return { ok: true };
      }
      case "PostToolUse": {
        // A tool just completed. For the MAIN agent that is a turn in
        // progress: its permission wait is answered, the pane's idle count is
        // void, and thinking is re-asserted inside a running turn a stale
        // pane read cleared. A SUBAGENT's tool (agent_id) says none of that
        // about the main agent — a background agent finishing a Read used to
        // erase the main Bash permission wait and revive a turn Stop had
        // already closed — so it only answers a wait of ITS OWN actor.
        if (actor) {
          if (this.#needsInput?.agent === actor) this.#needsInput = null;
          return { ok: true };
        }
        if (!this.#needsInput?.agent) this.#needsInput = null;
        this.#idlePolls = 0;
        this.#hookTurn = { open: true, at: Date.now() };
        if (this.#turn && !this.#thinking) this.#setThinking(true);
        return { ok: true };
      }
      case "PermissionRequest": {
        // Claude is about to ask the human for a tool permission — waiting,
        // not generating (the pane's dialog parser sees the same prompt a poll
        // later; this is the instant, tool-named edge). The push goes out on
        // Notification(permission_prompt), Claude's own "tell the user" signal.
        const tool = str("tool_name") ?? undefined;
        process.stderr.write(`[hook] ${this.id} PermissionRequest tool=${tool ?? "?"}${actor ? ` agent=${actor}` : ""}\n`);
        // A subagent's prompt is a real wait for the human too, tagged with
        // its actor so only that actor's tool completion answers it; it does
        // not touch the main agent's thinking.
        if (!actor) this.#setThinking(false);
        this.#idlePolls = 0;
        if (this.#needsInput?.kind !== "permission") this.#needsInput = { kind: "permission", tool, since: Date.now(), ...(actor ? { agent: actor } : {}) };
        else if (tool && (this.#needsInput.agent ?? null) === actor) this.#needsInput.tool = tool;
        return { ok: true };
      }
      case "SubagentStop": {
        // Only the permission_mode refresh above; the main turn's state is
        // untouched (the subagent may have been a background one).
        return { ok: true };
      }
      case "Notification": {
        // Claude is WAITING — not generating. notification_type says on what:
        //   permission_prompt → needs_input (permission) + one push per episode
        //   idle_prompt       → plain idleness (60s at the prompt): thinking
        //                       off, lease void; NOT needs_input — a script's
        //                       `joy wait` must not read an idle session as a
        //                       question awaiting an answer
        //   auth_success      → the auth episode is over
        //   elicitation_* / agent_needs_input → needs_input of that kind
        const nt = str("notification_type") ?? "";
        process.stderr.write(`[hook] ${this.id} Notification${nt ? ` (${nt})` : ""}: ${(str("message") ?? "").slice(0, 80)}\n`);
        this.#setThinking(false);
        this.#idlePolls = 0;
        if (nt === "idle_prompt") {
          this.#thinkingLeaseUntil = 0; this.#hookTurn = { open: false, at: Date.now() };
          // 60 s at the prompt: a command still recorded as running had no
          // terminal we saw — idle is the verdict (#463).
          this.#driver.emit({ kind: "idle" });
        }
        if (nt === "auth_success") {
          if (this.#authFailure) process.stderr.write(`[hook] ${this.id} auth episode closed by auth_success\n`);
          this.#authFailure = null;
        } else if (nt === "permission_prompt") {
          if (this.#needsInput?.kind !== "permission") this.#needsInput = { kind: "permission", since: Date.now() };
          if (this.#needsInputPushedFor !== this.#needsInput.since) {
            this.#needsInputPushedFor = this.#needsInput.since;
            this.#relay?.notify("permission");
          }
        } else if (nt === "agent_needs_input" || nt.startsWith("elicitation")) {
          if (this.#needsInput?.kind !== nt) this.#needsInput = { kind: nt, since: Date.now() };
        }
        return { ok: true };
      }
      default:
        return { ok: false };
    }
  }

  /** Flip the hook-authority latch on the first hook event (see #hooksLive). */
  #markHooksLive(event: string): void {
    if (this.#hooksLive) return;
    this.#hooksLive = true;
    this.#hooksLiveAt = Date.now();
    process.stderr.write(`[hook] ${this.id} hooks live (first event: ${event}) — hook authority on, pane demoted to tie-breaker\n`);
  }

  /** A hook carried permission_mode: remember it, persist it on change, and
   *  verify (or correct) the last setPermissionMode against it. */
  #notePermissionMode(mode: string | null, event: string): void {
    if (!mode) return;
    this.#hookPermissionMode = mode;
    this.#hookPermissionModeAt = Date.now();
    if (this.#persistedPermissionMode === undefined) {
      this.#persistedPermissionMode = loadWindowRecord(this.id)?.claudePermissionMode ?? null;
    }
    if (this.#persistedPermissionMode !== mode) {
      // The cache advances only on a SUCCESSFUL write: a failed save used to be
      // cached as done, so the next identical hook never retried it and the
      // record kept the wrong mode until it happened to change again.
      if (saveWindowRecord(this.id, { claudePermissionMode: mode })) {
        process.stderr.write(`[hook] ${this.id} ${event} permission_mode=${mode} (record said ${this.#persistedPermissionMode ?? "none"}) — persisted\n`);
        this.#persistedPermissionMode = mode;
      } else {
        process.stderr.write(`[hook] ${this.id} ${event} permission_mode=${mode} — record write FAILED, will retry on the next hook\n`);
      }
    }
    const target = this.#modeSetTarget;
    if (target) {
      this.#modeSetTarget = null;
      if (target.mode !== mode) process.stderr.write(`[hook] ${this.id} setPermissionMode(${target.mode}) verified FALSE by ${event}: claude is in ${mode} (#480)\n`);
    }
  }

  /** SessionEnd received: end after the grace unless the pid proves the
   *  process lives on (see the SessionEnd case). */
  #armHookSessionEnd(): void {
    if (this.#hookSessionEndTimer) clearTimeout(this.#hookSessionEndTimer);
    this.#hookSessionEndTimer = setTimeout(() => {
      this.#hookSessionEndTimer = null;
      const pending = this.#hookSessionEnd;
      if (this.status === "ended" || !pending) return;
      // A resolved pid that is claude's own (not the pane shell, #30) and
      // still alive is the one thing that outranks the hook. FRESH evidence:
      // an unresolved, shell or dead cached pid is re-resolved from the pane
      // shell's live child NOW (#pollEnd's rule) — a replacement or re-exec'd
      // claude under the shell is proof the hook came from a process that is
      // not the one being watched, and the session must not be ended on it.
      const shell = this.#paneShellPid();
      let pid = this.pid;
      if (pid === undefined || pid === shell || !Session.#pidAlive(pid)) {
        const fresh = this.#resolvePidFromPane();
        if (fresh !== undefined) {
          process.stderr.write(`[hook] ${this.id} SessionEnd(${pending.reason}): pid ${pid ?? "unresolved"} re-resolved to live child ${fresh}\n`);
          this.pid = fresh;
          pid = fresh;
        }
      }
      const alive = pid !== undefined && pid !== shell && Session.#pidAlive(pid);
      if (alive) {
        process.stderr.write(`[hook] ${this.id} SessionEnd(${pending.reason}) but pid ${pid} is alive after ${HOOK_SESSION_END_GRACE_MS}ms — left to the pid probe\n`);
        this.#hookSessionEnd = null;
        return;
      }
      process.stderr.write(`[end] ${this.id}: SessionEnd(${pending.reason}) confirmed (pid ${pid ?? "unresolved"}) → detached\n`);
      this.end("process_exited");
    }, HOOK_SESSION_END_GRACE_MS);
  }

  /** Card snapshot for the nucleus lane's v2 publish (see AgentSession). */
  cardMetadata(): Record<string, unknown> | null {
    return this.#relay?.metadataSnapshot ?? null;
  }

  setV2Link(link: { sessionId: string; relay: string; keyEnvelope: string }): void {
    // localSessionId lets the app address this session's MACHINE plane
    // (/v2/sessions/<local id>/…) through the sealed tunnel.
    void this.#relay?.mergeMetadata({ v2: { ...link, localSessionId: this.id } });
  }

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
   *  truth: the "esc to interrupt" line (or the spinner) shows iff Claude is
   *  actively generating. This corrects the event-driven setters for the cases
   *  they miss: typing directly in the pane, stops at an interactive prompt
   *  (no end_turn), and interrupts. Runs only while a relay is attached and
   *  the session is live.
   *
   *  GENERATING, not paneShowsWorking: Working also counts a live-footer
   *  background shell ("· 1 shell ·"), so any session with a persistent dev
   *  server read as thinking FOREVER while idle at the prompt — busy:true,
   *  blue sidebar on an idle session — the "sidebar color doesn't match the
   *  session" bug (2026-07-04). A lingering shell is not a turn. */
  #pollThinking(): void {
    if (this.status === "ended") return;
    if (this.#relay) {
      const pane = this.#tmux.captureCached(this.tmuxWindow);
      if (pane.ok) {
        const generating = paneShowsGenerating(pane.out);
        // HOOK AUTHORITY: once this process has reported a hook, the pane's
        // "esc to interrupt" read never SETS thinking (UserPromptSubmit /
        // PostToolUse / the submit callback / the transcript own that edge —
        // a quoted hint in a reply can no longer pin a session busy, #479)
        // and CLEARS it only as a tie-breaker: a long run of idle reads past
        // the lease, for the single edge hooks cannot report (Stop does not
        // fire on a terminal Esc; the transcript's interrupt marker normally
        // closes that one first).
        if (this.#hooksLive) {
          if (generating || !this.#thinking) {
            this.#idlePolls = 0;
          } else {
            this.#idlePolls += 1;
            if (this.#idlePolls >= HOOK_TIEBREAK_IDLE_POLLS) {
              this.#idlePolls = 0;
              if (Date.now() >= this.#thinkingLeaseUntil) {
                process.stderr.write(`[hook] ${this.id} pane idle for ${HOOK_TIEBREAK_IDLE_POLLS} polls with no Stop — tie-breaker clears thinking\n`);
                this.#setThinking(false);
              }
            }
          }
        }
        // HOOK-LESS (the pane is the ground truth). Hysteresis: SET on one
        // generating read (thinking should appear fast), CLEAR only after two
        // consecutive idle reads. A single stale/mid-repaint capture at a turn
        // boundary used to flip thinking off and back on — the app status
        // flapping between the busy state and "online" (2026-07-04). Real turn
        // ends still clear instantly via the transcript event setters; this is
        // only the poll's own clear path.
        else if (generating) {
          this.#idlePolls = 0;
          if (!this.#thinking) this.#setThinking(true);
        } else if (this.#thinking) {
          this.#idlePolls += 1;
          if (this.#idlePolls >= 2) {
            this.#idlePolls = 0;
            // Lease check: the pane's "not generating" read cannot override a
            // trusted submit — a matcher broken by a TUI change looked idle
            // ~6s into a minutes-long pre-output think. Trusted negative
            // edges bypass this (they clear via #setThinking directly).
            if (Date.now() >= this.#thinkingLeaseUntil) this.#setThinking(false);
          }
        } else {
          this.#idlePolls = 0;
        }
        this.#reconcileLogin(pane.out);
        this.#reconcileDialog(pane.out);
        this.#reconcileRetryBanner(pane.out);
      }
    }
    setTimeout(() => this.#pollThinking(), 3000);
  }

  /** Surface an interactive CLI dialog (model picker / switch confirm / effort
   *  slider…) as joy__dialog so the app can say "answer this in the terminal".
   *  Same debounce contract as #reconcileLogin: two consecutive sightings of
   *  the same dialog before pushing (a mid-repaint capture can transiently
   *  look like anything), cleared as soon as the pane no longer shows it. */
  /** Surface the CLI's own API-retry spinner (`✻ 529 Overloaded · Retrying in
   *  18s · attempt N/M`) as the joy__retry banner. Claude Code stopped writing
   *  api_error transcript entries for these retries, so without this the app
   *  shows a silent stall while the CLI backs off. Publishes on each distinct
   *  (status, attempt) sighting; clears when the spinner leaves the pane —
   *  unless the api_error-driven #retry episode owns a live banner. */
  #reconcileRetryBanner(paneText: string): void {
    const r = retryFromPane(paneText);
    if (r) {
      const key = `${r.status}:${r.attempt}/${r.total}`;
      if (this.#paneRetryKey !== key) {
        this.#paneRetryKey = key;
        void this.#relay?.updateRetry({ attempt: r.attempt, total: r.total, nextAt: Date.now() + r.delaySec * 1000, status: r.status });
      }
    } else if (this.#paneRetryKey) {
      this.#paneRetryKey = null;
      if (!this.#retry) void this.#relay?.updateRetry(null);
    }
  }

  #reconcileDialog(paneText: string): void {
    const dialog = dialogFromPane(paneText);
    if (dialog) {
      // A dialog on screen is PROOF Claude is waiting for input, not
      // generating — the strongest negative edge the pane can give. Without
      // this the submit's thinking lease (170s, pane may not clear it) kept
      // busy() true for a command that never generates anything, the lane's
      // Phase C never saw an idle poll, and the relay turn stayed open with
      // every later message queued behind it. `/effort high` wedged a session
      // for a full minute — rescued only by Claude's 60s "waiting for your
      // input" hook — and `/model` did the same (2026-09-03).
      this.#thinkingLeaseUntil = 0;
      if (this.#thinking) this.#setThinking(false);
      this.#needsInputAbsentSince = 0; // the wait is visibly still on
    }
    if (!dialog) {
      // Tie-breaker for a hook-reported permission wait: the human answered in
      // the terminal and no later hook cleared it (an answer of "no" with no
      // further tool or Stop for a while). Measured as the time the dialog has
      // been continuously ABSENT — not the wait's age: one contradictory
      // (mid-repaint) capture 12s into a still-visible prompt used to erase
      // the wait for good, even when the dialog was back on the next poll.
      if (this.#needsInput?.kind === "permission") {
        if (!this.#needsInputAbsentSince) this.#needsInputAbsentSince = Date.now();
        else if (Date.now() - this.#needsInputAbsentSince > HOOK_NEEDS_INPUT_STALE_MS) {
          this.#needsInput = null;
          this.#needsInputAbsentSince = 0;
        }
      } else this.#needsInputAbsentSince = 0;
      this.#dialogPendingKey = null;
      this.#dialogObservedKey = null;
      if (this.#dialog) {
        this.#dialog = null;
        this.#dialogKey = null;
        // Dialog resolved → the ready prompt is (about to be) back. Kick the
        // drain so anything queued behind the dialog goes out promptly instead
        // of waiting for the next natural trigger.
        this.#maybeDrainQueue();
      }
      // Assert the clear EVERY poll, not just on the transition: updateDialog
      // dedupes against server-ACKED metadata, so a clear whose write failed
      // retries next poll instead of being lost (finding 6 — the old
      // transition-only clear was fire-and-forget).
      void this.#relay?.updateDialog(null);
      return;
    }
    const key = `${dialog.title ?? ""} ${dialog.options.join(" ")}`;
    // FIRST-sighting timestamp per distinct dialog — the causal input for
    // dispatch confirmation. Confirmation must run on the FIRST sighting
    // (verify round 3): a dialog opened and Esc-closed inside one poll gap
    // would otherwise escape both the debounced publish AND the timeout
    // backstop, requeuing a consumed command. Only the BANNER stays debounced.
    if (this.#dialogObservedKey !== key) {
      this.#dialogObservedKey = key;
      this.#dialogFirstSeenAt = Date.now();
    }
    this.#confirmDispatchOnDialog(this.#dialogFirstSeenAt);
    if (!this.#dialog && this.#dialogPendingKey !== key) {
      this.#dialogPendingKey = key; // first sighting — publish on next poll
      return;
    }
    this.#dialogPendingKey = null;
    if (!this.#dialog || this.#dialogKey !== key) {
      this.#dialog = { title: dialog.title, options: dialog.options, since: this.#dialogFirstSeenAt };
      this.#dialogKey = key;
    }
    // Same convergence contract as the clear: assert every poll, dedupe on ack.
    void this.#relay?.updateDialog(this.#dialog);
  }

  // Consecutive not-generating poll reads while thinking (see #pollThinking).
  #idlePolls = 0;

  /** Surface an interactive auth/login URL the CLI is showing (e.g. Claude
   *  Code's /login OAuth box) as joy__login, so the app can show a login bar.
   *  Debounced: a URL must be seen on two consecutive polls before we push it
   *  (guards against a transient link in normal output), and it's cleared as
   *  soon as the prompt is gone. */
  #reconcileLogin(paneText: string): void {
    // Auto-continue the post-login success screen: one Enter, no decision to
    // make. Latched until the screen is gone so a slow redraw can't double-
    // press into the restored conversation.
    if (loginContinueFromPane(paneText)) {
      if (!this.#loginContinuePressed) {
        this.#loginContinuePressed = true;
        void this.#tmux.key(this.tmuxWindow, "Enter").catch(() => { /* pane gone */ });
      }
    } else {
      this.#loginContinuePressed = false;
    }
    const login = loginFromPane(paneText);
    if (!login) {
      this.#loginUrlPending = null;
      if (this.#login) {
        this.#login = null;
        void this.#relay?.updateLogin(null);
      }
      return;
    }
    // Debounce only the FIRST appearance of a URL (guards a transient link);
    // once we're showing the bar, error changes on the same URL push immediately.
    if (!this.#login && this.#loginUrlPending !== login.url) {
      this.#loginUrlPending = login.url; // first sighting — confirm next poll
      return;
    }
    const sameUrl = this.#login?.url === login.url;
    if (sameUrl && (this.#login?.error ?? undefined) === login.error) return; // no change
    this.#loginUrlPending = null;
    this.#login = {
      url: login.url,
      since: sameUrl ? this.#login!.since : Date.now(),
      ...(login.error ? { error: login.error } : {}),
    };
    void this.#relay?.updateLogin(this.#login);
  }

  /** /login-code: type a pasted auth code straight into the CLI's "paste code"
   *  field and submit. No queue/clear dance — the field is a focused, empty
   *  input, not a normal turn. Guarded: only type when the login box is still up
   *  (a fresh pane capture), else the code would land in the normal input and be
   *  sent as a chat message. */
  async #submitLoginCode(code: string): Promise<void> {
    if (this.status === "ended") return;
    const c = code.trim();
    if (!c) return;
    // HOOK AUTHORITY (#482): with hooks live, a code is typed only inside a
    // login episode — StopFailure(authentication_failed) opened one and
    // Notification(auth_success) has not closed it — or while the login bar
    // (#reconcileLogin: the form seen on two polls) is up, which is how the
    // user got the URL in the first place. Outside both there is no login in
    // progress, whatever URL the chat quotes. The form check below stays: the
    // form itself is pane-only. Hook-less sessions keep today's pane-only gate.
    if (this.#hooksLive && !this.#authFailure && !this.#login) {
      throw new Error("login-code: no login in progress (no auth failure reported and no login form surfaced) — code not submitted");
    }
    const pane = await this.#tmux.captureFresh(this.tmuxWindow);
    // Login box GONE is a deliberate drop (login already completed/cancelled —
    // typing the code into a normal prompt would submit garbage), but capture
    // FAILURE and typing/submit failures must THROW: the relay-borne caller
    // awaits this, and a swallowed failure confirmed the cursor for a code
    // that never landed (5.6-sol verify #5).
    if (!pane.ok) throw new Error("login-code: pane capture failed");
    if (!paneShowsLoginForm(pane.out)) return; // form gone — deliberate drop
    if (!(await this.#typeLines(c))) throw new Error("login-code: typing failed");
    // Re-validate right before the submit (#482): the form can close during the
    // typing round-trips, and an Enter into the ordinary conversation input
    // would hand the auth code to the agent as a prompt.
    await sleep(ENTER_SUBMIT_DELAY_MS); // paste-detection swallows an immediate Enter
    const again = await this.#tmux.captureFresh(this.tmuxWindow);
    if (!again.ok) throw new Error("login-code: pane capture failed before submit");
    if (!paneShowsLoginForm(again.out)) throw new Error("login-code: login form closed before submit — code not submitted");
    const e = await this.#tmux.key(this.tmuxWindow, "Enter");
    if (!e.ok) throw new Error("login-code: submit Enter failed");
  }

  // ── Transcript entry semantics ──────────────────────────────────────────────

  onTranscriptEntry(entry: Record<string, unknown>): void {
    const entryType = String(entry.type || "");

    // A background-task launch/completion or a <joy-bg> tag changes the task
    // split — schedule a coalesced re-derive (derive-based so it sees a launch
    // and its later long-running tag together).
    if (bgTaskEvent(entry) || joyBgLongRunningIds(entry).length > 0) this.#scheduleTaskReconcile();

    // First entry activates the session — Claude is now reading the pane.
    if (this.status === "starting") {
      // entry.sessionId is authoritative; absent (an upstream shape change),
      // transcript ACTIVITY on the hook-staged path confirms the hook's sid —
      // the session no longer sticks in "starting" forever (audit #6).
      const entrySid = String(entry.sessionId || "");
      const staged = this.#pendingHookBinding;
      const sid = entrySid || (staged && this.transcriptPath === staged.path ? staged.sid : "");
      if (sid) {
        if (!entrySid) process.stderr.write(`[hook] ${this.id} confirmed staged sid ${sid} by transcript activity (entries carry no sessionId)\n`);
        this.claudeSessionId = sid;
        this.status = "active";
        this.lastActiveAt = Date.now();
        // Persist the window→conversation binding so a daemon restart's recover()
        // can re-attach the RIGHT transcript instead of the newest-mtime one.
        saveWindowRecord(this.id, { claudeSessionId: sid });
        this.#deps.broadcast("session_update", this.toJSON());
      }
    } else if (this.#pendingHookBinding && String(entry.sessionId || "") && String(entry.sessionId) !== this.#pendingHookBinding.sid) {
      process.stderr.write(`[hook] ${this.id} HARD MISMATCH: transcript sid ${entry.sessionId} vs staged ${this.#pendingHookBinding.sid}\n`);
      this.#pendingHookBinding = null;
    }

    const sid = this.claudeSessionId;

    // Claude generates a conversation title and writes it as an `ai-title`
    // entry. Push it into the relay session summary so the app shows the real
    // title instead of "New Chat".
    if (entryType === "ai-title") {
      const title = typeof entry.aiTitle === "string" ? entry.aiTitle.trim() : "";
      if (this.#titleLocked) return; // user-set title wins until a bare /title unlocks
      // Repeat of the last-seen ai-title = Claude re-emitting its stale title
      // on resume (observed: 1252 identical entries in one session) — skip so
      // it can't stomp an agent <joy-title> re-title. New values still apply.
      if (title && title !== this.#lastAiTitle) {
        this.#lastAiTitle = title;
        saveWindowRecord(this.id, { lastAiTitle: title });
        if (title !== this.summary) {
          this.summary = title;
          void this.#relay?.updateSummary(title);
          this.#deps.broadcast("session_update", this.toJSON());
        }
      }
      return;
    }

    // Every mirrored message is stamped with Claude's own transcript
    // timestamp (one clock for both user and agent messages), so a --resume
    // replay sorts in true chronological order in the app instead of
    // splitting into "all agent, then all user" from daemon/relay clock skew.
    // Semantic format health (codex review finding 6): valid JSON whose SHAPE
    // we no longer recognize (the system/local_command class) is invisible to
    // JSON-parse health. Count consecutive unknown-typed entries; alarm once.
    const entryTypeForHealth = String(entry.type ?? "");
    if (Session.#KNOWN_ENTRY_TYPES.has(entryTypeForHealth)) {
      this.#unknownEntryStreak = 0;
    } else {
      this.#unknownEntryStreak++;
      if (this.#unknownEntryStreak === 25) {
        this.#emitAgentNote(
          `transcript entries unrecognized (type "${entryTypeForHealth || "?"}" ×${this.#unknownEntryStreak}) — a Claude Code update likely changed the format; update joy-daemon`,
          Date.now(), this.claudeSessionId,
        );
      }
    }
    // Falls back to now() for entries without a parseable timestamp.
    const entryTimeMs = Date.parse(String(entry.timestamp || "")) || Date.now();

    // /goal status (an `attachment` entry, filtered out below) → surface the
    // active goal as joy__goal so the app can show a goal bar.
    const goal = goalStatusFromEntry(entry);
    if (goal) { this.#applyGoalStatus(goal, entryTimeMs); return; }

    // Turn complete → send turn-end and clear turn state. Either the Stop hook
    // ran (stop_hook_summary) or Claude reported the turn's wall-clock
    // (turn_duration). turn_duration fires at the end of EVERY turn, including
    // ones that ended in an API error — whose assistant entry carries no
    // end_turn stop_reason, so the assistant-path turn-end below never fires.
    // Handling it here is what unsticks `thinking` when a turn errors out.
    // CLI ≥2.1.198 records the local-command family as system/local_command
    // entries with a TOP-LEVEL content string (previously user-role message
    // content). Route them to the same handlers: <command-name> confirms a
    // dispatched slash command (queue wedge otherwise), <local-command-stdout>
    // surfaces the command's output as an agent note ("No goal set" etc.).
    if (entryType === "system" && entry.subtype === "local_command" && typeof entry.content === "string") {
      const sysContent = entry.content as string;
      if (sysContent.startsWith("<command-name>")) {
        this.#confirmCommandEcho(sysContent);
      } else if (sysContent.startsWith("<local-command-stdout>")) {
        const m = /<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/.exec(sysContent);
        const out = m ? stripAnsi(m[1]).trim() : "";
        if (out && this.#shouldEmitNote(entry, entryTimeMs)) this.#emitAgentNote(out, entryTimeMs, sid);
      } else if (sysContent.startsWith("<bash-input>")) {
        // `!cmd` recorded under the same shape: its <bash-input> echo is the
        // ONLY delivery evidence a bash dispatch ever gets (#40) — the user-
        // role branch below confirms it, and this shape must too, or the
        // executed command sits pending until dispatch_timeout requeues it.
        this.#noteBashInput(sysContent);
      } else if (sysContent.startsWith("<bash-stdout>") || sysContent.startsWith("<bash-stderr>")) {
        this.#emitBashCard(sysContent, entry, entryTimeMs, sid);
      }
      return;
    }
    if (entryType === "system" && (entry.subtype === "stop_hook_summary" || entry.subtype === "turn_duration")) {
      this.#errorNotedThisTurn = false;
      this.#deps.broadcast("stop", { session_id: sid });
      if (this.#relay && this.#turn) {
        this.#relay.send(encodeTurnEnd("completed", { turn: this.#turn.turnId, time: entryTimeMs, usage: this.#turnUsage ?? undefined }));
        this.#pushContextUsage();
      }
      this.#turnUsage = null;
      this.#closeOpenTools(entryTimeMs); // a tool abandoned by an errored turn shouldn't spin forever
      this.#turn = null;
      this.#setThinking(false);
      // The transcript's turn end (the authority without hooks; a duplicate
      // of the Stop edge with them — harmless, nothing is executing then).
      if (entryTimeMs >= this.#tailBoundAt - 60_000) { this.#lastConfirmedRef = null; this.#driver.emit({ kind: "turn_ended", status: "completed" }); }
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
      // The boundary carries the only interesting facts about a compaction —
      // what triggered it, how long it took, and how much context it recovered.
      // Emit them as a marker the app renders as a divider; without it the only
      // trace in the chat is the summary card, which says nothing about the run.
      const cm = (entry.compactMetadata ?? {}) as Record<string, unknown>;
      const num = (k: string) => (typeof cm[k] === "number" ? (cm[k] as number) : undefined);
      const marker: Record<string, unknown> = {
        trigger: cm.trigger === "manual" ? "manual" : "auto",
        durationMs: num("durationMs"),
        preTokens: num("preTokens"),
        postTokens: num("postTokens"),
      };
      for (const k of Object.keys(marker)) if (marker[k] === undefined) delete marker[k];
      if (this.#shouldEmitNote(entry, entryTimeMs)) {
        this.#emitAgentNote(`<joy-compacted>${JSON.stringify(marker)}</joy-compacted>`, entryTimeMs, sid);
      }
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
        this.#emitAgentNote(`API error: ${formatted}`, entryTimeMs, sid);
      }
      // 401 = credentials expired/invalid. Claude just prints "Please run
      // /login" at the prompt and waits — the app's login bar only appears once
      // the interactive login SCREEN is open (joy__login via #reconcileLogin),
      // so an expired session looked "stuck at login" with no prompt anywhere
      // (boite, 2026-07-04). Surface a clear instruction (deliberately NOT
      // auto-running /login — the user drives it): sending /login from the app
      // types it into the pane, the screen opens, and #reconcileLogin surfaces
      // the auth URL bar. Once per 5-minute episode, and only for fresh entries
      // (entryTimeMs gate) so a transcript replay after a restart can't
      // re-announce a historical 401.
      if (Number(err.status) === 401
        && entryTimeMs >= this.#tailBoundAt - 60_000
        && Date.now() - this.#autoLoginAt > 5 * 60_000) {
        this.#autoLoginAt = Date.now();
        this.#emitAgentNote("Claude auth expired — send /login to reauthenticate (a login prompt will appear here)", entryTimeMs, sid);
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
    const rawContent = msg.content;

    if (role === "user") {
      if (entry.isMeta) return;
      // Interrupt terminator. After an Escape/abort, Claude writes
      // "[Request interrupted by user...]" as its final entry for that turn — and the
      // interrupted turn never emits a turn_duration. A partial-output entry Claude
      // flushes between the interrupt and this marker can re-open a turn (abort already
      // closed the original), and with no turn_duration to follow it would stay open
      // forever — #canDrain needs !#turn, so the dispatch queue wedges and every later
      // message hangs. Treat the marker as the terminator: close any open turn, stop
      // thinking, kick the drain, and don't mirror the marker as a user bubble.
      const interruptText = typeof rawContent === "string" ? rawContent
        : Array.isArray(rawContent)
          ? (rawContent as Array<Record<string, unknown>>).map((b) => (b && typeof b.text === "string" ? b.text : "")).join("")
          : "";
      if (/^\s*\[Request interrupted by user/.test(interruptText)) {
        if (this.#turn) {
          this.#relay?.send(encodeTurnEnd("cancelled", { turn: this.#turn.turnId, time: entryTimeMs }));
          this.#turnUsage = null;
          this.#turn = null;
        }
        this.#setThinking(false);
        // The runtime's own record of the interrupt (a terminal Esc that no
        // hook reports): whatever was executing is cancelled.
        if (entryTimeMs >= this.#tailBoundAt - 60_000) { this.#lastConfirmedRef = null; this.#driver.emit({ kind: "turn_ended", status: "cancelled" }); }
        this.#maybeDrainQueue();
        return;
      }
      // Post-compaction summary. Claude writes its continuation summary as a
      // user entry, so without this it mirrors as a giant user bubble. Flag it
      // and the app renders the collapsed "Compaction summary" card instead.
      // It is machine text, never a prompt — so it must not become the 5xx
      // retry text either (re-sending the whole summary as a prompt).
      const isCompactSummary = entry.isCompactSummary === true;
      let content: string;
      if (typeof rawContent !== "string") {
        // (Background-task launches are handled by the coalesced re-derive
        // scheduled at the top of onTranscriptEntry.)
        // Emit tool-call-end for tool results. NOT gated on this.#turn: the turn
        // may have been nulled (turn_duration/error) before the result lands, and
        // gating used to drop the end → a tool card stuck "running". Use the turn
        // id remembered when the start was forwarded (fall back to the live turn).
        if (this.#relay && Array.isArray(rawContent)) {
          for (const item of rawContent as Array<Record<string, unknown>>) {
            if (item.type === "tool_result" && typeof item.tool_use_id === "string") {
              const id = item.tool_use_id;
              // No known turn? Emit anyway (turn is optional app-side). A result
              // landing while the daemon is DOWN (e.g. the command being mirrored
              // is the one restarting the daemon) replays with #openTools empty
              // and no live #turn — the old `if (turn)` gate dropped the end and
              // the app's tool card spun forever (stuck-spinner screenshots,
              // 2026-07-09). Ends for never-forwarded starts are harmless: the
              // app ignores results with no matching call.
              const turn = this.#openTools.get(id) ?? this.#turn?.turnId ?? "";
              this.#relay.send(encodeToolCallEnd(id, {
                turn, time: entryTimeMs,
                result: toolResultText(item.content),
                isError: item.is_error === true,
              }));
              this.#openTools.delete(id);
            }
          }
        }
        // A prompt typed in the terminal WITH an image (or any content-block
        // prompt) arrives as [{type:"text"…},{type:"image"…}] — its text is a
        // real user message and must take the same path as the string form:
        // mirrored, receipt-matched, remembered as retry text. It used to
        // return here and vanish from both chat sinks (#477). Tool-result-only
        // entries carry no text blocks and stop here as before.
        const textBlocks = Array.isArray(rawContent)
          ? (rawContent as Array<Record<string, unknown>>).filter((b) => b && b.type === "text" && typeof b.text === "string").map((b) => String(b.text))
          : [];
        const joined = textBlocks.join("\n").trim();
        if (!joined) return;
        content = joined;
      } else {
        content = rawContent;
      }
      // (Background-task completions — the <task-notification> — are handled by
      // the coalesced re-derive scheduled at the top of onTranscriptEntry.)
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
        if (out && this.#shouldEmitNote(entry, entryTimeMs)) this.#emitAgentNote(out, entryTimeMs, sid);
        return;
      }
      // `!cmd`: capture the command from <bash-input> (to head the output card)
      // and suppress its echo — the user's typed `! cmd` already shows.
      if (content.startsWith("<bash-input>")) {
        this.#noteBashInput(content);
        return;
      }
      // Bash output (`!cmd`) → a structured card the app renders as a tool call.
      if (content.startsWith("<bash-stdout>") || content.startsWith("<bash-stderr>")) {
        this.#emitBashCard(content, entry, entryTimeMs, sid);
        return;
      }
      if (content.startsWith("<command-name>")) {
        this.#confirmCommandEcho(content);
        return;
      }
      if (content.startsWith("<command-message>") ||
          content.startsWith("<local-command") ||
          content.startsWith("<bash-")) {
        return;
      }

      // Match this transcript entry against the front of the pending-send
      // queue. Identical messages are matched sequentially: two "yes" sends
      // pair with two "yes" transcript entries in order.
      const uuid = typeof entry.uuid === "string" ? entry.uuid : "";
      if (this.#relay && uuid) {
        // We type real newlines but record the flattened form (see #typeIntoTmux), and
        // Claude echoes the message multi-line — so MATCH on the flattened echo. `content`
        // itself (newlines intact) is kept for the retry text below.
        const matchContent = flattenForMatch(content);
        // Match against the ledger's attempts awaiting evidence for this text —
        // oldest first, so identical texts pair in submission order. Attempts
        // are persisted, so a restart between the type and the echo (the old
        // in-memory pending queue's blind spot) still pairs the echo with its
        // send instead of mirroring it back as a duplicate bubble.
        const attempt = this.#ledger.matchAttemptByRef(this.id, matchContent) ?? this.#ledger.attemptByRef(this.id, matchContent);
        const attemptCmd = attempt ? this.#ledger.getCommand(attempt.commandId) : null;
        if (attempt && attemptCmd && !(attemptCmd.state === "completed" || attemptCmd.state === "failed" || attemptCmd.state === "interrupted") && !this.#hasUuid(uuid)) {
          // The echo of OUR submission: its uuid receipt is retained (a replay
          // never mirrors it back), and the coordinator pairs the echo with
          // the attempt — the command is running from here; a late echo of a
          // dispatch that timed out pairs with that attempt by its ref (#31)
          // instead of the prompt being re-typed.
          const wasQueued = attemptCmd.state === "queued";
          this.#noteUuid(uuid, { commandId: attempt.commandId, attemptId: attempt.id });
          this.#driver.emit({ kind: "echo", runtimeRef: matchContent });
          // codex-4: record the prompt for 5xx auto-retry BEFORE returning —
          // app/queue/RPC sends match here and used to skip the #lastUserText
          // assignment below, so #fireRetry had nothing to re-send.
          if (!isSystemPromptEntry(entry, content)) this.#lastUserText = content;
          // codex-3: the echo proves the dispatched prompt landed. Confirm it now
          // instead of waiting for assistant output — a turn that errors before any
          // output (api_error → turn_duration with no assistant blocks) would
          // otherwise leave #dispatchInFlight set until the dispatch echo timeout
          // pauses an already-delivered message.
          if (this.#dispatchInFlight && flattenForMatch(this.#dispatchInFlight.text) === matchContent) {
            this.#confirmDispatchIfAwaiting();
          }
          // Late-echo self-heal: a dispatch that timed out paused the queue
          // waiting for exactly this echo — the message DID land; lift the pause.
          if (wasQueued && !this.#dispatchInFlight && this.#queuePaused && this.#pauseReason === "dispatch_timeout") this.resumeQueue();
          return; // self-echo of a relay/HTTP/RPC send — don't double-record locally
        }
        // No attempt match: the persisted attempts already cover the restart
        // case the old in-memory pending queue + `received` backstop existed for.
        if (!this.#hasUuid(uuid)) {
          // Unmatched = direct input (pane view, `tmux attach`, …). Trust the log: it's a
          // real message Claude received, so mirror it to every client. Single user, one
          // device at a time → no concurrent writes to Claude's one input box → no
          // collision that could garble a dispatch into a mismatched echo, so an unmatched
          // entry is never a corrupted app send (that's why there's no longer a
          // dispatch_mismatch suppress+pause here). Any in-flight dispatch is left
          // untouched: its own clean echo matches later, or the dispatch echo timeout re-queues it.
          this.#relay!.send(encodeUserMessage(content, entryTimeMs, isCompactSummary ? { isCompactSummary: true } : undefined));
          this.#relay!.stampReceiptOnLastQueued({ uuid, turn: "" });
        }
      }
      // The prompt to re-send if this turn 5xx-fails — but never machine text
      // (#110): background-task completions are plain user-role string entries
      // (`<task-notification>…`, promptSource "system"), and a turn Claude
      // started off one that then 5xx'd out re-sent the XML notification as
      // the user's prompt: a forged "task completed" for a task already
      // handled, plus a duplicate task card in the app.
      if (!isCompactSummary && !isSystemPromptEntry(entry, content)) this.#lastUserText = content;
      this.#deps.addChatMessage({ role: "user", content, source: "cli", session_id: sid });

    } else if (role === "assistant") {
      // When a turn is interrupted (abort/Escape), Claude replays the partial output
      // as a SYNTHETIC assistant entry (model "<synthetic>") with NO turn_duration to
      // follow. Mirroring it opens a turn that never closes — and #canDrain requires
      // !#turn, so the dispatch queue wedges and every later message hangs undelivered.
      // It also only duplicates the real turn's already-mirrored partial output. Skip
      // it entirely (this also keeps currentModel off the "<synthetic>" sentinel).
      // EXCEPT: API-error notices ride the same synthetic vehicle ("API Error:
      // Server error mid-response…") and are the app's ONLY signal that a turn
      // died mid-response — surface those as a note (receipt-deduped, freshness
      // gated). 401/login ones are excluded: the pane login flow already
      // surfaces those with the auth URL.
      if (msg.model === "<synthetic>") {
        const parts = Array.isArray(rawContent) ? rawContent as Array<Record<string, unknown>> : [];
        const text = parts.map((b) => typeof b?.text === "string" ? b.text : "").join(" ").trim();
        if (/API Error/i.test(text) && !/401|\/login/i.test(text) && this.#shouldEmitNote(entry, entryTimeMs)) {
          this.#emitAgentNote(text.slice(0, 300), entryTimeMs, sid);
        }
        return;
      }
      if (typeof msg.model === "string" && msg.model) {
        if (this.currentModel !== msg.model) {
          this.currentModel = msg.model;
          if (this.#relay) {
            this.#relay.updateModelCode(msg.model).catch(() => {});
          }
        }
      }
      const blocks = Array.isArray(rawContent) ? rawContent as Array<Record<string, unknown>> : [];
      // Claude produced output → it recovered from any mid-turn 5xx, so this turn
      // won't trigger an auto-retry.
      if (blocks.length > 0) this.#turn5xxStatus = null;
      const entryUuid = typeof entry.uuid === "string" ? entry.uuid : "";
      // Skip if we've already forwarded this transcript entry (recovery case).
      if (this.#relay && entryUuid && this.#hasUuid(entryUuid)) return;
      // Agent-authored push (<joy-notify/>): explicit "worth a notification" —
      // long task done, input needed. Freshness-gated so a backfill/replay of
      // history can never re-fire old notifications (the forwardedUuids skip
      // above covers replayed entries, this covers never-forwarded old ones).
      if (this.#relay && entryTimeMs >= this.#tailBoundAt - 60_000) {
        for (const ev of joyNotifyEvents(entry)) this.#relay.notifyCustom(ev.headline, ev.detail);
        const newTitle = joyTitleValue(entry);
        if (newTitle && !this.#titleLocked && newTitle !== this.summary) {
          this.#setTitle(newTitle); // agent re-title — never locks
        }
      }
      if (this.#relay && blocks.length > 0) {
        // Ensure a turn is open; send turn-start on the first assistant entry per turn
        if (!this.#turn) {
          this.#turn = { turnId: crypto.randomUUID(), since: Date.now() };
          this.#turnUsage = null; // fresh turn → reset usage accumulator
          this.#relay.send(encodeTurnStart({ turn: this.#turn.turnId, time: entryTimeMs }));
          // A fresh turn starting is the proof a dispatched queue message
          // landed — Claude is now responding to it (unless the pane shows the
          // message still sitting unsent in the box, #32).
          this.#confirmDispatchIfAwaiting({ byTurnStart: true });
          // Without hooks the transcript is the turn edge: the turn belongs to
          // the last dispatch the runtime took, else it is foreign (#78).
          if (!this.#hooksLive && entryTimeMs >= this.#tailBoundAt - 60_000) this.#driver.emit({ kind: "turn_started", runtimeRef: this.#lastConfirmedRef });
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
        // Outbound receipt: stamped on the LAST queued row of this entry's
        // group and written only when that row ACKS — a dropped/parked send
        // no longer reads as "forwarded" (codex review finding 1). If the
        // entry queued no rows, the stamp degenerates to an immediate receipt.
        if (entryUuid && this.relaySessionId) {
          this.#relay.stampReceiptOnLastQueued({ uuid: entryUuid, turn: this.#turn.turnId });
        }
        // Send turn-end when the assistant finishes. The Stop HOOK (onHookEvent)
        // clears thinking/drains faster when present, but the transcript stays
        // the authority for the turn lifecycle — hook-less sessions (adopted
        // orphans, old settings snapshots) rely on this path alone. end_turn =
        // normal completion; tool_use = more tool calls pending (no turn-end yet).
        const stopReason = String(msg.stop_reason || "");
        if (stopReason === "end_turn" || stopReason === "max_tokens") {
          const endedTurnId = this.#turn.turnId;
          this.#errorNotedThisTurn = false;
          this.#closeOpenTools(entryTimeMs); // safety: any tool without a result
          this.#relay.send(encodeTurnEnd("completed", { turn: this.#turn.turnId, time: entryTimeMs, usage: this.#turnUsage ?? undefined }));
          this.#pushContextUsage();
          this.#turnUsage = null;
          this.#turn = null;
          this.#setThinking(false);
          this.#deps.broadcast("stop", { session_id: sid });
          if (entryTimeMs >= this.#tailBoundAt - 60_000) { this.#lastConfirmedRef = null; this.#driver.emit({ kind: "turn_ended", status: "completed" }); }
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
          // ALSO gate on no outstanding finishing background tasks: a turn that
          // ends while async agents/builds still run is an INTERMEDIATE end —
          // each task completion then spawns another turn whose end would push
          // again (an agent-fleet run buzzed the phone per wave). #longRunning
          // deliberately doesn't block: servers never "finish". The final
          // turn-end — after the last completion empties #bgTasks (reconcile is
          // coalesced at 150ms, well inside LLM reply latency) — pushes once.
          const notifyBlockers = [
            // A REPLAYED turn end is history, not news. Recovery re-reads the
            // transcript from its checkpoint (or from 0 when the checkpoint
            // missed), and every historical end_turn walked into this branch —
            // 18 pushes in one second after one restart. Same freshness rule
            // as #shouldEmitNote.
            entryTimeMs < this.#tailBoundAt - 60_000 ? "replay" : null,
            this.#dispatchInFlight ? "dispatch" : null,
            this.#pendingCount() > 0 ? `queue=${this.#pendingCount()}` : null,
            this.#bgTasks.size > 0 ? `bgTasks=${this.#bgTasks.size}` : null,
          ].filter(Boolean);
          if (notifyBlockers.length === 0) {
            // Body = the reply's first line — a glanceable "what happened",
            // not the session title (which reads as project-name noise).
            // NOTE push payloads are not E2E-encrypted; same trade as
            // joy-notify (whose contract bans secrets in the fields).
            let snippet: string | undefined;
            for (const block of blocks) {
              if (block.type === "text" && typeof block.text === "string") {
                const line = stripAnsi(block.text).split("\n").find(l => l.trim());
                if (line) { snippet = line.trim().slice(0, 140); break; }
              }
            }
            // ONE done push per turn. The phone was buzzing two and three times
            // for a single turn end (fny journal, 2026-09-03: three identical
            // "push done sent for 8f7c8f88" inside the same second) — a
            // transcript entry re-read on a replay/backfill re-runs this whole
            // branch, and nothing downstream deduped it.
            if (this.#notifiedTurns.has(endedTurnId)) {
              process.stderr.write(`[notify] ${this.id}: done push already sent for turn ${endedTurnId.slice(0, 8)}\n`);
            } else {
              this.#notifiedTurns.add(endedTurnId);
              if (this.#notifiedTurns.size > 200) {
                for (const t of this.#notifiedTurns) { this.#notifiedTurns.delete(t); if (this.#notifiedTurns.size <= 150) break; }
              }
              this.#relay?.notify("done", snippet);
            }
          } else {
            // Diagnosable, not silent: "why didn't I get a push" was previously
            // unanswerable from logs.
            process.stderr.write(`[notify] ${this.id}: done push skipped (${notifyBlockers.join(",")})\n`);
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
/**
 * Scan a captured pane for an interactive auth URL (e.g. Claude Code's `/login`
 * OAuth box, or a device-login URL from another CLI). The TUI hard-wraps the URL
 * across several lines, so we rejoin the contiguous run of URL-character lines
 * starting at the first `https://`. Only auth-SHAPED URLs qualify
 * (oauth / authorize / code_challenge / device / login) so a stray link in
 * normal agent output won't trigger a false login prompt. Returns the
 * reassembled URL, or null.
 */
const URL_CHARS = /^[A-Za-z0-9%:/?=&+._~#@!$',;()*-]+$/;
export interface PaneLogin { url: string; error?: string }
/** The post-login "Login successful. Press Enter to continue…" screen — a
 *  keypress with no decision attached. Detected so the daemon can press it
 *  (auto-continue) instead of stranding a freshly-authed session on a human
 *  Enter (boite voltagen, 2026-08-17). */
export function loginContinueFromPane(text: string): boolean {
  return /login successful[\s\S]{0,120}press\s+.{0,20}enter.{0,20}\s+to\s+continue/i.test(text);
}

export function loginFromPane(text: string): PaneLogin | null {
  const AUTH = /(oauth|authorize|code_challenge|\/device|\/login)/i;
  // Only CLAUDE login URLs qualify. The pane shows conversation output too, and
  // agents print third-party auth links all the time (AWS SSO device URLs,
  // GitHub device flows…) — an awsapps.com/#/device link in a reply put the
  // login bar up for a session that was fine (fny eventhorizon, 2026-07-08).
  const CLAUDE_HOST = /^https?:\/\/([a-z0-9-]+\.)*(claude\.(ai|com)|anthropic\.com)\//i;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = /(https?:\/\/[^\s]+)/.exec(lines[i].trim());
    if (!m) continue;
    let url = m[1];
    let last = i;
    // Rejoin hard-wrapped continuation lines (pure URL-char lines beneath it).
    for (let j = i + 1; j < lines.length; j++) {
      const s = lines[j].trim();
      if (s.length > 0 && URL_CHARS.test(s)) { url += s; last = j; }
      else break;
    }
    // Trim any trailing box-border/punctuation the first line may have grabbed.
    url = url.replace(/[^A-Za-z0-9%/=&+_~#-]+$/, "");
    if (!AUTH.test(url) || !CLAUDE_HOST.test(url)) continue;
    // A code-rejection message lives in the box BELOW the URL (the "Paste code"
    // region) — scanning only there excludes the 401 "Invalid authentication
    // credentials" trigger line, which sits ABOVE the box.
    let error: string | undefined;
    for (let j = last + 1; j < lines.length; j++) {
      const s = lines[j].replace(/[│|]/g, "").trim();
      if (!s) continue;
      if (/\b(invalid|incorrect|expired|failed|denied|rejected|unable|wrong|try again|not valid|could ?not|couldn)\b/i.test(s)) {
        error = s.slice(0, 160);
        break;
      }
    }
    return { url, error };
  }
  return null;
}

/** Convenience: just the auth URL (or null). */
export function authUrlFromPane(text: string): string | null {
  return loginFromPane(text)?.url ?? null;
}

/**
 * True only when the pane shows the ACTIVE /login form — the place a pasted
 * auth code may be typed. The URL alone is not it (#482): agents quote
 * claude.ai/oauth links in replies, and a normal ready chat pane with such a
 * link matched `authUrlFromPane`, so /login-code typed the secret into the
 * conversation input and submitted it to the agent. Requires the form's own
 * code-input marker ("Paste code here if prompted >", live shape) AND no live
 * ready input box — the form REPLACES the box. Exported for tests.
 */
export function paneShowsLoginForm(text: string): boolean {
  const plain = stripAnsi(text);
  if (!authUrlFromPane(plain)) return false;
  if (!/paste code here/i.test(plain)) return false;
  if (paneShowsReadyPrompt(plain)) return false;
  return true;
}

/**
 * Detect an interactive CLI dialog (model picker, "Switch model?" confirm,
 * /effort slider, and future kin) occupying the pane. These dialogs REPLACE
 * the input box, write NO transcript entry until resolved, and show neither
 * the ready prompt nor "esc to interrupt" — so a dispatched command that
 * opened one used to false-fail on the echo timeout and wedge the queue
 * (verified live: /model opus's confirm produced zero transcript entries
 * while open, and every pane matcher read false; captures 2026-07-20).
 *
 * Shape (verified on claude 2.1.198 live captures):
 *   ▔▔▔▔▔▔▔▔…                     ← upper-block rule: the dialog's top border.
 *      <title line>                  The normal input box uses ─/━, never ▔.
 *      1. option / ❯ 1. option    ← numbered picker rows (confirm/model), OR
 *      ←/→ to adjust · Enter to confirm · Esc to cancel   ← footer (slider/model)
 *
 * A ▔-rule alone is not enough (could echo in scrollback content): require
 * numbered options or a dialog footer below it.
 */
const DIALOG_RULE_RE = /^\s*▔{8,}\s*$/;
const DIALOG_OPTION_RE = /^\s*(?:❯\s*)?\d+\.\s+\S/;
const DIALOG_FOOTER_RE = /Esc to cancel|Enter to confirm/i;
export interface PaneDialog { title: string | null; options: string[] }
/** Parse the CLI's API-retry spinner line from pane text, e.g.
 *  `✻ 529 Overloaded · Retrying in 18s · attempt 10/10`.
 *  Claude Code ≥2.1.x stopped writing api_error transcript entries for these
 *  (verified 2026-07-29: a 10-attempt 529 storm left ZERO entries), so the
 *  pane is the ONLY signal — without this the app shows a silent stall. */
export function retryFromPane(text: string): { status: number; attempt: number; total: number; delaySec: number } | null {
  const m = /\b([45]\d\d)\s+[A-Za-z][\w ]{0,30}·\s*Retrying in\s+(\d+)\s*s\b.*?attempt\s+(\d+)\/(\d+)/i.exec(text);
  if (!m) return null;
  return { status: parseInt(m[1], 10), delaySec: parseInt(m[2], 10), attempt: parseInt(m[3], 10), total: parseInt(m[4], 10) };
}

export function dialogFromPane(text: string): PaneDialog | null {
  const lines = text.split("\n");
  let rule = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (DIALOG_RULE_RE.test(lines[i])) { rule = i; break; }
  }
  if (rule < 0) return numberedPickerFromPane(lines);
  const region = lines.slice(rule + 1);
  // A REAL dialog replaces the input box — it cannot coexist with a live ready
  // prompt or a generating footer BELOW its rule. Checking the region (not the
  // whole pane — verify round caught that): dialog-shaped content QUOTED in
  // scrollback above the live box must not match (the live prompt sits below
  // the quoted rule), while a quoted ready-box above a REAL dialog must not
  // UN-match it (that quote sits above the dialog's rule, outside the region).
  const regionText = region.join("\n");
  if (paneShowsReadyPrompt(regionText) || paneShowsGenerating(regionText)) return null;
  const options = region
    .filter((l) => DIALOG_OPTION_RE.test(l))
    .map((l) => l.trim().replace(/^❯\s*/, "").slice(0, 120));
  const hasFooter = region.some((l) => DIALOG_FOOTER_RE.test(l));
  if (options.length === 0 && !hasFooter) return null;
  const title = region.find((l) => l.trim())?.trim().slice(0, 120) ?? null;
  return { title, options };
}

/** Fallback for pickers that do NOT use the ▔ modal rule (e.g. the
 *  resume-from-summary dialog draws ─, and rule styles have changed across CLI
 *  versions) — so this deliberately keys on the OPTIONS, not any border: a run
 *  of numbered rows counting up from 1, one of which carries the ❯ selector
 *  (pickers always render a default selection). A live input box anywhere on
 *  screen disqualifies the pane — a real picker replaces the box, so numbered
 *  content coexisting with a ready prompt or generating footer is scrollback
 *  (e.g. a QUOTED picker pasted into chat). */
function numberedPickerFromPane(lines: string[]): PaneDialog | null {
  const full = lines.join("\n");
  if (paneShowsReadyPrompt(full) || paneShowsGenerating(full)) return null;
  // Collect numbered rows as (line index, number, selected) and split into
  // runs that count up from 1 — scrollback lists and the live picker can both
  // be on screen, so pick the run holding the ❯ selection.
  type Row = { i: number; n: number; sel: boolean };
  const rows: Row[] = [];
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    const m = /^(❯\s*)?(\d+)\.\s+\S/.exec(t);
    if (m) rows.push({ i, n: parseInt(m[2], 10), sel: !!m[1] });
  }
  let run: Row[] = [];
  let best: Row[] | null = null;
  for (const r of rows) {
    if (r.n === 1) run = [r];
    else if (run.length && r.n === run[run.length - 1].n + 1) run.push(r);
    else run = [];
    if (run.length >= 2 && run.some((x) => x.sel)) best = [...run];
  }
  if (!best) return null;
  const options = best.map((r) => lines[r.i].trim().replace(/^❯\s*/, "").slice(0, 120));
  // Title: nearest non-empty, non-rule line above the first option row.
  let title: string | null = null;
  for (let i = best[0].i - 1; i >= 0; i--) {
    const t = lines[i].trim();
    if (!t) continue;
    if (/^[─━▔]{3,}/.test(t)) break;
    title = t.slice(0, 120);
    break;
  }
  return { title, options };
}

/**
 * True when a line is the input box's horizontal rule. Claude renders the box
 * borders as a run of ─/━ — but with an agent name set (the app's rename flow,
 * /agents, or a harness), the TOP border carries an embedded label, e.g.
 * `──────────────── Joy ──`. A pure-rule regex made every parser below blind to
 * such a box (paneInputText → null forever → dispatch silently retried for the
 * session's whole life — the "app messages never arrive" bug of 2026-07-04), so
 * accept an optional non-rule label segment followed by rule chars.
 *
 * ONE rule char after the label is enough: how many trail the name depends on
 * the pane width, and requiring two brought the same bug straight back — caught
 * live 2026-09-03 on a full-width pane whose border ended `──────── Joy ─`, with
 * the dispatch gate reporting "pane busy or not at the prompt" for over an hour
 * while the session sat idle.
 */
function isBoxRule(s: string | undefined): boolean {
  return /^[─━]{3,}(?:[^─━]{1,80}[─━]+)?$/.test((s ?? "").trim());
}

/**
 * Footer-SHAPED line: the status bar Claude paints under the input box. Live
 * shapes (captured 2026-09-06, claude 2.1.2xx):
 *   `  ⏵⏵ auto mode on (shift+tab to cycle) · esc to interrupt · ← for agents`
 *   `  ⏸ plan mode on (shift+tab to cycle)`
 *   `  ? for shortcuts · ← for agents`            (default mode: no glyph)
 * Keyed on the glyph / the shortcut hints — NOT on bare mode words. The old
 * `bypass permissions|accept edits|plan mode` alternatives matched ordinary
 * prose inside a multi-line draft ("Explain plan mode on this project") and
 * truncated the box read to "" — the gate then typed a second prompt on top of
 * the draft (#486).
 */
const FOOTER_LINE_RE = /^\s*(?:⏵⏵|⏸)\s|shift\+tab|\?\s*for shortcuts|←\s*for agents|↓\s*to manage/i;

/** The live input box's geometry in a captured pane (line indexes). */
interface LiveBox {
  /** The `❯` prompt line. */
  prompt: number;
  /** First line AFTER the box content (the bottom rule, a footer line, or EOF). */
  end: number;
  /** Index of the bottom rule, or -1 when the capture is missing it. */
  bottomRule: number;
}

/**
 * Locate Claude's LIVE input box: the `❯` line with a box rule directly above
 * it (scrollback echoes of past prompts have no rule) and its content region
 * down to the bottom rule. The ONE geometry every box parser below shares, so
 * ready / text / span / footer all agree on what the box is.
 *
 *  - Content is delimited by the ACTUAL bottom rule when the capture has one;
 *    footer signatures only bound a capture that is missing its rule (#486).
 *  - A numbered `❯ 1. …` row is a selector option (trust dialog, pickers), NOT
 *    the box, only when the dialog layout says so: no bottom rule under it, or
 *    the next row continues the count (`2.`). A lone `❯ 1. Review the build`
 *    inside a bordered box is a human draft — rejecting every numbered row made
 *    the live box vanish from dispatch, so an app prompt sat queued forever with
 *    no banner while Claude was idle (#485). A multi-line numbered list between
 *    two rules is told apart by the prompt COLUMN: a flush-left `❯` is the input
 *    box (a numbered draft), an indented `❯` is a picker's selected row.
 */
function locateLiveBox(lines: string[]): LiveBox | null {
  for (let i = 1; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t.startsWith("❯")) continue;
    if (!isBoxRule(lines[i - 1])) continue;
    let end = i + 1;
    while (end < lines.length && !isBoxRule(lines[end])) end++;
    let bottomRule = -1;
    if (end < lines.length) {
      bottomRule = end;
    } else {
      // No bottom rule in the capture (truncated) — bound by the footer instead.
      end = i + 1;
      while (end < lines.length && !FOOTER_LINE_RE.test(lines[end])) end++;
    }
    const numbered = /^❯\s*(\d+)\.\s/.exec(t);
    if (numbered) {
      if (bottomRule < 0) continue; // selector rows are never boxed
      const n = parseInt(numbered[1], 10);
      let k = i + 1;
      while (k < end && !lines[k].trim()) k++;
      if (k < end && new RegExp(`^\\s*(?:❯\\s*)?${n + 1}\\.\\s+\\S`).test(lines[k])) {
        // The count continues: an option run — UNLESS the `❯` is flush left.
        // Claude paints the input prompt in column 0 (`❯` + nbsp); every
        // selector row sits indented under its dialog title (live captures:
        // the trust dialog, permission prompts, the model and resume pickers).
        // A flush-left numbered list between two rules is a multi-line
        // numbered DRAFT: it used to read as a selector (null: not ready,
        // never "empty"), so the drain waited on it forever with no dirty-
        // input banner while Claude sat idle (#485 residual).
        if (!/^❯/.test(lines[i])) continue; // indented → option run
      }
    }
    return { prompt: i, end, bottomRule };
  }
  return null;
}

export function paneShowsReadyPrompt(text: string): boolean {
  return locateLiveBox(stripAnsi(text).split("\n")) !== null;
}

/**
 * Is the `Try "…"` text in the live box Claude's dimmed GHOST placeholder or a
 * human draft that happens to start with Try and a quote (#478)? In plain text
 * the two are identical, so the answer comes from terminal ATTRIBUTES when the
 * capture carries them (capture-pane -e): the placeholder is painted dim /
 * grey, typed text in the default colour (live capture 2026-09-06: a typed
 * `Try "npm test"` renders `\x1b[39m❯ Try "npm test"`). `rawLine` is the
 * un-stripped `❯` line; with no SGR on it at all (a plain capture) the legacy
 * text heuristic decides — kept because a real ghost box misread as a draft
 * would be C-u'd (a no-op on an empty box) until the gate paused input_dirty,
 * wedging the first message of every fresh session.
 */
const GHOST_TEXT_RE = /^Try\s+["“'][^"”']*["”']$/;
function isGhostPlaceholder(rawLine: string, joined: string): boolean {
  if (!GHOST_TEXT_RE.test(joined)) return false;
  const tryAt = rawLine.search(/Try\s+["“']/);
  const glyphAt = rawLine.indexOf("❯");
  if (tryAt < 0 || !/\x1b\[/.test(rawLine)) return true; // plain capture → legacy heuristic
  const between = rawLine.slice(glyphAt >= 0 ? glyphAt : 0, tryAt);
  const sgrs = [...between.matchAll(/\x1b\[([\d;]*)m/g)].map((m) => m[1]);
  const dimOrGrey = sgrs.some((s) => {
    const parts = s.split(";");
    if (parts.includes("2") || parts.includes("90")) return true;   // dim / bright-black
    const i = parts.indexOf("5");
    if (i > 0 && parts[i - 1] === "38" && parts[i + 1] !== undefined) {
      const n = parseInt(parts[i + 1], 10);
      return n === 8 || (n >= 240 && n <= 255);                   // 256-colour greys
    }
    return false;
  });
  // SGR present on the line: dim/grey text is the placeholder; default-colour
  // text is a draft. (The `❯` line always starts with a reset after the grey
  // rule above it, so a coloured capture reliably carries at least one SGR.)
  return dimOrGrey;
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
 * the box is empty) count as empty — they are not user content. Pass a
 * capture-pane -e (coloured) capture when you can: the dim attribute is what
 * tells a placeholder from a draft that starts with `Try "` (#478). This is the
 * primitive the dispatch gate uses to refuse typing into a non-empty box (which
 * is how two messages used to concatenate into one garbled turn).
 */
export function paneInputText(text: string): string | null {
  const rawLines = text.split("\n");
  const lines = rawLines.map(stripAnsi);
  const box = locateLiveBox(lines);
  if (!box) return null;
  // Read the WHOLE box: the ❯ line PLUS any continuation lines down to the bottom
  // rule. A wrapped / multi-line (C-j) input box spans several lines between the
  // rules; reading only the ❯ line would miss text on a blank-first-line box and
  // wrongly report "empty", letting a dispatch concatenate on top of it.
  const parts: string[] = [];
  const first = lines[box.prompt].trim().replace(/^❯/, "").replace(/\s+/g, " ").trim();
  if (first) parts.push(first);
  for (let j = box.prompt + 1; j < box.end; j++) {
    const cont = lines[j].replace(/\s+/g, " ").trim();
    if (cont) parts.push(cont);
  }
  const joined = parts.join(" ");
  if (!joined) return "";
  if (parts.length === 1 && isGhostPlaceholder(rawLines[box.prompt], joined)) return "";
  return joined;
}

/**
 * Number of rendered lines the live input box spans (the ❯ line plus its
 * continuation lines down to the bottom rule/footer) — 0 when no box. Sizes the
 * C-u press budget in #clearBoxWithCtrlU: C-u kills one line per press and the
 * line break costs another, so a box of N rendered lines needs ~2N presses.
 * Rendered (wrapped) lines over-count logical lines, which only pads the
 * budget — the loop exits early once the box reads empty.
 */
export function paneInputLineSpan(text: string): number {
  const box = locateLiveBox(stripAnsi(text).split("\n"));
  return box ? box.end - box.prompt : 0;
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
 * The LIVE status region of a pane: the lines below the live input box (where
 * Claude paints its footer), or the last few lines when no box is on screen
 * (a dialog). Everything above the box is conversation output / scrollback and
 * must never be read as live status (#479, #480).
 */
function liveStatusLines(lines: string[], fallbackTail = 4): string[] {
  const box = locateLiveBox(lines);
  return box ? lines.slice(box.bottomRule >= 0 ? box.bottomRule + 1 : box.end) : lines.slice(-fallbackTail);
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
  const region = liveStatusLines(stripAnsi(text).split("\n"))
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
 *
 * The hint is read ONLY where Claude paints it live (#479): the status footer
 * under the box (`… · esc to interrupt · …`, live capture 2026-09-06) and the
 * spinner line above it (`✻ Ruminating… (esc to interrupt)`, older builds).
 * Conversation text quoting the phrase ("You can press Esc to interrupt a
 * running command") used to classify an idle pane as generating for as long as
 * the reply stayed on screen, holding every queued prompt.
 */
export function paneShowsGenerating(text: string): boolean {
  const lines = stripAnsi(text).split("\n");
  // Live footer: below the box (or the tail when no box), footer-shaped, with
  // the hint as a `·`-separated segment.
  if (liveStatusLines(lines, 6).some((l) => FOOTER_LINE_RE.test(l) && /(?:·|^)\s*esc to interrupt/i.test(l))) return true;
  // Spinner line: glyph-led, in the live bottom region (scrollback can echo old
  // spinner text far above). The hint is parenthesised there.
  const tail = lines.slice(-12);
  if (tail.some((l) => /^\s*[✽✻✶✳✢·∗⠂⠐⠈]\s.*\(\s*esc to interrupt\b/i.test(l))) return true;
  // Narrow-pane fallback: on a small attached client (e.g. 58 cols) claude
  // truncates the status line before "esc to interrupt" ("… · esc to…"), which
  // made the daemon read a generating pane as idle (and, with the box parser
  // also blind, kept dispatch gated forever — 2026-07-04). The spinner line
  // itself survives truncation: `✽ Zesting… (4m 17s · ↓ 13.9k tokens …`. Match
  // its shape — spinner glyph, word, ellipsis, then an elapsed-time paren —
  // only in the live bottom region (scrollback can echo old spinner text).
  return tail.some(l => /^\s*[✽✻✶✳✢·∗]\s+\w[\w '’-]*…\s*\(\d+[ms]?\s?\d*s?\b/u.test(l));
}

/** Human-readable backoff delay for retry notes: "15s", "2m". Exported for tests. */
export function formatRetryDelay(sec: number): string {
  return sec < 60 ? `${sec}s` : `${Math.round(sec / 60)}m`;
}

/**
 * Footer → permission mode. Read from the LIVE footer only — the glyph-led
 * status line under the input box (or the pane tail when no box is up) — never
 * from conversation text: a reply quoting "bypass permissions on" while the
 * footer said "plan mode on" made setPermissionMode believe it was already in
 * bypass, send no Shift+Tab, report success and persist the wrong mode (#480).
 * Exported for tests.
 */
export function parsePermissionModeFromPane(text: string): string {
  const region = liveStatusLines(stripAnsi(text).split("\n"), 6)
    .filter((l) => /^\s*(?:⏵⏵|⏸)\s/.test(l))
    .join("\n");
  if (/bypass permissions on/i.test(region)) return "bypassPermissions";
  if (/auto mode on/i.test(region)) return "auto";
  if (/accept edits on/i.test(region)) return "acceptEdits";
  if (/plan mode on/i.test(region)) return "plan";
  return "default"; // no marker line in default mode
}

/**
 * Keys that answer the folder-trust dialog with "yes", derived from the pane
 * rather than assumed. Claude has shipped the options in both orders and with
 * and without leading digits, so a hard-coded "1" is a coin flip that, when it
 * loses, exits the agent.
 *
 * Returns the key sequence to send, or null if the option list hasn't painted
 * yet (caller keeps polling). Exported for tests.
 */
export function trustPromptKeys(pane: string): string[] | null {
  const YES = /Yes,\s*I\s*trust\s*this\s*folder|Yes,\s*proceed/i;
  const NO = /No,\s*exit/i;
  const options: { yes: boolean; digit?: string; selected: boolean }[] = [];
  for (const raw of pane.split("\n")) {
    if (!YES.test(raw) && !NO.test(raw)) continue;
    // Menu rows only: the question itself ("...Is this a project you trust?")
    // never carries an option label, but a wrapped paragraph might — require
    // the row to be short and to start with the marker/indent/digit shape.
    const row = raw.trimEnd();
    if (!/^\s*(❯|>)?\s*(\d+[.)])?\s*(Yes|No)\b/.test(row)) continue;
    options.push({
      yes: YES.test(row),
      digit: row.match(/^\s*(?:❯|>)?\s*(\d+)[.)]/)?.[1],
      selected: /^\s*(❯|>)\s/.test(row),
    });
  }
  const target = options.findIndex(o => o.yes);
  if (target < 0) return null;
  // Explicitly numbered menus accept the digit directly.
  const digit = options[target].digit;
  if (digit) return [digit, "Enter"];
  // Otherwise walk the cursor from its current row to the trust row. With no
  // marker rendered, assume the first row is selected (claude's default).
  const cursor = Math.max(0, options.findIndex(o => o.selected));
  const delta = target - cursor;
  const arrows = Array.from({ length: Math.abs(delta) }, () => (delta > 0 ? "Down" : "Up"));
  return [...arrows, "Enter"];
}

function summarizeInput(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const inp = input as Record<string, unknown>;
  if (typeof inp.command === "string") return inp.command.split("\n")[0].slice(0, 70);
  if (typeof inp.file_path === "string") return inp.file_path;
  if (typeof inp.pattern === "string") return inp.pattern;
  return JSON.stringify(input).slice(0, 70);
}
