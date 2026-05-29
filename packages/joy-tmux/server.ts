#!/usr/bin/env bun
import { readFileSync, existsSync, mkdirSync, watch, readdirSync, statSync } from "fs";
import { join, basename } from "path";
import { homedir } from "os";
import { initRelay, createRelaySession, encodeTurnStart, encodeTextEvent, encodeToolCallStart, encodeToolCallEnd, encodeTurnEnd, type RelaySession } from "./relay.ts";

const PORT = parseInt(process.env.PORT ?? "4997");
const TMUX_SESSION = process.env.TMUX_SESSION ?? "joy";
const PUBLIC_DIR = join(import.meta.dir, "public");

// ── Message store ─────────────────────────────────────────────────────────────
interface Message {
  id: string;
  role: "user" | "assistant" | "event";
  content: string;
  source: "web" | "cli";
  timestamp: number;
  chat_id?: string;
  session_id?: string;
  event_type?: string;
  event_status?: "info" | "success" | "error" | "warning";
}

const messages: Message[] = [];
let nextChatId = 1;
let nextMsgId = 1;

function addMessage(msg: Omit<Message, "id" | "timestamp">): Message {
  const full: Message = { ...msg, id: String(nextMsgId++), timestamp: Date.now() };
  messages.push(full);
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

const transcriptWatchers = new Map<string, { close: () => void; lineCount: number }>();
const directUserDedup = new Map<string, Set<string>>();
const turnStates = new Map<string, { turnId: string }>();

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

function pollForTranscript(sess: SessionRecord, attempts = 0) {
  if (transcriptWatchers.has(sess.id) || sess.status === "ended") return;
  const path = findLatestTranscript(cwdToTranscriptDir(sess.cwd), sess.started_at);
  if (path) { startTranscriptWatcher(sess, path); return; }
  if (attempts < 40) setTimeout(() => pollForTranscript(sess, attempts + 1), 500);
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

    const dedup = directUserDedup.get(sess.id);
    if (dedup?.has(content)) { dedup.delete(content); return; }
    addMessage({ role: "user", content, source: "cli", session_id: sid });

  } else if (role === "assistant") {
    const blocks = Array.isArray(content) ? content as Array<Record<string, unknown>> : [];
    const rs = relaySessions.get(sess.id);
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
  let lineCount = 0;

  function readNew() {
    try {
      const text = readFileSync(transcriptPath, "utf-8");
      const lines = text.split("\n").slice(0, -1);
      const newLines = lines.slice(lineCount);
      if (newLines.length === 0) return;
      lineCount += newLines.length;
      const w = transcriptWatchers.get(sess.id);
      if (w) w.lineCount = lineCount;
      for (const line of newLines) {
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
  transcriptWatchers.set(sess.id, { close: () => fsWatcher?.close(), lineCount });
}

function stopTranscriptWatcher(sessionId: string) {
  transcriptWatchers.get(sessionId)?.close();
  transcriptWatchers.delete(sessionId);
  directUserDedup.delete(sessionId);
  turnStates.delete(sessionId);
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
async function launchSession(opts: CreateSessionOpts): Promise<SessionRecord> {
  const id = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
  const windowName = `dd-${id}`;

  if (!run("tmux", "has-session", "-t", TMUX_SESSION).ok) {
    run("tmux", "new-session", "-d", "-s", TMUX_SESSION, "-c", opts.cwd);
  }

  const envParts: string[] = [];
  if (opts.effort && opts.effort !== "default") envParts.push(`CLAUDE_EFFORT=${opts.effort}`);

  const flags: string[] = [];
  if (opts.model) flags.push("--model", opts.model);
  if (opts.continue) flags.push("--continue");
  if (opts.resume_id) flags.push("--resume", opts.resume_id);
  if (opts.yolo) flags.push("--dangerously-skip-permissions");

  const cmd = [...envParts, "claude", ...flags].join(" ");
  run("tmux", "new-window", "-t", TMUX_SESSION, "-n", windowName, "-c", opts.cwd);
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
    cwd: opts.cwd,
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
    createRelaySession(relayClient, { tag: `joy-tmux-${id}`, cwd: opts.cwd }).then(rs => {
      rs.onMessage = (text) => {
        if (!directUserDedup.has(id)) directUserDedup.set(id, new Set());
        directUserDedup.get(id)!.add(text);
        run("tmux", "send-keys", "-l", "-t", record.tmux_window, text);
        run("tmux", "send-keys", "-t", record.tmux_window, "Enter");
        rs.setThinking(true);
        if (!transcriptWatchers.has(id) && record.status !== "ended") pollForTranscript(record);
      };
      rs.start();
      relaySessions.set(id, rs);
      record.relay_session_id = rs.relaySessionId;
      broadcast("session_update", record);
    }).catch(e => process.stderr.write(`[relay] failed to create session for ${id}: ${e}\n`));
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
    }
    process.stderr.write(`[recover] ${id} cwd=${cwd} alive=${isAlive} transcript=${transcriptPath}\n`);
  }
}

function killSession(id: string): boolean {
  const s = sessions.get(id);
  if (!s) return false;
  stopTranscriptWatcher(id);
  relaySessions.delete(id);
  run("tmux", "kill-window", "-t", s.tmux_window);
  s.status = "ended";
  s.end_reason = "killed";
  s.last_active_at = Date.now();
  broadcast("session_update", s);
  return true;
}

// ── HTTP server ───────────────────────────────────────────────────────────────
function extractTextFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return (content as Array<{ type: string; text?: string }>)
      .filter(b => b.type === "text" && b.text)
      .map(b => b.text!)
      .join("\n").trim();
  }
  return "";
}

Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",
  idleTimeout: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const method = req.method;

    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };
    if (method === "OPTIONS") return new Response(null, { headers: corsHeaders });

    const json = (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });

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
          enqueue(`event: history\ndata: ${JSON.stringify(messages)}\n\n`);
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
      addMessage({ role: "user", content: text.trim(), source: "web", chat_id, session_id: sess.claude_session_id });
      if (!directUserDedup.has(sess.id)) directUserDedup.set(sess.id, new Set());
      directUserDedup.get(sess.id)!.add(text.trim());
      run("tmux", "send-keys", "-l", "-t", sess.tmux_window, text.trim());
      run("tmux", "send-keys", "-t", sess.tmux_window, "Enter");
      relaySessions.get(sess.id)?.setThinking(true);
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
