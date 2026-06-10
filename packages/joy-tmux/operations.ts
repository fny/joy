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

import type { Session } from "./session";
import type { SessionRegistry } from "./registry";
import type { RelaySession } from "./relay.ts";
import {
  handleBash,
  handleReadFile,
  handleWriteFile,
  handleListDirectory,
  handleGetDirectoryTree,
  handleRipgrep,
  handleDifftastic,
} from "./fileOps";
import { computeUsage, periodToRange } from "./usage";
import { existsSync } from "fs";
import { basename } from "path";
import { hostname, platform, release, arch } from "os";

export type HttpMethod = "GET" | "POST" | "DELETE";

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
      const file = Bun.file(path);
      const MAX = 25 * 1024 * 1024;
      if (file.size > MAX) {
        return { error: `transcript is ${Math.round(file.size / 1048576)}MB (cap 25MB) — copy it from ${path}` };
      }
      const contentBase64 = Buffer.from(await file.arrayBuffer()).toString("base64");
      return { ok: true, filename: basename(path), size: file.size, contentBase64 };
    },
  },
  {
    name: "codeburn",
    scope: "machine",
    rpcName: "joy-codeburn",
    http: { method: "GET", path: "/codeburn" },
    // Usage report computed by our own usage.ts straight from the transcript
    // JSONL (cost/tokens, daily, per-project/model/tool/MCP). If the codeburn
    // binary happens to be installed, its activity/skill/subagent panels are
    // merged in as optional extras — the backbone has no dependency.
    // period: today | week | 30days (default) | 90days | 6months.
    handler: async (_registry, params) => {
      const period = typeof params.period === "string" ? params.period : "30days";
      const range = periodToRange(period);
      const { sessions: _sessions, ...data } = await computeUsage({ fromDay: range.fromDay, toDay: range.toDay });
      const extras = await runCodeburnExtras(period);
      return { ok: true, period: range.label, ...data, ...(extras ?? {}) };
    },
  },
  {
    name: "codeburnSessions",
    scope: "machine",
    rpcName: "joy-codeburn-sessions",
    http: { method: "GET", path: "/codeburn/sessions" },
    // Per-session cost rows from usage.ts (keyed by claude session id, with
    // subagent burn rolled into the parent and a per-model breakdown).
    // period like joy-codeburn plus "all"; claudeSessionId returns just that
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

// codeburn extras: ONLY when the binary is installed (never bunx — that
// would silently download and run unpinned code). The own-module backbone
// covers everything else; these panels (activity classification, one-shot
// rates, skills) are codeburn heuristics we don't replicate.
const extrasCache = new Map<string, { at: number; data: Record<string, unknown> | null }>();
const EXTRAS_CACHE_TTL_MS = 60_000;

function daysAgoISO(days: number): string {
  const d = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

async function runCodeburnExtras(period: string): Promise<Record<string, unknown> | null> {
  const bin = Bun.which("codeburn");
  if (!bin) return null;

  const key = `extras:${period}`;
  const hit = extrasCache.get(key);
  if (hit && Date.now() - hit.at < EXTRAS_CACHE_TTL_MS) return hit.data;

  const periodArgs =
    period === "today" ? ["-p", "today"]
    : period === "week" ? ["-p", "week"]
    : period === "90days" ? ["--from", daysAgoISO(89)]
    : period === "6months" ? ["--from", daysAgoISO(182)]
    : ["-p", "30days"];

  let data: Record<string, unknown> | null = null;
  try {
    const proc = Bun.spawn([bin, "report", "--format", "json", ...periodArgs], { stdout: "pipe", stderr: "pipe" });
    const killTimer = setTimeout(() => proc.kill(), 60_000);
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    clearTimeout(killTimer);
    if (proc.exitCode === 0) {
      const full = JSON.parse(out) as Record<string, unknown>;
      const top = (k: string, n: number) => (Array.isArray(full[k]) ? (full[k] as unknown[]).slice(0, n) : []);
      data = {
        activities: top("activities", 13),
        skills: top("skills", 10),
        subagents: top("subagents", 10),
      };
    }
  } catch {
    data = null; // extras are strictly optional — never fail the report
  }
  extrasCache.set(key, { at: Date.now(), data });
  return data;
}

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
    handler: (session) => {
      // Idempotent: the op is bound to an existing session, so killing one
      // that already ended still reports success (matches the app's
      // archive flow, which treats success=false as "CLI unreachable" and
      // falls back to a server-side archive it doesn't need here).
      session.end("killed");
      return { success: true, message: "killed" };
    },
  },
  {
    name: "bash",
    scope: "session",
    rpcName: "bash",
    http: { method: "POST", path: "/sessions/:id/bash" },
    handler: (session, params) => handleBash(session.cwd, params as Parameters<typeof handleBash>[1]),
  },
  {
    name: "readFile",
    scope: "session",
    rpcName: "readFile",
    http: { method: "POST", path: "/sessions/:id/readFile" },
    handler: (session, params) => handleReadFile(session.cwd, params as Parameters<typeof handleReadFile>[1]),
  },
  {
    name: "writeFile",
    scope: "session",
    rpcName: "writeFile",
    http: { method: "POST", path: "/sessions/:id/writeFile" },
    handler: (session, params) => handleWriteFile(session.cwd, params as Parameters<typeof handleWriteFile>[1]),
  },
  {
    name: "listDirectory",
    scope: "session",
    rpcName: "listDirectory",
    http: { method: "POST", path: "/sessions/:id/listDirectory" },
    handler: (session, params) => handleListDirectory(session.cwd, params as Parameters<typeof handleListDirectory>[1]),
  },
  {
    name: "getDirectoryTree",
    scope: "session",
    rpcName: "getDirectoryTree",
    http: { method: "POST", path: "/sessions/:id/getDirectoryTree" },
    handler: (session, params) => handleGetDirectoryTree(session.cwd, params as Parameters<typeof handleGetDirectoryTree>[1]),
  },
  {
    name: "ripgrep",
    scope: "session",
    rpcName: "ripgrep",
    http: { method: "POST", path: "/sessions/:id/ripgrep" },
    handler: (session, params) => handleRipgrep(session.cwd, params as Parameters<typeof handleRipgrep>[1]),
  },
  {
    name: "difftastic",
    scope: "session",
    rpcName: "difftastic",
    http: { method: "POST", path: "/sessions/:id/difftastic" },
    handler: (session, params) => handleDifftastic(session.cwd, params as Parameters<typeof handleDifftastic>[1]),
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
