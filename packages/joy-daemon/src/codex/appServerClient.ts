// Transport + JSON-RPC client for the codex app-server (0.144.x).
//
// The daemon spawns one `codex app-server` per session, listening on a per-
// session unix socket, and this client drives it over WebSocket JSON-RPC 2.0.
//
// TRANSPORT GOTCHA (verified 2026-07-24, doc verification item 3): the socket
// speaks WebSocket, but the app-server HANGS UP when the client advertises the
// `permessage-deflate` extension, which `ws` sends by default. So we dial with
// `ws+unix://<socketPath>:/` and `perMessageDeflate: false`. The http
// `socketPath` option is silently ignored by `ws` (it dials TCP), so the
// ws+unix scheme is mandatory.
//
// Stable schema only — no `experimentalApi`. Everything M1 needs (thread
// start/resume/read, turn start/steer/interrupt, item/turn notifications,
// clientUserMessageId receipts) is in the stable app-server schema.

import { spawn, type ChildProcess } from "child_process";
import { join } from "path";
import { rmSync, readFileSync } from "fs";
import WebSocket from "ws";
import { joyStateDir } from "../paths";
import { resolveCodexExecutionPolicy, sandboxModeToPolicy } from "./executionPolicy";

export interface AppServerSpawnOpts {
  socketPath: string;
  /** Extra `-c key=value` config overrides. */
  config?: Record<string, string>;
  /** joy session id — exported as JOY_SESSION_ID so tools can use the joy-img
   *  save-path convention. */
  joySessionId?: string;
  /** codex binary (default from JOY_CODEX_BIN env or "codex"). Pinning matters:
   *  clientUserMessageId receipts need codex ≥ ~0.144, and PATH can resolve a
   *  stale workspace copy under some launchers. */
  bin?: string;
}

/** Spawn `codex app-server` on a per-session unix socket. The caller owns the
 *  returned process (kill on teardown). `check_for_update_on_startup=false`
 *  keeps the update prompt from blocking startup. */
export function spawnCodexAppServer(opts: AppServerSpawnOpts): ChildProcess {
  const bin = opts.bin ?? process.env.JOY_CODEX_BIN ?? "codex";
  const env = opts.joySessionId ? { ...process.env, JOY_SESSION_ID: opts.joySessionId } : undefined;
  const args = ["app-server", "--listen", `unix://${opts.socketPath}`,
    "-c", "check_for_update_on_startup=false"];
  for (const [k, v] of Object.entries(opts.config ?? {})) { args.push("-c", `${k}=${v}`); }
  return spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], env });
}

export interface ThreadStartOpts {
  cwd: string;
  permissionMode?: string;
  model?: string;
  developerInstructions?: string;
}

export interface TurnStartOpts {
  clientUserMessageId?: string;
  permissionMode?: string;
  model?: string;
  effort?: string;
}

export interface CodexModel {
  id: string;
  model: string;
  displayName: string;
  hidden: boolean;
  isDefault: boolean;
  supportedReasoningEfforts: string[];
  defaultReasoningEffort: string | null;
}

/** Read the model catalog from codex's OWN on-disk cache
 *  (`$CODEX_HOME/models_cache.json`, refreshed by codex itself with an etag on
 *  every run). Instant — no app-server spawn — and carries everything the
 *  picker needs: slug, display name, default/supported reasoning levels,
 *  visibility ('list'/'hide') and priority (1 = top = the catalog default).
 *  Returns null when the file is missing/unreadable (fresh machine where codex
 *  never ran) so the caller can fall back to fetchCodexModels(). */
export function loadCodexModelsCacheFile(codexHome?: string): CodexModel[] | null {
  try {
    const home = codexHome ?? process.env.CODEX_HOME ?? join(process.env.HOME ?? "", ".codex");
    const raw = JSON.parse(readFileSync(join(home, "models_cache.json"), "utf8")) as {
      models?: Array<Record<string, unknown>>;
    };
    if (!Array.isArray(raw.models) || raw.models.length === 0) return null;
    const sorted = [...raw.models]
      .filter((m) => typeof m.slug === "string")
      .sort((a, b) => (Number(a.priority) || 999) - (Number(b.priority) || 999));
    let sawDefault = false;
    const out: CodexModel[] = [];
    for (const m of sorted) {
      const hidden = m.visibility !== "list";
      const isDefault = !hidden && !sawDefault;
      if (isDefault) sawDefault = true;
      out.push({
        id: String(m.slug),
        model: String(m.slug),
        displayName: typeof m.display_name === "string" ? m.display_name : String(m.slug),
        hidden,
        isDefault,
        supportedReasoningEfforts: Array.isArray(m.supported_reasoning_levels)
          ? (m.supported_reasoning_levels as Array<Record<string, unknown>>).map((l) => String(l.effort)).filter(Boolean)
          : [],
        defaultReasoningEffort: typeof m.default_reasoning_level === "string" ? m.default_reasoning_level : null,
      });
    }
    return out.length > 0 ? out : null;
  } catch { return null; }
}

/** Fetch the codex model catalog via a short-lived app-server connection —
 *  for a machine-level picker before any session exists. */
export async function fetchCodexModels(bin?: string, baseDir = joyStateDir()): Promise<CodexModel[]> {
  const socketPath = join(baseDir, `codex-models-${process.pid}-${Date.now()}.sock`);
  const proc = spawnCodexAppServer({ socketPath, bin });
  proc.stderr?.on("data", () => {});
  // A missing/unspawnable codex binary emits an ASYNC 'error' event; without a
  // listener that becomes an unhandled 'error' and CRASHES the daemon (finding
  // #8). Capture it and surface as a rejected connect instead.
  let spawnError: Error | null = null;
  proc.on("error", (e) => { spawnError = e instanceof Error ? e : new Error(String(e)); });
  const client = new CodexAppServerClient();
  try {
    // wait for bind, then connect with a few retries
    let connected = false;
    for (let i = 0; i < 25 && !connected; i++) {
      if (spawnError) throw spawnError;
      try { await client.connect(socketPath); connected = true; } catch { await new Promise((r) => setTimeout(r, 200)); }
    }
    if (!connected) throw spawnError ?? new Error("model catalog: could not connect");
    return (await client.modelList()).filter((m) => !m.hidden);
  } finally {
    try { client.close(); } catch { /* ignore */ }
    try { proc.kill(); } catch { /* ignore */ }
    try { rmSync(socketPath, { force: true }); } catch { /* ignore */ } // don't leak the socket file
  }
}

type Notification = { method: string; params?: Record<string, unknown> };
type ServerRequest = { id: number | string; method: string; params?: Record<string, unknown> };

/** Throw from an onServerRequest handler to reply with a JSON-RPC error instead
 *  of a result (e.g. -32601 for a request we can't answer). */
export class JsonRpcError extends Error {
  constructor(public readonly code: number, message: string) { super(message); }
}

/** Rejection type for a JSON-RPC ERROR RESPONSE to one of OUR requests — i.e.
 *  the server explicitly rejected the call (as opposed to a transport failure /
 *  timeout). Callers use this to distinguish "definitely not accepted, safe to
 *  requeue" from "ambiguous, might have landed" (finding #3d). */
export class JsonRpcResponseError extends Error {
  constructor(public readonly code: number, message: string) { super(message); }
}

export class CodexAppServerClient {
  #ws: WebSocket | null = null;
  #nextId = 1;
  #pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  #onNotification: (n: Notification) => void = () => {};
  #onServerRequest: (r: ServerRequest) => Promise<unknown> | unknown = () => ({});
  #onClose: () => void = () => {};
  // Server-request ids resolved EXTERNALLY (the attached TUI answered, or an
  // interrupt cleared it) — when the held handler later settles we must NOT
  // also send a response (finding #6). String-keyed to match notification ids.
  #externallyResolved = new Set<string>();
  #closed = false;

  onNotification(cb: (n: Notification) => void): void { this.#onNotification = cb; }
  /** Handler for server→client requests (approvals/elicitations). Must return
   *  the JSON-RPC result; unhandled methods should return {} so the server
   *  doesn't hang. */
  onServerRequest(cb: (r: ServerRequest) => Promise<unknown> | unknown): void { this.#onServerRequest = cb; }
  /** Fired when the underlying socket closes (server died / was killed). Lets a
   *  session react whether it SPAWNED the server or REJOINED an orphan (finding
   *  #7 — the rejoin path previously had no exit signal). */
  onClose(cb: () => void): void { this.#onClose = cb; }

  /** Mark an in-flight server→client request as resolved elsewhere. The held
   *  handler Promise should still be settled by the caller (to avoid a leak);
   *  this just suppresses the duplicate JSON-RPC response we'd otherwise send. */
  resolveServerRequestExternally(id: number | string): void { this.#externallyResolved.add(String(id)); }

  /** Connect to the socket and complete the initialize handshake, bounded by a
   *  deadline so a half-dead server that accepts the unix connection but never
   *  finishes the upgrade/initialize can't wedge startup forever (finding #7). */
  async connect(socketPath: string, deadlineMs = 10_000): Promise<Record<string, unknown>> {
    const ws = new WebSocket(`ws+unix://${socketPath}:/`, { perMessageDeflate: false });
    this.#ws = ws;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("app-server connect timed out")), deadlineMs); });
    try {
      await Promise.race([
        new Promise<void>((resolve, reject) => {
          ws.once("open", () => resolve());
          ws.once("error", (e) => reject(e instanceof Error ? e : new Error(String(e))));
        }),
        deadline,
      ]);
      // Fenced to THIS socket: a retry after a timed-out initialize made a
      // new connection, and when the abandoned first socket later closed its
      // handler failed the new one's requests and detached the healthy
      // session (#72).
      ws.on("message", (data) => { if (this.#ws === ws) this.#onMessage(data.toString()); });
      ws.on("close", () => {
        if (this.#ws !== ws) return;
        this.#failAllPending(new Error("app-server socket closed"));
        if (!this.#closed) { this.#closed = true; this.#onClose(); }
      });
      const result = await Promise.race([
        this.request("initialize", {
          clientInfo: { name: "joy-daemon", title: "Joy", version: "0.1.0" },
          // Explicit stable capabilities (review #9). We don't do attestation or
          // OpenAI-form elicitation, and stay off the experimental API.
          capabilities: { experimentalApi: false, requestAttestation: false, mcpServerOpenaiFormElicitation: false },
        }) as Promise<Record<string, unknown>>,
        deadline,
      ]);
      this.notify("initialized", {});
      this.#externallyResolved.clear(); // markers name the OLD connection's request ids (Astra on caf47165)
      this.#closed = false; // a successful connection is the only thing that reopens the client
      return result;
    } catch (e) {
      // Dispose what this attempt made: otherwise the socket lives on and its
      // late close tears down whatever connection replaced it (#72). Shared
      // pending requests are failed only when this attempt still owns #ws —
      // a concurrent successful connect keeps its own.
      if (this.#ws === ws) { this.#ws = null; this.#failAllPending(e instanceof Error ? e : new Error(String(e))); }
      try { ws.terminate(); } catch { /* never opened */ }
      throw e;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  #onMessage(line: string): void {
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(line); } catch { return; }
    // Response to one of our requests.
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const p = this.#pending.get(msg.id as number);
      if (!p) return;
      this.#pending.delete(msg.id as number);
      if (msg.error) {
        // A JSON-RPC ERROR RESPONSE = an EXPLICIT server rejection (distinct
        // from a transport failure/timeout). Reject with a typed error so the
        // caller can safely requeue rather than assume the request may have
        // landed (finding #3d).
        const err = msg.error as { code?: number; message?: string };
        p.reject(new JsonRpcResponseError(typeof err.code === "number" ? err.code : -32603, err.message ?? JSON.stringify(msg.error)));
      } else p.resolve(msg.result);
      return;
    }
    // Server→client request (has id AND method).
    if (msg.id !== undefined && typeof msg.method === "string") {
      void this.#handleServerRequest(msg as unknown as ServerRequest);
      return;
    }
    // Notification (method, no id).
    if (typeof msg.method === "string") {
      this.#onNotification({ method: msg.method, params: msg.params as Record<string, unknown> });
    }
  }

  async #handleServerRequest(req: ServerRequest): Promise<void> {
    const key = String(req.id);
    // The reply belongs to the socket that asked. A reconnect reuses request
    // ids, so a held approval answered after the connection was replaced
    // would answer the NEW server's request of the same id (Astra, #72).
    const asked = this.#ws;
    try {
      const result = await this.#onServerRequest(req);
      // The connection that asked is gone: touch NOTHING shared — the
      // replacement may be using the same request id (Astra, #72).
      if (this.#ws !== asked) return;
      // Suppress the response if the request was resolved externally while the
      // handler was held (the TUI answered it, or an interrupt cleared it) —
      // sending a second response for the same id is a protocol error (#6).
      if (this.#externallyResolved.delete(key)) return;
      this.#send({ jsonrpc: "2.0", id: req.id, result });
    } catch (e) {
      if (this.#ws !== asked) return;
      if (this.#externallyResolved.delete(key)) return;
      const code = e instanceof JsonRpcError ? e.code : -32603;
      const message = e instanceof Error ? e.message : String(e);
      this.#send({ jsonrpc: "2.0", id: req.id, error: { code, message } });
    }
  }

  request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      if (!this.#ws || this.#ws.readyState !== WebSocket.OPEN) { reject(new Error("app-server not connected")); return; }
      // Timeout so a dead server / unresolved request can't leak a pending
      // promise forever (review #9). NOTE (finding #4): turn/start returns
      // IMMEDIATELY with the new turn id — it does NOT block for the whole
      // agent turn (that streams via notifications). So it gets the normal
      // window, not a 5-minute one; only thread/read (full history backfill)
      // gets extra time.
      const timeoutMs = method === "thread/read" ? 120_000 : 30_000;
      const timer = setTimeout(() => {
        if (this.#pending.delete(id)) reject(new Error(`app-server request '${method}' timed out`));
      }, timeoutMs);
      this.#pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.#send({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: Record<string, unknown>): void {
    this.#send({ jsonrpc: "2.0", method, params });
  }

  #send(obj: Record<string, unknown>): void {
    if (this.#ws && this.#ws.readyState === WebSocket.OPEN) this.#ws.send(JSON.stringify(obj));
  }

  #failAllPending(err: Error): void {
    for (const p of this.#pending.values()) p.reject(err);
    this.#pending.clear();
  }

  // ── Typed method wrappers ──────────────────────────────────────────────────

  /** thread/start → { threadId, rolloutPath, model }. Uses `sandbox` (kebab
   *  string). Returns the effective top-level model the thread resolved to. */
  async threadStart(opts: ThreadStartOpts): Promise<{ threadId: string; rolloutPath: string | null; model: string | null }> {
    const policy = resolveCodexExecutionPolicy(opts.permissionMode);
    const params: Record<string, unknown> = {
      cwd: opts.cwd,
      approvalPolicy: policy.approvalPolicy,
      sandbox: policy.sandbox,
    };
    if (opts.model) params.model = opts.model;
    if (opts.developerInstructions) params.developerInstructions = opts.developerInstructions;
    const res = await this.request("thread/start", params) as { thread?: { id?: string; path?: string }; model?: string };
    const threadId = res.thread?.id;
    if (!threadId) throw new Error("thread/start returned no thread id");
    return { threadId, rolloutPath: res.thread?.path ?? null, model: res.model ?? null };
  }

  /** thread/resume → reattach to an existing thread. Returns the AUTHORITATIVE
   *  model + reasoning effort the resumed thread is configured with (finding
   *  #8) — the caller must trust these over any stale local settings. Rejects
   *  if the server returns no thread id (don't silently pretend we resumed the
   *  requested thread — finding #10). */
  async threadResume(threadId: string, opts: ThreadStartOpts): Promise<{ threadId: string; model: string | null; reasoningEffort: string | null }> {
    const policy = resolveCodexExecutionPolicy(opts.permissionMode);
    const params: Record<string, unknown> = {
      threadId, cwd: opts.cwd,
      approvalPolicy: policy.approvalPolicy,
      sandbox: policy.sandbox,
    };
    if (opts.developerInstructions) params.developerInstructions = opts.developerInstructions;
    const res = await this.request("thread/resume", params) as { thread?: { id?: string }; model?: string; reasoningEffort?: string };
    const id = res.thread?.id;
    if (!id) throw new Error("thread/resume returned no thread id");
    return { threadId: id, model: res.model ?? null, reasoningEffort: res.reasoningEffort ?? null };
  }

  /** thread/read → full history for reconciliation. */
  async threadRead(threadId: string): Promise<Record<string, unknown>> {
    return await this.request("thread/read", { threadId, includeTurns: true }) as Record<string, unknown>;
  }

  /** turn/start → deliver a user message. Uses `sandboxPolicy` (tagged object).
   *  Returns the codex turn id. */
  async turnStart(threadId: string, text: string, opts: TurnStartOpts): Promise<{ turnId: string }> {
    const policy = resolveCodexExecutionPolicy(opts.permissionMode);
    const params: Record<string, unknown> = {
      threadId,
      input: [{ type: "text", text }],
      approvalPolicy: policy.approvalPolicy,
      sandboxPolicy: sandboxModeToPolicy(policy.sandbox),
    };
    if (opts.clientUserMessageId) params.clientUserMessageId = opts.clientUserMessageId;
    if (opts.model) params.model = opts.model;
    if (opts.effort) params.effort = opts.effort;
    const res = await this.request("turn/start", params) as { turn?: { id?: string } };
    const turnId = res.turn?.id;
    // A missing turn id means we can't track/serialize this turn — treat it as a
    // failure rather than returning "" and pretending it started (finding #10).
    if (!turnId) throw new Error("turn/start returned no turn id");
    return { turnId };
  }

  /** turn/steer → inject into the active turn (stable in 0.144). */
  async turnSteer(threadId: string, turnId: string, text: string, clientUserMessageId?: string): Promise<void> {
    const params: Record<string, unknown> = { threadId, expectedTurnId: turnId, input: [{ type: "text", text }] };
    if (clientUserMessageId) params.clientUserMessageId = clientUserMessageId;
    await this.request("turn/steer", params);
  }

  /** turn/interrupt → stop the active turn. */
  async turnInterrupt(threadId: string, turnId: string): Promise<void> {
    await this.request("turn/interrupt", { threadId, turnId });
  }

  /** model/list → the model catalog (paged). Returns {id, model, displayName,
   *  supportedReasoningEfforts, defaultReasoningEffort, isDefault}. */
  async modelList(): Promise<CodexModel[]> {
    const out: CodexModel[] = [];
    let cursor: string | null | undefined = undefined;
    for (let page = 0; page < 20; page++) {
      const res = await this.request("model/list", { cursor: cursor ?? null }) as { data?: unknown[]; nextCursor?: string | null };
      for (const m of (res.data ?? [])) {
        const mm = m as Record<string, unknown>;
        if (typeof mm.model === "string") {
          out.push({
            id: typeof mm.id === "string" ? mm.id : mm.model,
            model: mm.model,
            displayName: typeof mm.displayName === "string" ? mm.displayName : mm.model,
            hidden: mm.hidden === true,
            isDefault: mm.isDefault === true,
            supportedReasoningEfforts: Array.isArray(mm.supportedReasoningEfforts)
              ? mm.supportedReasoningEfforts.map((e) => String((e as Record<string, unknown>).reasoningEffort)).filter(Boolean)
              : [],
            defaultReasoningEffort: typeof mm.defaultReasoningEffort === "string" ? mm.defaultReasoningEffort : null,
          });
        }
      }
      cursor = res.nextCursor;
      if (!cursor) break;
      if (page === 19 && cursor) process.stderr.write(`[codex] model/list truncated at 20 pages (${out.length} models) — more remain\n`);
    }
    return out;
  }

  close(): void {
    this.#closed = true;
    this.#failAllPending(new Error("client closed"));
    try { this.#ws?.close(); } catch { /* best effort */ }
    this.#ws = null;
  }

  get connected(): boolean { return !this.#closed && this.#ws?.readyState === WebSocket.OPEN; }
}
