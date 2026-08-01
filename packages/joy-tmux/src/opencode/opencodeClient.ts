// HTTP + SSE client for a per-session `opencode serve` (design:
// docs/plans/opencode-adapter-design.md). The daemon spawns one server per joy
// session with --port 0 (ephemeral localhost port, parsed from stdout), talks
// plain HTTP, and subscribes to the global SSE event stream.
//
// Operational gotchas encoded here (verified live 2026-08-01):
//  - the server process is named `opencode.exe` (compiled bun binary) — match
//    THAT for liveness checks, never the launch command string.
//  - runtime provider-SDK installs go through npm config; a poisoned ~/.npmrc
//    (dead token / ignore-scripts) breaks providers invisibly → spawn with a
//    clean NPM_CONFIG_USERCONFIG.
//  - turn failures can be logged server-side without landing an error on the
//    assistant message (the "Failed to drain Session" silent drop) — callers
//    must deadline "prompt admitted but no assistant activity".

import { spawn, type ChildProcess } from "child_process";
import { writeFileSync } from "fs";
import { join } from "path";
import { joyStateDir } from "../paths";
import * as http from "http";

export interface OpencodeSpawnResult {
  proc: ChildProcess;
  port: Promise<number>; // resolves when the server prints its listen line
}

/** Spawn `opencode serve --port 0` in `cwd`. Port is parsed from stdout
 *  ("opencode server listening on http://127.0.0.1:PORT"). */
export function spawnOpencodeServer(cwd: string, opts?: { bin?: string }): OpencodeSpawnResult {
  const bin = opts?.bin ?? process.env.JOY_OPENCODE_BIN ?? "opencode";
  // Clean npm userconfig so runtime provider installs can't be broken by a
  // poisoned ~/.npmrc; created once in the joy state dir.
  const cleanNpmrc = join(joyStateDir(), "opencode-clean-npmrc");
  try { writeFileSync(cleanNpmrc, "", { flag: "wx" }); } catch { /* exists */ }
  const proc = spawn(bin, ["serve", "--port", "0"], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NPM_CONFIG_USERCONFIG: cleanNpmrc },
  });
  const port = new Promise<number>((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error("opencode serve: no listen line within 30s")), 30_000);
    const onData = (d: Buffer) => {
      buf += d.toString();
      const m = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(buf);
      if (m) { clearTimeout(timer); proc.stdout?.off("data", onData); resolve(parseInt(m[1], 10)); }
    };
    proc.stdout?.on("data", onData);
    proc.stderr?.on("data", (d: Buffer) => { buf += d.toString(); onData(Buffer.alloc(0)); });
    proc.on("exit", (code) => { clearTimeout(timer); reject(new Error(`opencode serve exited during startup (code ${code})`)); });
    proc.on("error", (e) => { clearTimeout(timer); reject(e); });
  });
  return { proc, port };
}

/** One opencode SSE/global event. `durable.seq` is a per-session monotonic
 *  event sequence — the dedupe/ordering key. */
export interface OpencodeEvent {
  id?: string;
  type: string;
  durable?: { aggregateID?: string; seq?: number };
  data?: Record<string, unknown>;
}

export class OpencodeClient {
  readonly port: number;
  #sse: http.ClientRequest | null = null;
  #onEvent: (e: OpencodeEvent) => void = () => {};
  #closed = false;

  constructor(port: number) { this.port = port; }

  onEvent(cb: (e: OpencodeEvent) => void): void { this.#onEvent = cb; }

  async request<T = unknown>(method: string, path: string, body?: unknown, timeoutMs = 30_000): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const payload = body === undefined ? null : JSON.stringify(body);
      const req = http.request({
        host: "127.0.0.1", port: this.port, path, method,
        headers: payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {},
        timeout: timeoutMs,
      }, (res) => {
        let out = "";
        res.on("data", (d) => { out += d; });
        res.on("end", () => {
          if ((res.statusCode ?? 0) >= 400) { reject(new Error(`opencode ${method} ${path} → ${res.statusCode}: ${out.slice(0, 300)}`)); return; }
          try { resolve((out ? JSON.parse(out) : null) as T); } catch { resolve(out as unknown as T); }
        });
      });
      req.on("timeout", () => { req.destroy(new Error(`opencode ${method} ${path} timed out`)); });
      req.on("error", reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  /** Subscribe to the global SSE stream; auto-reconnects until close(). */
  subscribeEvents(): void {
    if (this.#closed) return;
    const req = http.request({ host: "127.0.0.1", port: this.port, path: "/api/event", method: "GET" }, (res) => {
      let buf = "";
      res.on("data", (d) => {
        buf += d.toString();
        let idx;
        while ((idx = buf.indexOf("\n")) >= 0) {
          let line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (line.startsWith("data:")) line = line.slice(5).trim();
          if (!line.startsWith("{")) continue;
          try {
            const ev = JSON.parse(line) as OpencodeEvent;
            (globalThis as { __ocTap?: (e: OpencodeEvent) => void }).__ocTap?.(ev);
            this.#onEvent(ev);
          } catch { /* partial/garbage line */ }
        }
      });
      res.on("end", () => this.#resubscribe());
      res.on("error", () => this.#resubscribe());
    });
    req.on("error", () => this.#resubscribe());
    req.end();
    this.#sse = req;
  }

  #resubscribe(): void {
    if (this.#closed) return;
    setTimeout(() => this.subscribeEvents(), 1000);
  }

  // ── typed helpers ──────────────────────────────────────────────────────────

  async health(): Promise<boolean> {
    try { await this.request("GET", "/api/health", undefined, 5_000); return true; } catch { return false; }
  }

  async createSession(): Promise<{ id: string }> {
    const r = await this.request<{ data: { id: string } }>("POST", "/api/session", {});
    if (!r?.data?.id) throw new Error("opencode session/create returned no id");
    return { id: r.data.id };
  }

  async listSessions(): Promise<Array<{ id: string; title?: string }>> {
    const r = await this.request<{ data: Array<{ id: string; title?: string }> }>("GET", "/api/session");
    return r?.data ?? [];
  }

  /** Send a prompt. `id` (msg_…) is our client-supplied correlation/idempotency
   *  key; delivery 'queue' uses opencode's native busy-queueing. */
  async prompt(sessionID: string, text: string, opts?: { id?: string; delivery?: "steer" | "queue" }): Promise<{ messageID: string; admittedSeq: number }> {
    const body: Record<string, unknown> = { prompt: { text } };
    if (opts?.id) body.id = opts.id;
    if (opts?.delivery) body.delivery = opts.delivery;
    const r = await this.request<{ data: { id: string; admittedSeq: number } }>("POST", `/api/session/${sessionID}/prompt`, body);
    return { messageID: r?.data?.id ?? "", admittedSeq: r?.data?.admittedSeq ?? -1 };
  }

  /** Blocks until the session goes idle (turn finished). Right after a prompt
   *  is admitted the wait service can answer 503 "not available yet" — that is
   *  NOT turn completion/failure, so retry it inside the deadline. */
  async wait(sessionID: string, timeoutMs = 600_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        await this.request("POST", `/api/session/${sessionID}/wait`, {}, Math.max(1_000, deadline - Date.now()));
        return;
      } catch (e) {
        if (String(e).includes("503") && Date.now() + 2_000 < deadline) {
          await new Promise((r) => setTimeout(r, 1_500));
          continue;
        }
        throw e;
      }
    }
  }

  async interrupt(sessionID: string): Promise<void> {
    await this.request("POST", `/api/session/${sessionID}/interrupt`, {});
  }

  async switchModel(sessionID: string, providerID: string, modelID: string): Promise<void> {
    await this.request("POST", `/api/session/${sessionID}/model`, { model: { id: modelID, providerID } });
  }

  /** Full message history: [{id, type: 'user'|'assistant'|…, content: parts,
   *  model, finish, error, time}] — part ids (textID/callID) are STABLE and
   *  identical to the live event ids, so reconcile localIds match. */
  async messages(sessionID: string): Promise<Array<Record<string, unknown>>> {
    const r = await this.request<{ data: Array<Record<string, unknown>> }>("GET", `/api/session/${sessionID}/message`, undefined, 60_000);
    return r?.data ?? [];
  }

  close(): void {
    this.#closed = true;
    try { this.#sse?.destroy(); } catch { /* ignore */ }
  }
}

/** Is `pid` verifiably an opencode server? (process name is `opencode.exe`). */
export function isOpencodeServerPid(pid: number): boolean {
  try {
    const { readFileSync } = require("fs") as typeof import("fs");
    const comm = readFileSync(`/proc/${pid}/comm`, "utf8").trim();
    return comm.includes("opencode");
  } catch { return false; }
}
