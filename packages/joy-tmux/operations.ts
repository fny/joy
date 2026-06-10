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
      return session.sendRawKeys(script);
    },
    httpShape: (result) => {
      const r = result as { error?: string };
      if (r.error === "session_not_found") return { status: 404, body: result };
      if (r.error === "empty") return { status: 400, body: result };
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
      return session.pane();
    },
    httpShape: (result) =>
      (result as { error?: string }).error
        ? { status: 404, body: result }
        : { status: 200, body: result },
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
    }),
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
