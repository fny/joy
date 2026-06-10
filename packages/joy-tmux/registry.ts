// SessionRegistry: the single owner of all Session instances plus the
// machine-level concerns that span sessions — creating them (tmux window +
// claude spawn + relay attach), recovering them after a joy-tmux restart,
// re-attaching relays after a socket reconnect, and fanning out events to
// the debug page (SSE + bounded chat log).

import { existsSync, mkdirSync, statSync } from "fs";
import { join, basename } from "path";
import { homedir } from "os";
import { run } from "./shell";
import { createRelaySession, type RelayClient, type RelaySession } from "./relay.ts";
import { Session, type ChatMessage, type SessionDeps } from "./session";
import { cwdToTranscriptDir, findLatestTranscript } from "./transcript";

export interface CreateSessionOpts {
  cwd: string;
  model?: string;
  effort?: string;
  continue?: boolean;
  resume_id?: string;
  createDir?: boolean;
  yolo?: boolean;
}

/**
 * Thrown by create() when opts.cwd doesn't exist and createDir isn't set.
 * Transports translate it: the relay RPC returns
 * { requestToApproveDirectoryCreation: true, directory } so the app shows a
 * Modal.confirm; HTTP returns 422.
 */
export class DirectoryCreationApprovalRequired extends Error {
  constructor(public readonly directory: string) {
    super(`directory does not exist: ${directory}`);
  }
}

/**
 * Expand a leading ~ to the joy-tmux user's home directory. tmux's -c flag
 * does NOT expand tildes (it's not a shell), and the app may send paths with
 * ~ unresolved. Without this, tmux silently falls back to the daemon's own
 * cwd and Claude opens in the wrong directory.
 */
export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

interface StoredChatMessage extends ChatMessage {
  id: string;
  timestamp: number;
}

const MAX_MESSAGES = 500;

export class SessionRegistry {
  readonly tmuxSession: string;
  readonly relayClient: RelayClient | null;
  /** Daemon boot time — exposed via the status op as uptime. */
  readonly startedAt = Date.now();
  #claudeInfo: { available: boolean; version: string | null } | null = null;
  #sessions = new Map<string, Session>();
  #sseListeners = new Set<(data: string) => void>();
  #messages: StoredChatMessage[] = [];
  #nextChatId = 1;
  #nextMsgId = 1;
  #onRelayAttached?: SessionDeps["onRelayAttached"];

  constructor(opts: {
    tmuxSession: string;
    relayClient: RelayClient | null;
    /** Hook for transports to register session-scoped ops on a fresh relay session. */
    onRelayAttached?: SessionDeps["onRelayAttached"];
  }) {
    this.tmuxSession = opts.tmuxSession;
    this.relayClient = opts.relayClient;
    this.#onRelayAttached = opts.onRelayAttached;
  }

  /**
   * Is the claude CLI on this machine, and which version? Detected once on
   * first ask (spawning `claude --version` costs ~100ms) and cached for the
   * daemon's lifetime — the binary doesn't move while we're running.
   */
  claudeInfo(): { available: boolean; version: string | null } {
    if (!this.#claudeInfo) {
      const r = run("claude", "--version");
      this.#claudeInfo = r.ok
        ? { available: true, version: r.out.split("\n")[0].trim() || null }
        : { available: false, version: null };
    }
    return this.#claudeInfo;
  }

  // ── Lookup ──────────────────────────────────────────────────────────────────

  get(id: string): Session | undefined {
    return this.#sessions.get(id);
  }

  list(): Session[] {
    return [...this.#sessions.values()];
  }

  get size(): number {
    return this.#sessions.size;
  }

  // ── Event fan-out (debug page SSE + bounded chat log) ───────────────────────

  broadcast(event: string, data: unknown): void {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const emit of this.#sseListeners) emit(payload);
  }

  addChatMessage(msg: ChatMessage): StoredChatMessage {
    const full: StoredChatMessage = { ...msg, id: String(this.#nextMsgId++), timestamp: Date.now() };
    this.#messages.push(full);
    if (this.#messages.length > MAX_MESSAGES) this.#messages.splice(0, this.#messages.length - MAX_MESSAGES);
    this.broadcast("message", full);
    return full;
  }

  nextChatId(): string {
    return String(this.#nextChatId++);
  }

  chatHistory(): StoredChatMessage[] {
    return this.#messages.slice(-MAX_MESSAGES);
  }

  get sseClientCount(): number {
    return this.#sseListeners.size;
  }

  /** Subscribe an SSE client; returns the unsubscribe function. */
  subscribeSse(emit: (data: string) => void): () => void {
    this.#sseListeners.add(emit);
    return () => this.#sseListeners.delete(emit);
  }

  #sessionDeps(): SessionDeps {
    return {
      relayClient: this.relayClient,
      broadcast: (event, data) => this.broadcast(event, data),
      addChatMessage: (msg) => this.addChatMessage(msg),
      onRelayAttached: this.#onRelayAttached,
    };
  }

  // ── Create ──────────────────────────────────────────────────────────────────

  async create(opts: CreateSessionOpts): Promise<Session> {
    const id = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
    const windowName = `dd-${id}`;

    // Resolve ~, then verify the directory exists. tmux -c silently falls
    // back to the daemon's cwd when the directory is missing, which cascades
    // into the transcript watcher looking in the wrong projects/ folder and
    // Claude's responses never reaching the app.
    const cwd = expandHome(opts.cwd);
    if (!existsSync(cwd)) {
      if (opts.createDir) {
        mkdirSync(cwd, { recursive: true });
      } else {
        throw new DirectoryCreationApprovalRequired(cwd);
      }
    }

    if (!run("tmux", "has-session", "-t", this.tmuxSession).ok) {
      run("tmux", "new-session", "-d", "-s", this.tmuxSession, "-c", cwd);
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

    const tmuxWindow = `${this.tmuxSession}:${windowName}`;
    const cmd = [...envParts, "claude", ...flags].join(" ");
    run("tmux", "new-window", "-t", this.tmuxSession, "-n", windowName, "-c", cwd);
    run("tmux", "send-keys", "-t", tmuxWindow, cmd, "Enter");

    // Kick off the relay session creation NOW so its network round-trips
    // overlap the 1.2s of PID-discovery sleeps below instead of running
    // after them — shaves ~1s off every create as seen from the app.
    const relayPromise = this.relayClient
      ? createRelaySession(this.relayClient, { tag: `joy-tmux-${id}`, cwd, id })
      : null;

    await Bun.sleep(400);
    const shellPid = parseInt(
      run("tmux", "display-message", "-t", tmuxWindow, "-p", "#{pane_pid}").out,
    );
    await Bun.sleep(800);
    let pid: number | undefined;
    if (!isNaN(shellPid)) {
      const child = parseInt(run("pgrep", "-P", String(shellPid)).out.split("\n")[0]);
      pid = isNaN(child) ? shellPid : child;
    }

    const session = new Session({
      id, pid, tmuxWindow, cwd,
      model: opts.model,
      effort: opts.effort,
      flags,
      status: "starting",
      startedAt: Date.now(),
    }, this.#sessionDeps());

    this.#sessions.set(id, session);
    this.broadcast("session_update", session.toJSON());
    session.beginWatching();

    if (relayPromise) {
      try {
        const rs = await relayPromise;
        session.attachRelay(rs); // no-ops (and stops rs) if kill raced the create
      } catch (e) {
        process.stderr.write(`[relay] failed to create session for ${id}: ${e}\n`);
      }
    }

    return session;
  }

  // ── Recovery (joy-tmux restart with live tmux windows) ──────────────────────

  recover(): void {
    const result = run("tmux", "list-windows", "-t", this.tmuxSession, "-F", "#{window_name}");
    if (!result.ok) return;

    for (const winName of result.out.split("\n").map(l => l.trim()).filter(Boolean)) {
      if (!/^dd-[0-9a-f]{8}$/.test(winName)) continue;
      const id = winName.slice(3);
      if (this.#sessions.has(id)) continue;

      const tmuxWindow = `${this.tmuxSession}:${winName}`;
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

      const session = new Session({
        id, pid, tmuxWindow, cwd,
        flags: [],
        status: isAlive ? "active" : "ended",
        startedAt: transcriptPath ? statSync(transcriptPath).mtimeMs : Date.now(),
        claudeSessionId,
        transcriptPath: transcriptPath ?? undefined,
      }, this.#sessionDeps());

      this.#sessions.set(id, session);
      if (isAlive) {
        if (transcriptPath) session.startTailer(transcriptPath);
        session.beginWatching();
        this.#attachRelayAsync(session);
      }
      process.stderr.write(`[recover] ${id} cwd=${cwd} alive=${isAlive} transcript=${transcriptPath}\n`);
    }
  }

  /** Re-attach relay sessions orphaned by a socket reconnect. */
  onRelayReconnect(): void {
    for (const session of this.#sessions.values()) {
      if (session.status !== "active" || session.relayAttached) continue;
      process.stderr.write(`[relay] reconnect: creating session for orphaned ${session.id}\n`);
      this.#attachRelayAsync(session);
    }
  }

  #attachRelayAsync(session: Session): void {
    if (!this.relayClient) return;
    createRelaySession(this.relayClient, { tag: `joy-tmux-${session.id}`, cwd: session.cwd, id: session.id })
      .then(rs => {
        process.stderr.write(`[relay] session ${session.id} → relay ${rs.relaySessionId}\n`);
        session.attachRelay(rs);
      })
      .catch(e => process.stderr.write(`[relay] failed to create session for ${session.id}: ${e}\n`));
  }
}
