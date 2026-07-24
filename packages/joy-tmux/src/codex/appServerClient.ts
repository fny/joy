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
import WebSocket from "ws";
import { joyStateDir } from "../paths";
import { resolveCodexExecutionPolicy, sandboxModeToPolicy } from "./executionPolicy";

export interface AppServerSpawnOpts {
  socketPath: string;
  /** Extra `-c key=value` config overrides. */
  config?: Record<string, string>;
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
  const args = ["app-server", "--listen", `unix://${opts.socketPath}`,
    "-c", "check_for_update_on_startup=false"];
  for (const [k, v] of Object.entries(opts.config ?? {})) { args.push("-c", `${k}=${v}`); }
  return spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
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

/** Fetch the codex model catalog via a short-lived app-server connection —
 *  for a machine-level picker before any session exists. */
export async function fetchCodexModels(bin?: string): Promise<CodexModel[]> {
  const socketPath = join(joyStateDir(), `codex-models-${process.pid}-${Date.now()}.sock`);
  const proc = spawnCodexAppServer({ socketPath, bin });
  proc.stderr?.on("data", () => {});
  const client = new CodexAppServerClient();
  try {
    // wait for bind, then connect with a few retries
    let connected = false;
    for (let i = 0; i < 25 && !connected; i++) {
      try { await client.connect(socketPath); connected = true; } catch { await new Promise((r) => setTimeout(r, 200)); }
    }
    if (!connected) throw new Error("model catalog: could not connect");
    return (await client.modelList()).filter((m) => !m.hidden);
  } finally {
    try { client.close(); } catch { /* ignore */ }
    try { proc.kill(); } catch { /* ignore */ }
  }
}

type Notification = { method: string; params?: Record<string, unknown> };
type ServerRequest = { id: number | string; method: string; params?: Record<string, unknown> };

/** Throw from an onServerRequest handler to reply with a JSON-RPC error instead
 *  of a result (e.g. -32601 for a request we can't answer). */
export class JsonRpcError extends Error {
  constructor(public readonly code: number, message: string) { super(message); }
}

export class CodexAppServerClient {
  #ws: WebSocket | null = null;
  #nextId = 1;
  #pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  #onNotification: (n: Notification) => void = () => {};
  #onServerRequest: (r: ServerRequest) => Promise<unknown> | unknown = () => ({});
  #closed = false;

  onNotification(cb: (n: Notification) => void): void { this.#onNotification = cb; }
  /** Handler for server→client requests (approvals/elicitations). Must return
   *  the JSON-RPC result; unhandled methods should return {} so the server
   *  doesn't hang. */
  onServerRequest(cb: (r: ServerRequest) => Promise<unknown> | unknown): void { this.#onServerRequest = cb; }

  /** Connect to the socket and complete the initialize handshake. */
  async connect(socketPath: string): Promise<Record<string, unknown>> {
    const ws = new WebSocket(`ws+unix://${socketPath}:/`, { perMessageDeflate: false });
    this.#ws = ws;
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", (e) => reject(e instanceof Error ? e : new Error(String(e))));
    });
    ws.on("message", (data) => this.#onMessage(data.toString()));
    ws.on("close", () => { this.#failAllPending(new Error("app-server socket closed")); });
    const result = await this.request("initialize", {
      clientInfo: { name: "joy-tmux", title: "Joy", version: "0.1.0" },
      // Explicit stable capabilities (review #9). We don't do attestation or
      // OpenAI-form elicitation, and stay off the experimental API.
      capabilities: { experimentalApi: false, requestAttestation: false, mcpServerOpenaiFormElicitation: false },
    }) as Record<string, unknown>;
    this.notify("initialized", {});
    return result;
  }

  #onMessage(line: string): void {
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(line); } catch { return; }
    // Response to one of our requests.
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const p = this.#pending.get(msg.id as number);
      if (!p) return;
      this.#pending.delete(msg.id as number);
      if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
      else p.resolve(msg.result);
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
    try {
      const result = await this.#onServerRequest(req);
      this.#send({ jsonrpc: "2.0", id: req.id, result });
    } catch (e) {
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
      // promise forever (review #9). turn/start can legitimately take a while
      // (the whole agent turn), so give it a generous window.
      const timeoutMs = method === "turn/start" || method === "turn/steer" ? 300_000 : 30_000;
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

  /** thread/resume → reattach to an existing thread. */
  async threadResume(threadId: string, opts: ThreadStartOpts): Promise<{ threadId: string }> {
    const policy = resolveCodexExecutionPolicy(opts.permissionMode);
    const params: Record<string, unknown> = {
      threadId, cwd: opts.cwd,
      approvalPolicy: policy.approvalPolicy,
      sandbox: policy.sandbox,
    };
    if (opts.developerInstructions) params.developerInstructions = opts.developerInstructions;
    const res = await this.request("thread/resume", params) as { thread?: { id?: string } };
    return { threadId: res.thread?.id ?? threadId };
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
    return { turnId: res.turn?.id ?? "" };
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
