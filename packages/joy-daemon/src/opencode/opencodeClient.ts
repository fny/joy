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

import { spawn, execFileSync, type ChildProcess } from "child_process";
import { readFileSync, readdirSync } from "node:fs";
import { writeFileSync } from "fs";
import { join } from "path";
import { joyStateDir } from "../paths";
import * as http from "http";

// Provider API keys (e.g. FIREWORKS_API_KEY for the opencode config's
// {env:...} interpolation) typically live in the user's shell rc, which a
// daemon started by systemd never sources. Claude sessions get them for free
// (tmux runs interactive shells); opencode servers are spawned directly, so
// capture the user's interactive-shell environment once per daemon lifetime
// and overlay it. Changing shell env requires a daemon restart to be seen.
let userShellEnvCache: Record<string, string> | null = null;
export function userShellEnv(): Record<string, string> {
  if (userShellEnvCache) return userShellEnvCache;
  try {
    const shell = process.env.SHELL || "/bin/bash";
    const out = execFileSync(shell, ["-ic", "env -0"], { timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] });
    const env: Record<string, string> = {};
    for (const entry of out.toString().split("\0")) {
      const eq = entry.indexOf("=");
      if (eq > 0) env[entry.slice(0, eq)] = entry.slice(eq + 1);
    }
    userShellEnvCache = env;
  } catch {
    userShellEnvCache = {}; // shell probe failed — daemon env only
  }
  return userShellEnvCache;
}

export interface OpencodeSpawnResult {
  proc: ChildProcess;
  port: Promise<number>; // resolves when the server prints its listen line
}

/** Spawn `opencode serve --port 0` in `cwd`. Port is parsed from stdout
 *  ("opencode server listening on http://127.0.0.1:PORT"). */
export function spawnOpencodeServer(cwd: string, opts?: { bin?: string; joySessionId?: string }): OpencodeSpawnResult {
  const bin = opts?.bin ?? process.env.JOY_OPENCODE_BIN ?? "opencode";
  // Clean npm userconfig so runtime provider installs can't be broken by a
  // poisoned ~/.npmrc; created once in the joy state dir.
  const cleanNpmrc = join(joyStateDir(), "opencode-clean-npmrc");
  try { writeFileSync(cleanNpmrc, "", { flag: "wx" }); } catch { /* exists */ }
  // detached: the `opencode` bin is a launcher that spawns the real
  // `opencode.exe` server as a child — killing just the launcher orphans the
  // server (observed live 2026-08-01). Detached makes the launcher a process-
  // group leader so killOpencodeServer can take the whole group down.
  const proc = spawn(bin, ["serve", "--port", "0"], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
    env: {
      ...userShellEnv(), ...process.env, NPM_CONFIG_USERCONFIG: cleanNpmrc,
      // joy-img save-path convention (tools inherit the server env).
      ...(opts?.joySessionId ? { JOY_SESSION_ID: opts.joySessionId } : {}),
    },
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
        let ended = false;
        res.on("data", (d) => { out += d; });
        res.on("end", () => {
          ended = true;
          if ((res.statusCode ?? 0) >= 400) { reject(new Error(`opencode ${method} ${path} → ${res.statusCode}: ${out.slice(0, 300)}`)); return; }
          try { resolve((out ? JSON.parse(out) : null) as T); } catch { resolve(out as unknown as T); }
        });
        // Headers arrived, then the socket died mid-body: neither 'end' nor
        // the request timeout fires, and the caller hung forever (#73).
        res.on("error", (e) => reject(new Error(`opencode ${method} ${path} response error: ${e.message}`)));
        res.on("aborted", () => reject(new Error(`opencode ${method} ${path} response aborted`)));
        res.on("close", () => { if (!ended) reject(new Error(`opencode ${method} ${path} response truncated`)); });
      });
      // One absolute deadline for the WHOLE exchange, not just the idle gap.
      const hard = setTimeout(() => req.destroy(new Error(`opencode ${method} ${path} exceeded ${timeoutMs}ms`)), timeoutMs);
      req.on("close", () => clearTimeout(hard));
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

/** Kill an opencode server (launcher + real opencode.exe child): group kill
 *  first (spawned detached → launcher is group leader), plain kill fallback
 *  for pre-detached records. VERIFIED: a stray from a failed TERM was found
 *  alive a day later (2026-08-03), so escalate to SIGKILL if the group is
 *  still up after a grace period, and log the escalation. */
export async function killOpencodeServerPid(pid: number): Promise<void> {
  const alive = (p: number): boolean => { try { process.kill(p, 0); return true; } catch { return false; } };
  const groupKill = (sig: NodeJS.Signals): boolean => {
    try { process.kill(-pid, sig); return true; } catch { /* not a group leader */ }
    try { process.kill(pid, sig); return true; } catch { return false; /* gone */ }
  };
  /** Members of the launcher's process group still alive (the server child may
   *  outlive a launcher that honoured TERM). */
  const survivors = (): number[] => {
    const out: number[] = [];
    try {
      for (const d of readdirSync("/proc")) {
        if (!/^\d+$/.test(d)) continue;
        const stat = readFileSync(`/proc/${d}/stat`, "utf8");
        const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        if (Number(fields[2]) === pid) out.push(Number(d)); // pgrp == launcher pid
      }
    } catch { /* /proc unavailable */ }
    if (alive(pid) && !out.includes(pid)) out.push(pid);
    return out;
  };
  if (!groupKill("SIGTERM")) return;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 20 && survivors().length; i++) await sleep(100); // ≤2s grace
  let left = survivors();
  if (left.length) {
    process.stderr.write(`[opencode] server group ${pid} survived SIGTERM (${left.join(",")}) — escalating to SIGKILL\n`);
    groupKill("SIGKILL");
    for (const p of left) { try { process.kill(p, "SIGKILL"); } catch { /* gone */ } }
    for (let i = 0; i < 20 && survivors().length; i++) await sleep(100);
    left = survivors();
    if (left.length) process.stderr.write(`[opencode] server group ${pid}: ${left.join(",")} still alive after SIGKILL\n`);
  }
}

/** Is `pid` verifiably an opencode server? (process name is `opencode.exe`). */
export function isOpencodeServerPid(pid: number): boolean {
  // `require` does not exist in the daemon's ESM runtime: this always threw,
  // always returned false, and recovery never reaped the recorded server —
  // a second one was started for the same conversation (#71).
  try {
    const comm = readFileSync(`/proc/${pid}/comm`, "utf8").trim();
    if (!comm.includes("opencode")) return false;
    // A recycled pid could be an interactive opencode: the server we spawned
    // runs `opencode serve --port 0` (Astra, #71).
    const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
    return cmdline.includes("serve");
  } catch { return false; }
}

/** List opencode sessions recorded for `cwd`, newest first — via a short-lived
 *  server (the CLI's `session list` omits location, so it can't filter by
 *  directory; the HTTP API can). Cost ≈ one server boot (~2-4s), acceptable
 *  for an on-demand picker. */
export async function listOpencodeSessionsForCwd(cwd: string): Promise<Array<{ id: string; title: string; updatedAt: number }>> {
  const { proc, port } = spawnOpencodeServer(cwd);
  try {
    const p = await port;
    const client = new OpencodeClient(p);
    const r = await client.request<{ data?: Array<Record<string, unknown>> }>("GET", "/api/session", undefined, 15_000);
    const out: Array<{ id: string; title: string; updatedAt: number }> = [];
    for (const s of r?.data ?? []) {
      const dir = String((s.location as Record<string, unknown> | undefined)?.directory ?? "");
      if (dir !== cwd) continue;
      const t = s.time as Record<string, unknown> | undefined;
      out.push({
        id: String(s.id ?? ""),
        title: String(s.title ?? ""),
        updatedAt: Number(t?.updated ?? t?.created ?? 0),
      });
    }
    out.sort((a, b) => b.updatedAt - a.updatedAt);
    return out;
  } finally {
    if (proc.pid) killOpencodeServerPid(proc.pid);
  }
}
