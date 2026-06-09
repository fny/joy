#!/usr/bin/env bun
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, watch, readdirSync, statSync, openSync, readSync, closeSync } from "fs";
import { join, basename } from "path";
import { homedir, hostname, platform as osPlatform } from "os";
import { initRelay, createRelaySession, encodeTurnStart, encodeTextEvent, encodeToolCallStart, encodeToolCallEnd, encodeTurnEnd, encodeUserMessage, type RelaySession } from "./relay.ts";
import { registerSessionRpcs } from "./sessionRpcs";
import { writeAttachmentToCwd } from "./attachments";

const PORT = parseInt(process.env.PORT ?? "4997");
const TMUX_SESSION = process.env.TMUX_SESSION ?? "joy";
const PUBLIC_DIR = join(import.meta.dir, "public");

// ── Message store ─────────────────────────────────────────────────────────────
interface Message {
  id: string;
  role: "user" | "assistant" | "event";
  content: string;
  source: "web" | "cli" | "rpc";
  timestamp: number;
  chat_id?: string;
  session_id?: string;
  event_type?: string;
  event_status?: "info" | "success" | "error" | "warning";
}

const MAX_MESSAGES = 500;
const messages: Message[] = [];
let nextChatId = 1;
let nextMsgId = 1;

function addMessage(msg: Omit<Message, "id" | "timestamp">): Message {
  const full: Message = { ...msg, id: String(nextMsgId++), timestamp: Date.now() };
  messages.push(full);
  if (messages.length > MAX_MESSAGES) messages.splice(0, messages.length - MAX_MESSAGES);
  broadcast("message", full);
  return full;
}

// ── Session store ─────────────────────────────────────────────────────────────
interface SessionRecord {
  id: string;
  claude_session_id?: string;
  pid?: number;
  tmux_window: string;
  cwd: string;
  model?: string;
  effort?: string;
  flags: string[];
  status: "starting" | "active" | "ended";
  started_at: number;
  last_active_at: number;
  end_reason?: string;
  transcript_path?: string;
  relay_session_id?: string;
}

const sessions = new Map<string, SessionRecord>();
const relaySessions = new Map<string, RelaySession>(); // tmux session id → relay session
let relayClient = initRelay();

interface CreateSessionOpts {
  cwd: string;
  model?: string;
  effort?: string;
  continue?: boolean;
  resume_id?: string;
  createDir?: boolean;
  yolo?: boolean;
}

const transcriptWatchers = new Map<string, { close: () => void; byteOffset: number }>();
const turnStates = new Map<string, { turnId: string }>();

// ── Delivery receipts ────────────────────────────────────────────────────────
// See ./receipts.ts for the persistence + matching logic.
import {
  initDeliveryState,
  matchPendingForUserEntry,
  recordInboundReceipt as _recordInboundReceipt,
  recordOutboundReceipt as _recordOutboundReceipt,
  type DeliveryState,
  type InboundReceipt,
  type OutboundReceipt,
} from "./receipts";

const deliveryStates = new Map<string, DeliveryState>(); // sessionId → state

// Per-session bucket of attachment downloads that arrived ahead of a text
// message. Each entry is a promise that resolves to the decrypted blob
// (or null on failure). On the next user-text message we drain the bucket,
// write surviving images into the session's cwd, and append the bare
// relative paths to the text before piping into tmux.
const pendingAttachments = new Map<string, Promise<Uint8Array | null>[]>();

// Per-session message buffer used while the session is still starting.
// Claude takes ~2-5s to initialize after the tmux window opens; send-keys
// during that window land in bash or claude's loading screen and are lost.
// We queue here and flush in handleTranscriptEntry once Claude's first
// transcript line arrives (the same place where status flips to "active").
type PendingTextMessage = { seq: number; text: string };
const pendingPrelaunchMessages = new Map<string, PendingTextMessage[]>();
// sessionId → flusher that drains the prelaunch buffer for that session.
// Registered by wireRelaySession, invoked by handleTranscriptEntry on the
// status='starting' → 'active' transition.
const prelaunchFlushers = new Map<string, () => void>();

// Builds the standard onMessage callback + registers session-scoped RPC
// handlers (abort) for a newly-created relay session. Used by launch, recover,
// and reconnect paths so the wiring stays consistent.
function wireRelaySession(opts: {
  sessionId: string;
  tmuxWindow: string;
  rs: RelaySession;
  sessionAlive: () => boolean;
  watcherActive: () => boolean;
  startWatcher: () => void;
}): void {
  const { sessionId, tmuxWindow, rs, sessionAlive, watcherActive, startWatcher } = opts;

  // File events arrive ahead of the user-text message. Kick off the
  // download/decrypt immediately and stash the promise; the next onMessage
  // call drains the bucket, writes survivors into cwd, and appends paths
  // to the chat text.
  rs.onFileEvent = (ev) => {
    if (!relayClient) return;
    const { sessionKey, variant } = rs.encryptionMaterial;
    const promise = relayClient.downloadAndDecryptAttachment(rs.relaySessionId, ev.ref, sessionKey, variant);
    const bucket = pendingAttachments.get(sessionId) ?? [];
    bucket.push(promise);
    pendingAttachments.set(sessionId, bucket);
  };

  // Actually type a message into the tmux pane + record receipt + bump thinking.
  // Pulled out of onMessage so the prelaunch buffer flusher can reuse it.
  const sendIntoTmux = (seq: number, text: string): void => {
    const st = getOrInitDeliveryState(sessionId, rs.relaySessionId);
    st.pending.push({ seq, text, source: 'relay', at: Date.now() });
    const r = run("tmux", "send-keys", "-l", "-t", tmuxWindow, text.replace(/\n/g, " "));
    if (!r.ok) { st.pending.pop(); throw new Error("tmux send-keys failed"); }
    run("tmux", "send-keys", "-t", tmuxWindow, "Enter");
    rs.setThinking(true);
    if (!watcherActive() && sessionAlive()) startWatcher();
  };

  rs.onMessage = async (text, seq) => {
    // Drain attachments first so paths can be appended to this turn's text.
    // Atomic swap: take the bucket, replace with an empty one so any
    // late-arriving file event lands in the next batch (matches
    // happy-cli's drainAttachmentsForUserMessage swap-then-await order).
    const drained = pendingAttachments.get(sessionId) ?? [];
    pendingAttachments.set(sessionId, []);
    let augmentedText = text;
    if (drained.length > 0) {
      const sess = sessions.get(sessionId);
      const cwd = sess?.cwd;
      const results = await Promise.all(drained);
      const paths: string[] = [];
      if (cwd) {
        for (const bytes of results) {
          if (!bytes) continue;
          const refPath = writeAttachmentToCwd(cwd, bytes);
          if (refPath) paths.push(refPath);
        }
      }
      if (paths.length > 0) {
        // Append the bare relative paths after the text, space-separated.
        // tmux send-keys -l followed by Enter sends a single line, so we
        // can't preserve line breaks; one space between the prompt and the
        // first path, single space between paths. Claude code interactive
        // resolves these against the session cwd and reads each file as
        // an image.
        augmentedText = text + " " + paths.join(" ");
      }
    }

    // If Claude hasn't booted yet, buffer the message and let the
    // transcript-watcher flush it once status flips to 'active'. Without
    // this, the first user message after launch races Claude's startup
    // and ends up typed into bash before claude takes over the pane.
    const sess = sessions.get(sessionId);
    if (sess && sess.status === "starting") {
      const buf = pendingPrelaunchMessages.get(sessionId) ?? [];
      buf.push({ seq, text: augmentedText });
      pendingPrelaunchMessages.set(sessionId, buf);
      return;
    }

    sendIntoTmux(seq, augmentedText);
  };

  // Stash the flusher so handleTranscriptEntry can call it when status
  // first flips to 'active'. Keyed by the joy-tmux local session id.
  prelaunchFlushers.set(sessionId, () => {
    const buf = pendingPrelaunchMessages.get(sessionId);
    if (!buf || buf.length === 0) return;
    pendingPrelaunchMessages.delete(sessionId);
    for (const m of buf) {
      try { sendIntoTmux(m.seq, m.text); }
      catch (e) { process.stderr.write(`[prelaunch] flush failed for ${sessionId}: ${e}\n`); }
    }
  });

  // Session-scoped abort: app calls sessionRPC(sessionId, 'abort', {}) — we
  // map that to Escape, which Claude Code interactive interprets as
  // "interrupt current generation, return to prompt."
  rs.registerRpc('abort', async () => {
    run("tmux", "send-keys", "-t", tmuxWindow, "Escape");
    rs.setThinking(false);
    return { ok: true };
  });

  // Session-scoped file/shell RPCs (bash, readFile, writeFile, listDirectory,
  // getDirectoryTree, ripgrep) + killSession. These let the app's file
  // browser, search, and archive button work against joy-tmux sessions just
  // like they do for happy-cli sessions.
  const sess = sessions.get(sessionId);
  const cwd = sess?.cwd ?? process.cwd();
  registerSessionRpcs({
    register: (method, handler) => rs.registerRpc(method, handler),
    sessionCwd: cwd,
    killSession: () => killSession(sessionId),
  });
}

function getOrInitDeliveryState(sessionId: string, relaySessionId: string): DeliveryState {
  let st = deliveryStates.get(sessionId);
  if (!st) {
    st = initDeliveryState(relaySessionId);
    deliveryStates.set(sessionId, st);
  }
  return st;
}

function recordInboundReceipt(sessionId: string, relaySessionId: string, receipt: InboundReceipt): void {
  _recordInboundReceipt(getOrInitDeliveryState(sessionId, relaySessionId), relaySessionId, receipt);
}

function recordOutboundReceipt(sessionId: string, relaySessionId: string, receipt: OutboundReceipt): void {
  _recordOutboundReceipt(getOrInitDeliveryState(sessionId, relaySessionId), relaySessionId, receipt);
}

// ── SSE broadcast ─────────────────────────────────────────────────────────────
const sseListeners = new Set<(data: string) => void>();

function broadcast(event: string, data: unknown) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const emit of sseListeners) emit(payload);
}

// ── Shell helpers ─────────────────────────────────────────────────────────────
function run(...args: string[]): { ok: boolean; out: string } {
  const r = Bun.spawnSync(args, { stderr: "pipe" });
  return { ok: r.exitCode === 0, out: new TextDecoder().decode(r.stdout).trim() };
}

// ── Transcript path inference ─────────────────────────────────────────────────
function cwdToTranscriptDir(cwd: string): string {
  return join(homedir(), ".claude", "projects", cwd.replace(/\//g, "-"));
}

function findLatestTranscript(dir: string, minMtime: number): string | null {
  try {
    let latest: { path: string; mtime: number } | null = null;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".jsonl")) continue;
      try {
        const p = join(dir, f);
        const mtime = statSync(p).mtimeMs;
        if (mtime >= minMtime && (!latest || mtime > latest.mtime)) latest = { path: p, mtime };
      } catch {}
    }
    return latest?.path ?? null;
  } catch { return null; }
}

// M4: 120 attempts × 500ms = 60s window, enough for slow first-runs (trust prompts etc.)
function pollForTranscript(sess: SessionRecord, attempts = 0) {
  if (transcriptWatchers.has(sess.id) || sess.status === "ended") return;
  const path = findLatestTranscript(cwdToTranscriptDir(sess.cwd), sess.started_at);
  if (path) { startTranscriptWatcher(sess, path); return; }
  if (attempts < 120) {
    setTimeout(() => pollForTranscript(sess, attempts + 1), 500);
  } else {
    process.stderr.write(`[transcript] WARN: no transcript found for ${sess.id} after 60s — assistant output will not reach the relay\n`);
  }
}

// ── JSONL entry processing ────────────────────────────────────────────────────
function summarizeInput(toolName: string, input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const inp = input as Record<string, unknown>;
  if (typeof inp.command === "string") return inp.command.split("\n")[0].slice(0, 70);
  if (typeof inp.file_path === "string") return inp.file_path;
  if (typeof inp.pattern === "string") return inp.pattern;
  return JSON.stringify(input).slice(0, 70);
}

function handleTranscriptEntry(sess: SessionRecord, entry: Record<string, unknown>) {
  const entryType = String(entry.type || "");

  // First entry activates the session
  if (sess.status === "starting") {
    const sid = String(entry.sessionId || "");
    if (sid) {
      sess.claude_session_id = sid;
      sess.status = "active";
      sess.last_active_at = Date.now();
      broadcast("session_update", sess);
      // Claude is now reading from the pane — drain any messages the user
      // sent while we were waiting for it to boot.
      prelaunchFlushers.get(sess.id)?.();
    }
  }

  const sid = sess.claude_session_id;

  // Turn complete → send turn-end and clear turn state
  if (entryType === "system" && entry.subtype === "stop_hook_summary") {
    broadcast("stop", { session_id: sid });
    const rs = relaySessions.get(sess.id);
    const ts = turnStates.get(sess.id);
    if (rs && ts) {
      rs.send(encodeTurnEnd('completed', { turn: ts.turnId }));
    }
    turnStates.delete(sess.id);
    rs?.setThinking(false);
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
      const rs = relaySessions.get(sess.id);
      const ts = turnStates.get(sess.id);
      if (rs && ts && Array.isArray(content)) {
        for (const item of content as Array<Record<string, unknown>>) {
          if (item.type === "tool_result" && typeof item.tool_use_id === "string") {
            rs.send(encodeToolCallEnd(item.tool_use_id, { turn: ts.turnId }));
          }
        }
      }
      return;
    }
    // skip slash command wrappers injected by the CLI
    if (content.startsWith("<local-command") || content.startsWith("<command-name>")) return;

    // Match this transcript entry against the front of the pending-send queue.
    // Identical messages are matched sequentially: two "yes" sends pair with
    // two "yes" transcript entries in order, regardless of text equality.
    const uuid = typeof entry.uuid === "string" ? entry.uuid : "";
    const rs = relaySessions.get(sess.id);
    if (rs && uuid) {
      const st = getOrInitDeliveryState(sess.id, rs.relaySessionId);
      const front = st.pending[0];
      if (front && front.text === content) {
        st.pending.shift();
        recordInboundReceipt(sess.id, rs.relaySessionId, {
          seq: front.seq, uuid, text: content, source: front.source, at: Date.now(),
        });
        return; // self-echo of a relay/HTTP/RPC send — don't double-record locally
      }
      // No queue match → direct typing in the tmux pane. Skip if we already
      // forwarded it (recovery), otherwise mirror it to the relay so the app
      // sees the full conversation.
      if (!st.forwardedUuids.has(uuid)) {
        rs.send(encodeUserMessage(content));
        recordOutboundReceipt(sess.id, rs.relaySessionId, { uuid, turn: "", at: Date.now() });
      }
    }
    addMessage({ role: "user", content, source: "cli", session_id: sid });

  } else if (role === "assistant") {
    const blocks = Array.isArray(content) ? content as Array<Record<string, unknown>> : [];
    const rs = relaySessions.get(sess.id);
    const entryUuid = typeof entry.uuid === "string" ? entry.uuid : "";
    // Skip if we've already forwarded this transcript entry (recovery case).
    if (rs && entryUuid) {
      const st = getOrInitDeliveryState(sess.id, rs.relaySessionId);
      if (st.forwardedUuids.has(entryUuid)) return;
    }
    if (rs && blocks.length > 0) {
      // Ensure a turn is open; send turn-start on the first assistant entry per turn
      let ts = turnStates.get(sess.id);
      if (!ts) {
        ts = { turnId: crypto.randomUUID() };
        turnStates.set(sess.id, ts);
        rs.send(encodeTurnStart({ turn: ts.turnId }));
      }
      const claudeUuid = typeof entry.uuid === "string" ? entry.uuid : undefined;
      const opts = { turn: ts.turnId, claudeUuid };
      for (const block of blocks) {
        const blockType = String(block.type || "");
        if (blockType === "text") {
          const text = String(block.text || "").trim();
          if (text) rs.send(encodeTextEvent(text, opts));
        } else if (blockType === "tool_use") {
          rs.send(encodeToolCallStart({
            call: String(block.id || crypto.randomUUID()),
            name: String(block.name || "tool"),
            input: block.input,
            ...opts,
          }));
        }
      }
      // Record outbound receipt — we forwarded this transcript entry to the relay.
      if (entryUuid) {
        recordOutboundReceipt(sess.id, rs.relaySessionId, {
          uuid: entryUuid, turn: ts.turnId, at: Date.now(),
        });
      }
      // M3: send turn-end when the assistant finishes — don't require a Stop hook.
      // end_turn = normal completion; tool_use = more tool calls pending (no turn-end yet).
      const stopReason = String((msg as Record<string, unknown>).stop_reason || "");
      if (stopReason === "end_turn" || stopReason === "max_tokens") {
        rs.send(encodeTurnEnd('completed', { turn: ts.turnId }));
        turnStates.delete(sess.id);
        rs.setThinking(false);
        broadcast("stop", { session_id: sid });
      }
    }
    for (const block of blocks) {
      const blockType = String(block.type || "");
      if (blockType === "text") {
        const text = String(block.text || "").trim();
        if (text) addMessage({ role: "assistant", content: text, source: "cli", session_id: sid });
      } else if (blockType === "tool_use") {
        const name = String(block.name || "tool");
        const detail = summarizeInput(name, block.input);
        addMessage({
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

// ── Transcript watcher ────────────────────────────────────────────────────────
function startTranscriptWatcher(sess: SessionRecord, transcriptPath: string, force = false) {
  if (transcriptWatchers.has(sess.id)) {
    if (!force) return;
    transcriptWatchers.get(sess.id)!.close();
    transcriptWatchers.delete(sess.id);
  }

  sess.transcript_path = transcriptPath;
  let byteOffset = 0;
  let leftover = "";  // incomplete line carried across reads

  function readNew() {
    try {
      const { size } = statSync(transcriptPath);
      if (size <= byteOffset) return;
      const fd = openSync(transcriptPath, "r");
      const buf = Buffer.allocUnsafe(size - byteOffset);
      const bytesRead = readSync(fd, buf, 0, buf.length, byteOffset);
      closeSync(fd);
      byteOffset += bytesRead;
      const w = transcriptWatchers.get(sess.id);
      if (w) w.byteOffset = byteOffset;
      const chunk = leftover + buf.subarray(0, bytesRead).toString("utf-8");
      const parts = chunk.split("\n");
      leftover = parts.pop() ?? "";  // last part is incomplete if no trailing \n
      for (const line of parts) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          handleTranscriptEntry(sess, entry);
          broadcast("transcript_entry", { session_id: sess.claude_session_id, entry });
        } catch {}
      }
    } catch {}
  }

  let fsWatcher: ReturnType<typeof watch> | null = null;

  function attachWatcher() {
    if (sess.status === "ended") return;
    try {
      fsWatcher = watch(transcriptPath, () => readNew());
      readNew();
    } catch {
      setTimeout(attachWatcher, 500);
    }
  }

  attachWatcher();
  transcriptWatchers.set(sess.id, { close: () => fsWatcher?.close(), byteOffset });
}

function stopTranscriptWatcher(sessionId: string) {
  transcriptWatchers.get(sessionId)?.close();
  transcriptWatchers.delete(sessionId);
  turnStates.delete(sessionId);
  deliveryStates.delete(sessionId);
  relaySessions.get(sessionId)?.stop();
  relaySessions.delete(sessionId);
}

// ── PID-based session end detection ──────────────────────────────────────────
function pollSessionEnd(sess: SessionRecord) {
  if (sess.status === "ended") return;
  if (sess.pid !== undefined && !run("kill", "-0", String(sess.pid)).ok) {
    sess.status = "ended";
    sess.end_reason = "process_exited";
    sess.last_active_at = Date.now();
    stopTranscriptWatcher(sess.id);
    broadcast("session_update", sess);
    return;
  }
  setTimeout(() => pollSessionEnd(sess), 5000);
}

// ── Launch / kill ─────────────────────────────────────────────────────────────

/**
 * Sentinel thrown by launchSession when opts.cwd doesn't exist and the
 * caller hasn't set createDir. joy-create-session catches it and returns
 * { requestToApproveDirectoryCreation: { directory } } to the app, which
 * surfaces a Modal.confirm and retries with createDir: true.
 */
class DirectoryCreationApprovalRequired extends Error {
  constructor(public readonly directory: string) {
    super(`directory does not exist: ${directory}`);
  }
}

/**
 * Expand a leading ~ to the joy-tmux user's home directory. tmux's -c flag
 * does NOT expand tildes (it's not a shell), and the app may send paths
 * with ~ unresolved when the machine metadata doesn't expose homeDir.
 * This makes the resolution defensive: even if the app sends ~/foo we
 * end up with an absolute path that tmux can actually chdir into.
 */
function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

async function launchSession(opts: CreateSessionOpts): Promise<SessionRecord> {
  const id = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
  const windowName = `dd-${id}`;

  // Resolve ~, then verify the directory exists. tmux -c silently falls back
  // to the joy-tmux process's cwd when the requested directory is missing,
  // which is the root of "I asked for ~/test-2 but Claude opened in
  // /home/claude" — without this guard the wrong cwd cascades into the
  // transcript watcher looking in the wrong projects/ folder and Claude's
  // responses never reaching the app.
  const cwd = expandHome(opts.cwd);
  if (!existsSync(cwd)) {
    if (opts.createDir) {
      mkdirSync(cwd, { recursive: true });
    } else {
      throw new DirectoryCreationApprovalRequired(cwd);
    }
  }

  if (!run("tmux", "has-session", "-t", TMUX_SESSION).ok) {
    run("tmux", "new-session", "-d", "-s", TMUX_SESSION, "-c", cwd);
  }

  // Validate user-supplied fields to prevent shell injection via send-keys
  const SAFE_ID = /^[a-zA-Z0-9:._/-]{1,128}$/;
  const SAFE_EFFORT = /^[a-z]{1,32}$/;
  if (opts.model && !SAFE_ID.test(opts.model)) throw new Error("invalid model");
  if (opts.resume_id && !SAFE_ID.test(opts.resume_id)) throw new Error("invalid resume_id");
  if (opts.effort && !SAFE_EFFORT.test(opts.effort)) throw new Error("invalid effort");

  const envParts: string[] = [];
  if (opts.effort && opts.effort !== "default") envParts.push(`CLAUDE_EFFORT=${opts.effort}`);

  // YOLO mode is the default for joy-tmux sessions — the app drives the
  // session and approving permission prompts via tmux send-keys is fragile.
  // Caller can opt out with `yolo: false`.
  const yolo = opts.yolo ?? true;
  const flags: string[] = [];
  if (opts.model) flags.push("--model", opts.model);
  if (opts.continue) flags.push("--continue");
  if (opts.resume_id) flags.push("--resume", opts.resume_id);
  if (yolo) flags.push("--dangerously-skip-permissions");

  const cmd = [...envParts, "claude", ...flags].join(" ");
  run("tmux", "new-window", "-t", TMUX_SESSION, "-n", windowName, "-c", cwd);
  run("tmux", "send-keys", "-t", `${TMUX_SESSION}:${windowName}`, cmd, "Enter");

  await Bun.sleep(400);
  const shellPid = parseInt(
    run("tmux", "display-message", "-t", `${TMUX_SESSION}:${windowName}`, "-p", "#{pane_pid}").out
  );
  await Bun.sleep(800);
  let pid: number | undefined;
  if (!isNaN(shellPid)) {
    const child = parseInt(run("pgrep", "-P", String(shellPid)).out.split("\n")[0]);
    pid = isNaN(child) ? shellPid : child;
  }

  const record: SessionRecord = {
    id, pid,
    tmux_window: `${TMUX_SESSION}:${windowName}`,
    cwd,
    model: opts.model,
    effort: opts.effort,
    flags,
    status: "starting",
    started_at: Date.now(),
    last_active_at: Date.now(),
  };

  sessions.set(id, record);
  broadcast("session_update", record);
  pollForTranscript(record);
  pollSessionEnd(record);

  if (relayClient) {
    try {
      const rs = await createRelaySession(relayClient, { tag: `joy-tmux-${id}`, cwd, id });
      // M1: guard against kill racing the async create — don't start a poller for a dead session
      if (record.status === "ended") {
        rs.stop();
      } else {
        wireRelaySession({
          sessionId: id,
          tmuxWindow: record.tmux_window,
          rs,
          sessionAlive: () => record.status !== "ended",
          watcherActive: () => transcriptWatchers.has(id),
          startWatcher: () => pollForTranscript(record),
        });
        rs.start();
        relaySessions.set(id, rs);
        record.relay_session_id = rs.relaySessionId;
        broadcast("session_update", record);
      }
    } catch (e) {
      process.stderr.write(`[relay] failed to create session for ${id}: ${e}\n`);
    }
  }

  return record;
}

function recoverDirectSessions() {
  const result = run("tmux", "list-windows", "-t", TMUX_SESSION, "-F", "#{window_name}");
  if (!result.ok) return;

  for (const winName of result.out.split("\n").map(l => l.trim()).filter(Boolean)) {
    if (!/^dd-[0-9a-f]{8}$/.test(winName)) continue;
    const id = winName.slice(3);
    if (sessions.has(id)) continue;

    const tmuxWindow = `${TMUX_SESSION}:${winName}`;
    const cwd = run("tmux", "display-message", "-t", tmuxWindow, "-p", "#{pane_current_path}").out.trim();
    if (!cwd) continue;

    const shellPid = parseInt(run("tmux", "display-message", "-t", tmuxWindow, "-p", "#{pane_pid}").out.trim());
    let pid: number | undefined;
    if (!isNaN(shellPid)) {
      const child = parseInt(run("pgrep", "-P", String(shellPid)).out.split("\n")[0]);
      pid = isNaN(child) ? undefined : child;
    }

    const isAlive = pid !== undefined && run("kill", "-0", String(pid)).ok;
    const transcriptPath = findLatestTranscript(cwdToTranscriptDir(cwd), 0);
    const claudeSessionId = transcriptPath ? basename(transcriptPath, ".jsonl") : undefined;

    const record: SessionRecord = {
      id, pid, tmux_window: tmuxWindow, cwd,
      flags: [],
      status: isAlive ? "active" : "ended",
      started_at: transcriptPath ? statSync(transcriptPath).mtimeMs : Date.now(),
      last_active_at: Date.now(),
      claude_session_id: claudeSessionId,
      transcript_path: transcriptPath ?? undefined,
    };

    sessions.set(id, record);
    if (isAlive) {
      if (transcriptPath) startTranscriptWatcher(record, transcriptPath);
      pollSessionEnd(record);
      if (relayClient) {
        process.stderr.write(`[relay] creating session for recovered ${id}\n`);
        createRelaySession(relayClient, { tag: `joy-tmux-${id}`, cwd, id }).then(rs => {
          process.stderr.write(`[relay] recovered session ${id} → relay ${rs.relaySessionId}\n`);
          if (record.status === "ended") { rs.stop(); return; } // M1: alive guard
          wireRelaySession({
            sessionId: id,
            tmuxWindow: record.tmux_window,
            rs,
            sessionAlive: () => record.status !== "ended",
            watcherActive: () => transcriptWatchers.has(id),
            startWatcher: () => pollForTranscript(record),
          });
          rs.start();
          relaySessions.set(id, rs);
          record.relay_session_id = rs.relaySessionId;
          broadcast("session_update", record);
        }).catch(e => process.stderr.write(`[relay] failed to create session for ${id}: ${e}\n`));
      }
    }
    process.stderr.write(`[recover] ${id} cwd=${cwd} alive=${isAlive} transcript=${transcriptPath}\n`);
  }
}

function killSession(id: string): boolean {
  const s = sessions.get(id);
  if (!s) return false;
  stopTranscriptWatcher(id);
  // Stop the relay session (stops heartbeats + untracks from socket) and
  // archive it server-side (flips `active=false`) so the app removes the
  // session card from the active list. Mirrors happy-cli's cleanup path:
  // killing the CLI process there calls deactivateSession before exit.
  const rs = relaySessions.get(id);
  if (rs) {
    rs.stop();
    if (relayClient) {
      void relayClient.archiveSession(rs.relaySessionId);
    }
  }
  relaySessions.delete(id);
  run("tmux", "kill-window", "-t", s.tmux_window);
  s.status = "ended";
  s.end_reason = "killed";
  s.last_active_at = Date.now();
  broadcast("session_update", s);
  return true;
}

// ── HTTP server ───────────────────────────────────────────────────────────────
// H3: per-instance token required on all mutating routes — prevents drive-by
// cross-origin session creation / prompt injection via no-cors POST.
// CORS is locked to localhost origins only.
const SERVER_TOKEN = crypto.randomUUID();
process.stderr.write(`[server] token: ${SERVER_TOKEN}\n`);

const ALLOWED_ORIGINS = new Set([
  `http://localhost:${PORT}`,
  `http://127.0.0.1:${PORT}`,
]);

Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  idleTimeout: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const method = req.method;
    const origin = req.headers.get("origin") ?? "";

    const corsHeaders: Record<string, string> = {
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-Joy-Token",
    };
    // Only echo back known origins; unknown origins get no ACAO header (blocks reads)
    if (ALLOWED_ORIGINS.has(origin)) {
      corsHeaders["Access-Control-Allow-Origin"] = origin;
    }
    if (method === "OPTIONS") return new Response(null, { headers: corsHeaders });

    const json = (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });

    // Token check on all mutating routes
    const MUTATING = method === "POST" || method === "DELETE";
    if (MUTATING) {
      const tok = req.headers.get("X-Joy-Token");
      if (tok !== SERVER_TOKEN) return json({ error: "unauthorized" }, 401);
    }

    if (method === "GET" && url.pathname === "/") {
      return new Response(readFileSync(join(PUBLIC_DIR, "index.html"), "utf-8"),
        { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }
    if (method === "GET" && /^\/session\/[^/]+$/.test(url.pathname)) {
      return new Response(readFileSync(join(PUBLIC_DIR, "session.html"), "utf-8"),
        { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }
    if (method === "GET" && /^\/session\/[^/]+\/screenshot$/.test(url.pathname)) {
      return new Response(readFileSync(join(PUBLIC_DIR, "screenshot.html"), "utf-8"),
        { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }

    if (method === "GET" && url.pathname === "/events") {
      const stream = new ReadableStream({
        start(ctrl) {
          const enc = new TextEncoder();
          const enqueue = (s: string) => ctrl.enqueue(enc.encode(s));
          enqueue(`event: history\ndata: ${JSON.stringify(messages.slice(-MAX_MESSAGES))}\n\n`);
          enqueue(`event: sessions_history\ndata: ${JSON.stringify([...sessions.values()])}\n\n`);
          const emit = (d: string) => enqueue(d);
          sseListeners.add(emit);
          req.signal.addEventListener("abort", () => sseListeners.delete(emit));
        },
      });
      return new Response(stream, {
        headers: {
          ...corsHeaders,
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
          "X-Accel-Buffering": "no",
        },
      });
    }

    if (method === "GET" && url.pathname === "/sessions") {
      return json([...sessions.values()]);
    }

    const sessionIdMatch = url.pathname.match(/^\/sessions\/([^/]+)$/);
    if (sessionIdMatch) {
      if (method === "GET") {
        const s = sessions.get(sessionIdMatch[1]);
        return s ? json(s) : json({ error: "not_found" }, 404);
      }
      if (method === "DELETE") {
        const ok = killSession(sessionIdMatch[1]);
        return json({ ok }, ok ? 200 : 404);
      }
    }

    const paneMatch = url.pathname.match(/^\/sessions\/([^/]+)\/pane$/);
    if (paneMatch && method === "GET") {
      const s = sessions.get(paneMatch[1]);
      if (!s) return json({ error: "not_found" }, 404);
      return json({ ok: true, text: run("tmux", "capture-pane", "-t", s.tmux_window, "-p").out });
    }

    const transcriptMatch = url.pathname.match(/^\/sessions\/([^/]+)\/transcript$/);
    if (transcriptMatch && method === "GET") {
      const s = sessions.get(transcriptMatch[1]);
      if (!s) return json({ error: "not_found" }, 404);
      if (!s.transcript_path || !existsSync(s.transcript_path)) return json({ lines: [] });
      const lines = readFileSync(s.transcript_path, "utf-8").split("\n").slice(0, -1)
        .filter(l => l.trim())
        .map(l => { try { return JSON.parse(l); } catch { return null; } })
        .filter(Boolean);
      return json({ lines });
    }

    if (method === "POST" && url.pathname === "/sessions") {
      const body = (await req.json()) as CreateSessionOpts;
      const cwd = (body.cwd || "").trim().replace(/^~(?=\/|$)/, homedir());
      if (!cwd) return json({ error: "cwd required" }, 400);
      if (!existsSync(cwd)) {
        if (body.createDir) {
          try { mkdirSync(cwd, { recursive: true }); }
          catch (e) { return json({ error: "mkdir_failed", detail: String(e) }, 500); }
        } else {
          return json({ error: "dir_not_found", cwd }, 422);
        }
      }
      return json(await launchSession({ ...body, cwd }), 201);
    }

    if (method === "POST" && url.pathname === "/send") {
      const { text, session_id: sessId } = (await req.json()) as { text: string; session_id?: string };
      if (!text?.trim()) return json({ error: "empty" }, 400);
      const sess = sessId ? sessions.get(sessId) : undefined;
      if (!sess) return json({ error: "session_not_found" }, 404);

      const chat_id = String(nextChatId++);
      const trimmed = text.trim();
      addMessage({ role: "user", content: trimmed, source: "web", chat_id, session_id: sess.claude_session_id });
      const rs = relaySessions.get(sess.id);
      if (rs) {
        const st = getOrInitDeliveryState(sess.id, rs.relaySessionId);
        st.pending.push({ text: trimmed, source: 'web', at: Date.now() });
      }
      run("tmux", "send-keys", "-l", "-t", sess.tmux_window, trimmed.replace(/\n/g, " "));
      run("tmux", "send-keys", "-t", sess.tmux_window, "Enter");
      rs?.send(encodeUserMessage(trimmed));
      rs?.setThinking(true);
      // Restart transcript polling if first message triggers JSONL creation
      if (!transcriptWatchers.has(sess.id) && sess.status !== "ended") pollForTranscript(sess);
      return json({ ok: true, chat_id });
    }

    if (method === "GET" && url.pathname === "/status") {
      return json({ ok: true, messages: messages.length, sessions: sessions.size, clients: sseListeners.size });
    }

    return new Response("not found", { status: 404 });
  },
});

process.stderr.write(`webchat server running on http://0.0.0.0:${PORT}\n`);
recoverDirectSessions();

if (relayClient) {
  // Upsert this machine's metadata server-side so the app's path picker
  // can format ~/foo nicely. homeDir is the field we actually care about;
  // we send the rest because the schema requires them. Best-effort —
  // failures here only degrade the picker UX, not session correctness.
  void relayClient.getOrCreateMachine({
    host: hostname(),
    platform: osPlatform(),
    happyCliVersion: 'joy-tmux/0.1.0',
    homeDir: homedir(),
    happyHomeDir: join(homedir(), '.happy'),
    happyLibDir: import.meta.dir,
  }).then(ok => {
    process.stderr.write(`[relay] machine metadata upsert: ${ok ? 'ok' : 'failed'}\n`);
  });

  relayClient.registerRpcHandler('joy-list-sessions', async () => {
    return [...sessions.values()];
  });

  relayClient.registerRpcHandler('joy-create-session', async (params) => {
    const p = params as {
      cwd: string;
      createDir?: boolean;
      model?: string;
      effort?: string;
      yolo?: boolean;
      continue?: boolean;
      resume_id?: string;
    };
    if (!p.cwd?.trim()) return { error: 'cwd required' };
    try {
      const record = await launchSession({
        cwd: p.cwd.trim(),
        createDir: p.createDir,
        model: p.model,
        effort: p.effort,
        yolo: p.yolo,
        continue: p.continue,
        resume_id: p.resume_id,
      });
      // record.relay_session_id is populated synchronously now that
      // launchSession awaits createRelaySession.
      return { ok: true, session: record, relaySessionId: record.relay_session_id };
    } catch (e) {
      // Distinguish "user needs to confirm dir creation" from generic errors
      // so the app can surface a Modal.confirm rather than a flat error toast.
      if (e instanceof DirectoryCreationApprovalRequired) {
        return { requestToApproveDirectoryCreation: true, directory: e.directory };
      }
      return { error: String(e) };
    }
  });

  relayClient.registerRpcHandler('joy-kill-session', async (params) => {
    const { id } = params as { id: string };
    const ok = killSession(id);
    return { ok };
  });

  relayClient.registerRpcHandler('joy-pane', async (params) => {
    const { id } = params as { id: string };
    const sess = sessions.get(id);
    if (!sess) return { error: 'session_not_found' };
    const { out } = run("tmux", "capture-pane", "-p", "-t", sess.tmux_window);
    return { ok: true, text: out };
  });

  relayClient.registerRpcHandler('joy-send', async (params) => {
    const { text, session_id: sessId } = params as { text: string; session_id?: string };
    if (!text?.trim()) return { error: 'empty' };
    const sess = sessId ? sessions.get(sessId) : undefined;
    if (!sess) return { error: 'session_not_found' };
    const chat_id = String(nextChatId++);
    const trimmed = text.trim();
    addMessage({ role: "user", content: trimmed, source: "rpc", chat_id, session_id: sess.claude_session_id });
    const rs = relaySessions.get(sess.id);
    if (rs) {
      const st = getOrInitDeliveryState(sess.id, rs.relaySessionId);
      st.pending.push({ text: trimmed, source: 'rpc', at: Date.now() });
    }
    run("tmux", "send-keys", "-l", "-t", sess.tmux_window, trimmed.replace(/\n/g, " "));
    run("tmux", "send-keys", "-t", sess.tmux_window, "Enter");
    rs?.send(encodeUserMessage(trimmed));
    rs?.setThinking(true);
    if (!transcriptWatchers.has(sess.id) && sess.status !== "ended") pollForTranscript(sess);
    return { ok: true, chat_id };
  });
}

if (relayClient) {
  relayClient.onReconnect = () => {
    for (const [id, sess] of sessions) {
      if (sess.status !== "active" || relaySessions.has(id)) continue;
      process.stderr.write(`[relay] reconnect: creating session for orphaned ${id}\n`);
      createRelaySession(relayClient!, { tag: `joy-tmux-${id}`, cwd: sess.cwd, id }).then(rs => {
        process.stderr.write(`[relay] reconnect: ${id} → relay ${rs.relaySessionId}\n`);
        if (sess.status === "ended") { rs.stop(); return; } // M1: alive guard
        wireRelaySession({
          sessionId: id,
          tmuxWindow: sess.tmux_window,
          rs,
          sessionAlive: () => sess.status !== "ended",
          watcherActive: () => transcriptWatchers.has(id),
          startWatcher: () => pollForTranscript(sess),
        });
        rs.start();
        relaySessions.set(id, rs);
        sess.relay_session_id = rs.relaySessionId;
        broadcast("session_update", sess);
      }).catch(e => process.stderr.write(`[relay] reconnect failed for ${id}: ${e}\n`));
    }
  };
}
