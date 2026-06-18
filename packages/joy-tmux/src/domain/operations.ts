// The operation catalog: every operation joy-tmux exposes, defined exactly
// once with its routing metadata for both transports. Transports derive their
// wiring from this table, so the HTTP debug surface and the relay RPC surface
// can never drift apart — adding an op here makes it reachable everywhere.
//
//   machine scope → ctx is the SessionRegistry (registered once per daemon,
//                   RPC name prefixed joy-*)
//   session scope → ctx is a resolved Session (registered per relay session
//                   by Session.attachRelay via bindSessionOps)
//
// Handlers return the RPC-shaped result (the frozen app contract). HTTP
// routes reuse the same result; the few legacy HTTP divergences (create's
// unwrapped 201, kill's 404) are expressed via the optional httpShape.

import type { Session } from "../claude/session";
import type { SessionRegistry } from "./registry";
import type { RelaySession } from "../relay/relay.ts";
import {
  handleBash,
  handleReadFile,
  handleWriteFile,
  handleListDirectory,
  handleGetDirectoryTree,
  handleRipgrep,
  handleDifftastic,
} from "./fileOps";
import { computeUsage, periodToRange } from "../claude/usage";
import { existsSync, statSync } from "fs";
import { readFile } from "fs/promises";
import { basename } from "path";
import { hostname, platform, release, arch } from "os";
import { spawn } from "child_process";

export type HttpMethod = "GET" | "POST" | "DELETE";

/**
 * Re-exec the daemon: spawn a detached replacement that waits for this process
 * to release port 4997, then exit. There's no supervisor, so the daemon restarts
 * itself. Claude runs under tmux (not as our child), so live sessions survive and
 * are re-adopted by the new daemon's recover().
 */
function scheduleDaemonRestart(): void {
  setTimeout(() => {
    try {
      // Reconstruct however this process was launched (node + any loader flags
      // like `--import tsx` + the script path) so the replacement runs the same way.
      const argv = [process.execPath, ...process.execArgv, ...process.argv.slice(1)];
      const cmd = argv.map(a => `'${a.replace(/'/g, "'\\''")}'`).join(" ");
      spawn("sh", ["-c", `sleep 1; exec ${cmd}`], {
        detached: true,
        stdio: "ignore",
        cwd: process.cwd(),
      }).unref();
    } catch { /* fall through to exit */ }
    process.exit(0);
  }, 300);
}

export interface OpMeta {
  /** Which transport invoked the op — send() maps this to the chat-log source. */
  via: "http" | "rpc";
}

export interface MachineOp {
  name: string;
  scope: "machine";
  rpcName: string;
  http: { method: HttpMethod; path: string };
  handler: (registry: SessionRegistry, params: Record<string, unknown>, meta: OpMeta) => Promise<unknown> | unknown;
  /** Optional HTTP-specific status/body mapping for legacy contract divergences. */
  httpShape?: (result: unknown) => { status: number; body: unknown };
}

export interface SessionOp {
  name: string;
  scope: "session";
  rpcName: string;
  /** null → no dedicated HTTP route (killSession is covered by DELETE /sessions/:id). */
  http: { method: HttpMethod; path: string } | null;
  handler: (session: Session, params: Record<string, unknown>) => Promise<unknown> | unknown;
}

export type Op = MachineOp | SessionOp;

// ── Machine-scoped operations ───────────────────────────────────────────────

export const machineOps: MachineOp[] = [
  {
    name: "list",
    scope: "machine",
    rpcName: "joy-list-sessions",
    http: { method: "GET", path: "/sessions" },
    handler: (registry) => registry.list().map(s => s.toJSON()),
  },
  {
    name: "get",
    scope: "machine",
    rpcName: "joy-get-session",
    http: { method: "GET", path: "/sessions/:id" },
    handler: (registry, params) => {
      const session = registry.get(String(params.id ?? ""));
      return session ? session.toJSON() : { error: "session_not_found" };
    },
    httpShape: (result) =>
      (result as { error?: string }).error
        ? { status: 404, body: result }
        : { status: 200, body: result },
  },
  {
    name: "create",
    scope: "machine",
    rpcName: "joy-create-session",
    http: { method: "POST", path: "/sessions" },
    // Throws DirectoryCreationApprovalRequired when cwd is missing and
    // createDir isn't set — each transport maps the sentinel to its contract
    // (RPC: requestToApproveDirectoryCreation, HTTP: 422).
    handler: async (registry, params) => {
      const cwd = typeof params.cwd === "string" ? params.cwd.trim() : "";
      if (!cwd) return { error: "cwd required" };
      const session = await registry.create({
        cwd,
        createDir: params.createDir === true,
        model: typeof params.model === "string" ? params.model : undefined,
        effort: typeof params.effort === "string" ? params.effort : undefined,
        yolo: typeof params.yolo === "boolean" ? params.yolo : undefined,
        continue: params.continue === true,
        resume_id: typeof params.resume_id === "string" ? params.resume_id : undefined,
        resumeLimitMb: typeof params.resume_limit_mb === "number" ? params.resume_limit_mb : undefined,
        permissionMode: typeof params.permissionMode === "string" ? params.permissionMode : undefined,
        fallbackModel: typeof params.fallbackModel === "string" ? params.fallbackModel : undefined,
        forkSession: params.forkSession === true,
        chrome: params.chrome === true,
        extraArgs: typeof params.extraArgs === "string" ? params.extraArgs : undefined,
      });
      return { ok: true, session: session.toJSON(), relaySessionId: session.relaySessionId };
    },
    // Legacy HTTP contract: 201 with the unwrapped SessionRecord.
    httpShape: (result) => {
      const r = result as { ok?: boolean; session?: unknown; error?: string };
      if (r.ok) return { status: 201, body: r.session };
      if (r.error === "cwd required") return { status: 400, body: { error: "cwd required" } };
      return { status: 500, body: result };
    },
  },
  {
    name: "restart",
    scope: "machine",
    rpcName: "joy-restart-session",
    http: { method: "POST", path: "/sessions/:id/restart" },
    // Kills the window and starts a fresh claude in the same cwd resuming
    // the same conversation (--resume, or --continue when the claude session
    // id was never learned). Returns the NEW session — the app should
    // navigate to the returned relaySessionId.
    handler: async (registry, params) => {
      const session = await registry.restart({
        id: String(params.id ?? ""),
        cwd: typeof params.cwd === "string" ? params.cwd : undefined,
      });
      return { ok: true, session: session.toJSON(), relaySessionId: session.relaySessionId };
    },
  },
  {
    name: "kill",
    scope: "machine",
    rpcName: "joy-kill-session",
    http: { method: "DELETE", path: "/sessions/:id" },
    handler: (registry, params) => {
      const session = registry.get(String(params.id ?? ""));
      return { ok: session ? session.end("killed") || session.status === "ended" : false };
    },
    httpShape: (result) => {
      const ok = (result as { ok: boolean }).ok;
      return { status: ok ? 200 : 404, body: result };
    },
  },
  {
    name: "killAll",
    scope: "machine",
    rpcName: "joy-kill-all-sessions",
    http: { method: "POST", path: "/sessions/kill-all" },
    // Kill every session's tmux window (active AND detached) and archive them.
    handler: (registry) => ({ ok: true, killed: registry.killAll() }),
  },
  {
    name: "restartDaemon",
    scope: "machine",
    rpcName: "joy-restart-daemon",
    http: { method: "POST", path: "/daemon/restart" },
    // Re-exec the daemon. Running Claude sessions live in tmux and survive;
    // recover() re-adopts them. Responds first, then restarts shortly after.
    handler: () => { scheduleDaemonRestart(); return { ok: true }; },
  },
  {
    name: "notify",
    scope: "machine",
    rpcName: "joy-notify",
    http: { method: "POST", path: "/notify" },
    // Push a notification to the user's devices, via the daemon's authed relay.
    handler: async (registry, params) => {
      const title = typeof params.title === "string" && params.title.trim() ? params.title.trim() : "Joy";
      const body = typeof params.body === "string" ? params.body : "";
      if (!registry.relayClient) return { ok: false, error: "relay disabled" };
      try {
        const { sent } = await registry.relayClient.sendPush(title, body);
        return { ok: true, sent };
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    },
  },
  {
    name: "send",
    scope: "machine",
    rpcName: "joy-send",
    http: { method: "POST", path: "/send" },
    handler: (registry, params, meta) => {
      const text = typeof params.text === "string" ? params.text : "";
      if (!text.trim()) return { error: "empty" };
      const session = params.session_id ? registry.get(String(params.session_id)) : undefined;
      if (!session) return { error: "session_not_found" };
      const trimmed = text.trim();
      const source = meta.via === "http" ? "web" as const : "rpc" as const;
      const chat_id = registry.nextChatId();
      registry.addChatMessage({ role: "user", content: trimmed, source, chat_id, session_id: session.claudeSessionId });
      // mirrorToRelay so the app's chat history shows the message even though
      // it didn't originate from the relay.
      session.sendText(trimmed, { source, mirrorToRelay: true });
      return { ok: true, chat_id };
    },
    httpShape: (result) => {
      const r = result as { error?: string };
      if (r.error === "empty") return { status: 400, body: result };
      if (r.error === "session_not_found") return { status: 404, body: result };
      return { status: 200, body: result };
    },
  },
  // ── Message queue ───────────────────────────────────────────────────────────
  // Messages line up while Claude is busy and stay editable until the daemon
  // dispatches one (see Session queue). All target a session by session_id.
  {
    name: "queueList",
    scope: "machine",
    rpcName: "joy-queue-list",
    http: { method: "GET", path: "/sessions/:id/queue" },
    handler: (registry, params) => {
      const session = registry.get(String(params.id ?? params.session_id ?? ""));
      if (!session) return { error: "session_not_found" };
      return { ok: true, ...session.queueState() };
    },
    httpShape: (result) =>
      (result as { error?: string }).error ? { status: 404, body: result } : { status: 200, body: result },
  },
  {
    name: "queueAdd",
    scope: "machine",
    rpcName: "joy-queue-add",
    http: { method: "POST", path: "/sessions/:id/queue" },
    handler: (registry, params) => {
      const session = registry.get(String(params.id ?? params.session_id ?? ""));
      if (!session) return { error: "session_not_found" };
      const text = typeof params.text === "string" ? params.text.trim() : "";
      if (!text) return { error: "empty" };
      const msg = session.enqueue(text);
      return { ok: true, id: msg.id, ...session.queueState() };
    },
    httpShape: (result) => {
      const r = result as { error?: string };
      if (r.error === "empty") return { status: 400, body: result };
      if (r.error === "session_not_found") return { status: 404, body: result };
      return { status: 200, body: result };
    },
  },
  {
    name: "queueEdit",
    scope: "machine",
    rpcName: "joy-queue-edit",
    http: { method: "POST", path: "/sessions/:id/queue/:qid" },
    handler: (registry, params) => {
      const session = registry.get(String(params.id ?? params.session_id ?? ""));
      if (!session) return { error: "session_not_found" };
      const text = typeof params.text === "string" ? params.text.trim() : "";
      if (!text) return { error: "empty" };
      const ok = session.editQueued(String(params.qid ?? params.queue_id ?? ""), text);
      return { ok, ...session.queueState() };
    },
  },
  {
    name: "queueCancel",
    scope: "machine",
    rpcName: "joy-queue-cancel",
    http: { method: "DELETE", path: "/sessions/:id/queue/:qid" },
    handler: (registry, params) => {
      const session = registry.get(String(params.id ?? params.session_id ?? ""));
      if (!session) return { error: "session_not_found" };
      const ok = session.cancelQueued(String(params.qid ?? params.queue_id ?? ""));
      return { ok, ...session.queueState() };
    },
  },
  {
    name: "queueReorder",
    scope: "machine",
    rpcName: "joy-queue-reorder",
    http: { method: "POST", path: "/sessions/:id/queue/:qid/move" },
    handler: (registry, params) => {
      const session = registry.get(String(params.id ?? params.session_id ?? ""));
      if (!session) return { error: "session_not_found" };
      const ok = session.reorderQueued(String(params.qid ?? params.queue_id ?? ""), Number(params.toIndex ?? params.to ?? 0));
      return { ok, ...session.queueState() };
    },
  },
  {
    name: "queueResume",
    scope: "machine",
    rpcName: "joy-queue-resume",
    http: { method: "POST", path: "/sessions/:id/queue/resume" },
    handler: (registry, params) => {
      const session = registry.get(String(params.id ?? params.session_id ?? ""));
      if (!session) return { error: "session_not_found" };
      session.resumeQueue();
      return { ok: true, ...session.queueState() };
    },
  },
  {
    name: "sendKeys",
    scope: "machine",
    rpcName: "joy-send-keys",
    http: { method: "POST", path: "/sessions/:id/keys" },
    // Raw keyboard intervention: bracketed key tokens (git commit<Enter><C-c>;
    // see keyTokens.ts for the dialect table). Unlike send, nothing is
    // buffered, mirrored to the relay, or recorded — it's a direct wire to
    // the pane for trust prompts, TUI menus, or unsticking claude.
    handler: (registry, params) => {
      const session = registry.get(String(params.id ?? ""));
      if (!session) return { error: "session_not_found" };
      const script = typeof params.script === "string" ? params.script : "";
      if (!script) return { error: "empty" };
      // literal: send the string verbatim (no bracketed-token parsing).
      return session.sendRawKeys(script, { literal: params.literal === true });
    },
    httpShape: (result) => {
      const r = result as { error?: string };
      if (r.error === "session_not_found") return { status: 404, body: result };
      if (r.error === "empty") return { status: 400, body: result };
      return { status: 200, body: result };
    },
  },
  {
    name: "setMode",
    scope: "machine",
    rpcName: "joy-set-mode",
    http: { method: "POST", path: "/sessions/:id/mode" },
    // Absolute permission-mode set: detects the current mode from the pane
    // footer, walks Shift+Tab to the target, verifies the footer afterwards.
    handler: async (registry, params) => {
      const session = registry.get(String(params.id ?? ""));
      if (!session) return { error: "session_not_found" };
      const mode = typeof params.mode === "string" ? params.mode : "";
      if (!mode) return { error: "mode required" };
      return session.setPermissionMode(mode);
    },
    httpShape: (result) => {
      const r = result as { error?: string };
      if (r.error === "session_not_found") return { status: 404, body: result };
      return { status: 200, body: result };
    },
  },
  {
    name: "pane",
    scope: "machine",
    rpcName: "joy-pane",
    http: { method: "GET", path: "/sessions/:id/pane" },
    handler: (registry, params) => {
      const session = registry.get(String(params.id ?? ""));
      if (!session) return { error: "session_not_found" };
      // color=true → capture with ANSI escape sequences (HTTP: ?color=1).
      return session.pane(params.color === true || params.color === "1" || params.color === "true");
    },
    httpShape: (result) =>
      (result as { error?: string }).error
        ? { status: 404, body: result }
        : { status: 200, body: result },
  },
  {
    name: "resize",
    scope: "machine",
    rpcName: "joy-resize",
    http: { method: "POST", path: "/sessions/:id/resize" },
    // Set the pane's column/row size. The viewing client calls this on
    // connect and when its width changes — last connector drives the width.
    handler: (registry, params) => {
      const session = registry.get(String(params.id ?? ""));
      if (!session) return { error: "session_not_found" };
      const cols = Number(params.cols);
      const rows = Number(params.rows);
      if (!Number.isFinite(cols) || !Number.isFinite(rows)) return { error: "cols and rows required" };
      return session.resize(cols, rows);
    },
    httpShape: (result) => {
      const r = result as { error?: string };
      if (r.error === "session_not_found") return { status: 404, body: result };
      if (r.error) return { status: 400, body: result };
      return { status: 200, body: result };
    },
  },
  {
    name: "transcript",
    scope: "machine",
    rpcName: "joy-transcript",
    http: { method: "GET", path: "/sessions/:id/transcript" },
    handler: (registry, params) => {
      const session = registry.get(String(params.id ?? ""));
      if (!session) return { error: "session_not_found" };
      return session.transcript();
    },
    httpShape: (result) =>
      (result as { error?: string }).error
        ? { status: 404, body: result }
        : { status: 200, body: result },
  },
  {
    name: "status",
    scope: "machine",
    rpcName: "joy-status",
    http: { method: "GET", path: "/status" },
    handler: (registry) => ({
      ok: true,
      messages: registry.chatHistory().length,
      sessions: registry.size,
      clients: registry.sseClientCount,
      version: "joy-tmux/0.1.0",
      uptimeMs: Date.now() - registry.startedAt,
      claude: registry.claudeInfo(),
      pid: process.pid,
      os: { platform: platform(), release: release(), arch: arch(), hostname: hostname() },
    }),
  },
  {
    name: "sessionLog",
    scope: "machine",
    rpcName: "joy-session-log",
    http: { method: "GET", path: "/sessions/:id/log" },
    // Ship the session's transcript JSONL so the app can offer it as a
    // download. Base64 inside the encrypted RPC envelope — capped so a
    // monster transcript doesn't wedge the socket.
    handler: async (registry, params) => {
      const session = registry.get(String(params.id ?? ""));
      if (!session) return { error: "session_not_found" };
      const path = session.transcriptPath;
      if (!path || !existsSync(path)) return { error: "no transcript on disk yet" };
      const size = statSync(path).size;
      const MAX = 25 * 1024 * 1024;
      if (size > MAX) {
        return { error: `transcript is ${Math.round(size / 1048576)}MB (cap 25MB) — copy it from ${path}` };
      }
      const contentBase64 = (await readFile(path)).toString("base64");
      return { ok: true, filename: basename(path), size, contentBase64 };
    },
  },
  {
    name: "usage",
    scope: "machine",
    rpcName: "joy-usage",
    http: { method: "GET", path: "/usage" },
    // Usage report computed by usage.ts straight from the transcript JSONL:
    // cost/tokens, daily, per-project/model/tool/MCP.
    // period: today | week | 30days (default) | 90days | 6months.
    handler: async (_registry, params) => {
      const period = typeof params.period === "string" ? params.period : "30days";
      const range = periodToRange(period);
      const { sessions: _sessions, ...data } = await computeUsage({ fromDay: range.fromDay, toDay: range.toDay });
      return { ok: true, period: range.label, ...data };
    },
  },
  {
    name: "sessionUsage",
    scope: "machine",
    rpcName: "joy-session-usage",
    http: { method: "GET", path: "/usage/sessions" },
    // Per-session cost rows from usage.ts (keyed by claude session id, with
    // subagent burn rolled into the parent and a per-model breakdown).
    // period like joy-usage plus "all"; claudeSessionId returns just that
    // conversation's row.
    handler: async (_registry, params) => {
      const period = typeof params.period === "string" ? params.period : "30days";
      const range = periodToRange(period);
      const { sessions } = await computeUsage({ fromDay: range.fromDay, toDay: range.toDay });
      const claudeSessionId = typeof params.claudeSessionId === "string" ? params.claudeSessionId : undefined;
      if (claudeSessionId) {
        return { ok: true, entry: sessions.find((s) => s.id === claudeSessionId) ?? null };
      }
      return { ok: true, sessions: sessions.slice(0, 20) };
    },
  },
];

// ── Session-scoped operations ───────────────────────────────────────────────
// Registered on each session's RelaySession under the bare rpcName (the relay
// prefixes them with the relay session id). HTTP paths nest under the session.

export const sessionOps: SessionOp[] = [
  {
    name: "abort",
    scope: "session",
    rpcName: "abort",
    http: { method: "POST", path: "/sessions/:id/abort" },
    handler: (session) => session.abort(),
  },
  {
    name: "killSession",
    scope: "session",
    rpcName: "killSession",
    http: null, // covered by DELETE /sessions/:id
    handler: async (session) => {
      // Idempotent: the op is bound to an existing session, so killing one
      // that already ended still reports success (matches the app's
      // archive flow, which treats success=false as "CLI unreachable" and
      // falls back to a server-side archive).
      session.end("killed");
      // Await the (retrying) archive POST and report its real result: a genuine
      // failure now surfaces success:false so the app runs its fallback archive
      // instead of leaving the killed session in the active list.
      const archived = await session.awaitArchive();
      return archived
        ? { success: true, message: "killed" }
        : { success: false, error: "archive failed" };
    },
  },
  {
    name: "bash",
    scope: "session",
    rpcName: "bash",
    http: { method: "POST", path: "/sessions/:id/bash" },
    handler: (session, params) => handleBash(session.cwd, params as unknown as Parameters<typeof handleBash>[1]),
  },
  {
    name: "readFile",
    scope: "session",
    rpcName: "readFile",
    http: { method: "POST", path: "/sessions/:id/readFile" },
    handler: (session, params) => handleReadFile(session.cwd, params as unknown as Parameters<typeof handleReadFile>[1]),
  },
  {
    name: "writeFile",
    scope: "session",
    rpcName: "writeFile",
    http: { method: "POST", path: "/sessions/:id/writeFile" },
    handler: (session, params) => handleWriteFile(session.cwd, params as unknown as Parameters<typeof handleWriteFile>[1]),
  },
  {
    name: "listDirectory",
    scope: "session",
    rpcName: "listDirectory",
    http: { method: "POST", path: "/sessions/:id/listDirectory" },
    handler: (session, params) => handleListDirectory(session.cwd, params as unknown as Parameters<typeof handleListDirectory>[1]),
  },
  {
    name: "getDirectoryTree",
    scope: "session",
    rpcName: "getDirectoryTree",
    http: { method: "POST", path: "/sessions/:id/getDirectoryTree" },
    handler: (session, params) => handleGetDirectoryTree(session.cwd, params as unknown as Parameters<typeof handleGetDirectoryTree>[1]),
  },
  {
    name: "ripgrep",
    scope: "session",
    rpcName: "ripgrep",
    http: { method: "POST", path: "/sessions/:id/ripgrep" },
    handler: (session, params) => handleRipgrep(session.cwd, params as unknown as Parameters<typeof handleRipgrep>[1]),
  },
  {
    name: "difftastic",
    scope: "session",
    rpcName: "difftastic",
    http: { method: "POST", path: "/sessions/:id/difftastic" },
    handler: (session, params) => handleDifftastic(session.cwd, params as unknown as Parameters<typeof handleDifftastic>[1]),
  },
];

/**
 * Register every session-scoped op on a freshly-attached relay session,
 * binding `session` as the handler ctx. Wired into the registry as the
 * onRelayAttached hook (server.ts), so launch/recover/reconnect all get the
 * identical op surface.
 */
export function bindSessionOps(session: Session, rs: RelaySession): void {
  for (const op of sessionOps) {
    rs.registerRpc(op.rpcName, async (params) => op.handler(session, (params ?? {}) as Record<string, unknown>));
  }
}
