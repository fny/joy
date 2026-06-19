// SessionRegistry: the single owner of all Session instances plus the
// machine-level concerns that span sessions — creating them (tmux window +
// claude spawn + relay attach), recovering them after a joy-tmux restart,
// re-attaching relays after a socket reconnect, and fanning out events to
// the debug page (SSE + bounded chat log).

import { setTimeout as sleep } from "timers/promises";
import { existsSync, mkdirSync, statSync } from "fs";
import { join, basename, resolve } from "path";
import { homedir } from "os";
import { run } from "../tmux/shell";
import { createRelaySession, type RelayClient, type RelaySession } from "../relay/relay.ts";
import { Session, type ChatMessage, type SessionDeps } from "../claude/session";
import { cwdToTranscriptDir, findLatestTranscript, cappedTailOffset } from "../claude/transcript";
import { loadWindowRecord, saveWindowRecord } from "./windowRecord";
import { optionsPromptArg } from "../claude/optionsPrompt";

export interface CreateSessionOpts {
  cwd: string;
  /** Reuse a specific joy session id (and thus the same relay tag/card) instead
   *  of minting a fresh one — used when restarting a daemon-forgotten session so
   *  it reattaches to its existing app card rather than spawning a duplicate. */
  id?: string;
  model?: string;
  effort?: string;
  continue?: boolean;
  resume_id?: string;
  /** Cap the --resume history backfill to ~this many MB (snapped to a turn). Default 2; 0 = full. */
  resumeLimitMb?: number;
  createDir?: boolean;
  yolo?: boolean;
  /**
   * One of claude's --permission-mode choices. 'bypassPermissions' maps to
   * --dangerously-skip-permissions instead (interactive claude treats them
   * the same but the bypass flag skips the startup confirmation). When set,
   * this wins over `yolo`.
   */
  permissionMode?: string;
  /** --fallback-model: model to fall back to when the primary is overloaded. */
  fallbackModel?: string;
  /** --fork-session: new session id when resuming. Ignored without continue/resume_id. */
  forkSession?: boolean;
  /** --chrome: Claude in Chrome integration. */
  chrome?: boolean;
  /** Raw extra CLI arguments appended verbatim to the claude command line. */
  extraArgs?: string;
  /** Create the session detached: make the tmux window + relay (so file/git/diff
   *  RPCs work on the cwd) but DON'T launch Claude. Lands as joy__state='detached'
   *  (red). Starting it later (create/restart for the same cwd) launches Claude. */
  detached?: boolean;
}

const PERMISSION_MODES = new Set([
  "acceptEdits", "auto", "bypassPermissions", "default", "dontAsk", "plan",
]);

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
   * Is the claude CLI on this machine, and which version? Spawning
   * `claude --version` costs ~100ms, so we cache it — but ONLY a successful
   * detection. A transient miss (e.g. an incomplete PATH during a detached
   * `joy start` boot) must not stick "not found" for the daemon's whole life,
   * so we re-probe on every call until claude resolves.
   */
  claudeInfo(): { available: boolean; version: string | null } {
    if (this.#claudeInfo?.available) return this.#claudeInfo;
    const r = run("claude", "--version");
    this.#claudeInfo = r.ok
      ? { available: true, version: r.out.split("\n")[0].trim() || null }
      : { available: false, version: null };
    return this.#claudeInfo;
  }

  // ── Lookup ──────────────────────────────────────────────────────────────────

  get(id: string): Session | undefined {
    return this.#sessions.get(id);
  }

  // Killed sessions are kept in #sessions (recovery/dedup bookkeeping) but should
  // not count as live: exclude them from the listing/count the debug surfaces use,
  // else the machine page's "Active Sessions" inflates with every kill until the
  // next daemon restart. Detached (process_exited) sessions remain listed — their
  // window/cwd is still around and their file/git RPCs still answer.
  #isKilled(s: Session): boolean {
    return s.status === "ended" && s.endReason === "killed";
  }

  list(): Session[] {
    return [...this.#sessions.values()].filter(s => !this.#isKilled(s));
  }

  get size(): number {
    return this.list().length;
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
    const id = opts.id ?? crypto.randomUUID().replace(/-/g, "").slice(0, 8);
    const windowName = `j-${id}`;

    // Resolve ~, then verify the directory exists. tmux -c silently falls
    // back to the daemon's cwd when the directory is missing, which cascades
    // into the transcript watcher looking in the wrong projects/ folder and
    // Claude's responses never reaching the app.
    const cwd = expandHome(opts.cwd);

    // One session per directory. Two Claude sessions in the same cwd collide on
    // the same transcript (both resolve to the latest .jsonl there), so we never
    // run two at once: a live session in this cwd is returned as-is; a detached
    // one (Claude dead, window still around) is restarted in place.
    const target = resolve(cwd);
    for (const s of this.#sessions.values()) {
      if (resolve(s.cwd) !== target) continue;
      if (s.status === "starting" || s.status === "active") {
        process.stderr.write(`[create] ${s.id} already live in ${target} — returning existing\n`);
        return s;
      }
      if (s.status === "ended" && s.endReason === "process_exited") {
        process.stderr.write(`[create] ${s.id} detached in ${target} — restarting in place\n`);
        return this.restart({ id: s.id });
      }
    }

    if (!existsSync(cwd)) {
      if (opts.createDir) {
        mkdirSync(cwd, { recursive: true });
      } else {
        throw new DirectoryCreationApprovalRequired(cwd);
      }
    }

    if (!run("tmux", "has-session", "-t", this.tmuxSession).ok) {
      run("tmux", "new-session", "-d", "-s", this.tmuxSession, "-c", cwd);
      // When a real terminal attaches, let it drive the window size (tmux's
      // default `latest` behavior). The app's resize-window flips windows to
      // `manual`; this hook hands control back on attach so the most recent
      // connector — app or terminal — owns the width.
      run("tmux", "set-hook", "-t", this.tmuxSession, "client-attached", "setw window-size latest");
    }

    // Validate user-supplied fields to prevent shell injection via send-keys
    const SAFE_ID = /^[a-zA-Z0-9:._/-]{1,128}$/;
    const SAFE_EFFORT = /^[a-z]{1,32}$/;
    if (opts.model && !SAFE_ID.test(opts.model)) throw new Error("invalid model");
    if (opts.fallbackModel && !SAFE_ID.test(opts.fallbackModel)) throw new Error("invalid fallbackModel");
    if (opts.resume_id && !SAFE_ID.test(opts.resume_id)) throw new Error("invalid resume_id");
    // Resume target must actually exist — Claude stores one transcript per
    // session id under the cwd's project dir. Validate up front so a bad id
    // surfaces as a clear "session not found" instead of Claude exiting and the
    // session limping into a detached state.
    if (opts.resume_id && !existsSync(join(cwdToTranscriptDir(cwd), `${opts.resume_id}.jsonl`))) {
      throw new Error(`Session "${opts.resume_id}" not found in ${cwd}`);
    }
    // Don't resume a conversation that's ALREADY running — Claude locks a session
    // id while live, so a second `claude --resume <id>` would collide/fork. Report
    // it clearly instead. (restart() force-kills the old session before reaching
    // here, so it won't trip this.)
    if (opts.resume_id) {
      for (const s of this.#sessions.values()) {
        if ((s.status === "active" || s.status === "starting") && s.claudeSessionId === opts.resume_id) {
          throw new Error(`Session "${opts.resume_id}" is already running in ${s.cwd} (window ${s.id})`);
        }
      }
    }
    if (opts.effort && !SAFE_EFFORT.test(opts.effort)) throw new Error("invalid effort");
    if (opts.permissionMode && !PERMISSION_MODES.has(opts.permissionMode)) throw new Error("invalid permissionMode");
    // extraArgs is appended to the shell line verbatim (the caller may need
    // quoting, e.g. --allowedTools "Bash(git:*)"), so only control characters
    // are rejected — a newline would submit the command early via send-keys.
    // Authenticated callers can already type anything via joy-send-keys, so
    // this isn't a security boundary, just an integrity check.
    if (opts.extraArgs && /[\x00-\x1f\x7f]/.test(opts.extraArgs)) throw new Error("invalid extraArgs");

    const envParts: string[] = [];
    if (opts.effort && opts.effort !== "default") envParts.push(`CLAUDE_EFFORT=${opts.effort}`);

    // YOLO mode is the default for joy-tmux sessions — the app drives the
    // session and approving permission prompts via tmux send-keys is fragile.
    // An explicit permissionMode wins; otherwise `yolo: false` opts out.
    const mode = opts.permissionMode ?? ((opts.yolo ?? true) ? "bypassPermissions" : undefined);
    // Flag list builder, parameterized on whether --continue is included.
    const buildFlags = (withContinue: boolean): string[] => {
      const f: string[] = [];
      // Teach Claude the <options> convention the app renders as a picker (the
      // happy SDK injects this per-message; a tmux pane can't, so bake it in).
      f.push("--append-system-prompt", optionsPromptArg());
      if (opts.model) f.push("--model", opts.model);
      if (opts.fallbackModel) f.push("--fallback-model", opts.fallbackModel);
      if (withContinue && opts.continue) f.push("--continue");
      if (opts.resume_id) f.push("--resume", opts.resume_id);
      // claude rejects --fork-session without --resume/--continue, so silently
      // dropping it here beats a dead tmux window with a usage error in it.
      if (opts.forkSession && (opts.resume_id || (withContinue && opts.continue))) f.push("--fork-session");
      if (mode === "bypassPermissions") f.push("--dangerously-skip-permissions");
      else if (mode && mode !== "default") f.push("--permission-mode", mode);
      if (opts.chrome) f.push("--chrome");
      if (opts.extraArgs?.trim()) f.push(opts.extraArgs.trim());
      return f;
    };

    const flags = buildFlags(true);
    const tmuxWindow = `${this.tmuxSession}:${windowName}`;
    const primaryCmd = [...envParts, "claude", ...flags].join(" ");
    // `--continue` exits non-zero ("No conversation found to continue") in a
    // cwd with no prior conversation, leaving a stuck/dead pane. Fall back to a
    // fresh launch (no --continue) via `||` so the session still comes up.
    const cmd = opts.continue
      ? `${primaryCmd} || ${[...envParts, "claude", ...buildFlags(false)].join(" ")}`
      : primaryCmd;
    run("tmux", "new-window", "-t", this.tmuxSession, "-n", windowName, "-c", cwd);
    // Pin a sane default size so the window doesn't inherit whatever terminal
    // last touched the session (could be 182+ cols). A viewing client drives
    // it afterwards via joy-resize. Set before launch so claude's TUI renders
    // at this width from the start.
    run("tmux", "resize-window", "-t", tmuxWindow, "-x", "100", "-y", "40");
    // Replace the pane shell with a fresh login shell so it re-sources the
    // user's profile (.bashrc/.zshrc) — a default tmux pane only carries the
    // tmux server's frozen env, so without this a launch/restart wouldn't pick
    // up env-var changes. `exec` keeps the same PID, so PID discovery below is
    // unaffected. claude is sent after a beat to let the profile finish sourcing.
    const shell = process.env.SHELL || "/bin/bash";
    run("tmux", "send-keys", "-t", tmuxWindow, `exec ${shell} -l`, "Enter");

    // Kick off the relay session creation NOW so its network round-trips
    // overlap the sleeps below instead of running after them.
    const relayPromise = this.relayClient
      ? createRelaySession(this.relayClient, { tag: `joy-tmux-${id}`, cwd, id })
      : null;

    // Give the login shell time to source the profile, then launch claude.
    // (Skipped for a detached create — the window stays at the shell prompt and
    // the session is marked detached below.)
    if (!opts.detached) {
      await sleep(900);
      run("tmux", "send-keys", "-t", tmuxWindow, cmd, "Enter");
    }

    await sleep(400);
    const shellPid = parseInt(
      run("tmux", "display-message", "-t", tmuxWindow, "-p", "#{pane_pid}").out,
    );
    await sleep(800);
    let pid: number | undefined;
    if (!isNaN(shellPid)) {
      const child = parseInt(run("pgrep", "-P", String(shellPid)).out.split("\n")[0]);
      pid = isNaN(child) ? shellPid : child;
    }

    // On --resume we know the exact transcript. Pin it so the tailer replays
    // its history into the new relay session, instead of relying on the
    // mtime>=startedAt finder — which misses a resumed file (Claude touches it
    // before startedAt while loading context, then sits idle at the prompt).
    // Cap the backfill to the last ~resumeLimitMb (default 2), snapped back to a
    // turn boundary so a huge transcript doesn't flood the UI on resume.
    let resumeTranscriptPath: string | undefined;
    let resumeStartOffset = 0;
    if (opts.resume_id) {
      resumeTranscriptPath = join(cwdToTranscriptDir(cwd), `${opts.resume_id}.jsonl`);
      const capBytes = Math.max(0, opts.resumeLimitMb ?? 2) * 1024 * 1024;
      resumeStartOffset = cappedTailOffset(resumeTranscriptPath, capBytes);
    }

    const session = new Session({
      id, pid, tmuxWindow, cwd,
      model: opts.model,
      effort: opts.effort,
      flags,
      status: "starting",
      startedAt: Date.now(),
      transcriptPath: resumeTranscriptPath,
      transcriptStartOffset: resumeStartOffset,
    }, this.#sessionDeps());

    this.#sessions.set(id, session);
    // Persist the window→launch-cwd binding now; the claudeSessionId is merged in
    // once the first transcript entry reveals it. recover()/restart() prefer this
    // over the newest-mtime / pane-current-path heuristics (BUG-6/13/15).
    saveWindowRecord(id, { launchCwd: cwd });
    this.broadcast("session_update", session.toJSON());

    if (relayPromise) {
      try {
        const rs = await relayPromise;
        session.attachRelay(rs); // no-ops (and stops rs) if kill raced the create
      } catch (e) {
        process.stderr.write(`[relay] failed to create session for ${id}: ${e}\n`);
      }
    }

    // Detached create: don't launch/watch Claude — mark the session detached
    // (relay stays attached so file/git/diff RPCs work on the cwd; the window
    // sits at a shell). Starting it later (create/restart for this cwd) launches
    // Claude in place via the one-session-per-cwd guard.
    if (opts.detached) {
      session.end("process_exited");
      return session;
    }

    // Start the tailer AFTER the relay is attached. On --resume/restart the
    // transcript already exists, so startTailer() synchronously replays the
    // backfill; if we watched before attach, those history entries would be
    // sent into a null relay and silently dropped (the app showing no history).
    session.beginWatching();

    return session;
  }

  /**
   * Restart a session: kill the existing tmux window (if any) and start a
   * fresh one in the same cwd that resumes the same Claude conversation —
   * `--resume <claudeSessionId>` when we know it, `--continue` otherwise.
   * The app gets a new relay session; the old one is archived by end().
   *
   * `cwd` is a fallback for sessions this daemon no longer knows about
   * (e.g. after a daemon restart with the window already gone): the app
   * still has the path in relay metadata, and --continue in that cwd picks
   * up the most recent conversation there.
   */
  async restart(opts: { id: string; cwd?: string }): Promise<Session> {
    const existing = this.get(opts.id);
    // A daemon-forgotten session (window already gone after a daemon restart) has
    // no Session object — fall back to its persisted record so we can resume the
    // RIGHT conversation and reattach to its existing card (BUG-13).
    const rec = existing ? null : loadWindowRecord(opts.id);
    if (!existing && !opts.cwd && !rec) throw new Error(`unknown session: ${opts.id}`);

    const cwd = existing?.cwd ?? rec?.launchCwd ?? opts.cwd!;
    // Resume THIS session's specific conversation — its learned Claude id, or
    // failing that the exact transcript file it was tailing (basename = the
    // Claude session uuid). Crucially, do NOT fall back to `--continue` for a
    // known session: `--continue` resumes whatever conversation was most recent
    // in the cwd, so with several sessions in one directory it restarts the
    // WRONG one. `--continue` is only a last resort when we have nothing but a
    // cwd (recovery after the daemon lost the session entirely).
    const resumeId = existing?.claudeSessionId
      ?? (existing?.transcriptPath ? basename(existing.transcriptPath, ".jsonl") : undefined)
      ?? rec?.claudeSessionId;
    if (existing) existing.forceKill();

    // Env is refreshed automatically: create() launches claude through a fresh
    // login shell, so a restart re-sources the user's profile (.bashrc/.zshrc).
    return this.create({
      // Reuse the joy id for a forgotten session so its stable relay tag
      // reattaches to the existing app card instead of spawning a duplicate
      // (BUG-13). A KNOWN session is force-killed + archived above, so it
      // intentionally gets a fresh id/card.
      id: existing ? undefined : opts.id,
      cwd,
      resume_id: resumeId,
      continue: (!resumeId && !existing) ? true : undefined,
      model: existing?.model,
      effort: existing?.effort,
    });
  }

  /** Kill every session — active or detached — archiving each, then tear down
   *  the whole tmux session so nothing lingers (the base shell window and any
   *  orphaned windows the registry didn't track). The tmux session is recreated
   *  lazily on the next create(). Returns how many sessions were torn down. */
  killAll(): number {
    let n = 0;
    for (const session of [...this.#sessions.values()]) {
      if (session.forceKill()) n++;
    }
    // Nuke the tmux session itself — removes the leftover base window and any
    // untracked/orphaned windows in one shot.
    run("tmux", "kill-session", "-t", this.tmuxSession);
    process.stderr.write(`[killAll] archived ${n} sessions + killed tmux session ${this.tmuxSession}\n`);
    return n;
  }

  // ── Recovery (joy-tmux restart with live tmux windows) ──────────────────────

  recover(): void {
    const result = run("tmux", "list-windows", "-t", this.tmuxSession, "-F", "#{window_name}");
    if (!result.ok) return;

    for (const winName of result.out.split("\n").map(l => l.trim()).filter(Boolean)) {
      if (!/^j-[0-9a-f]{8}$/.test(winName)) continue;
      const id = winName.slice(2);
      if (this.#sessions.has(id)) continue;

      const tmuxWindow = `${this.tmuxSession}:${winName}`;
      // Prefer the persisted launch cwd over the pane's CURRENT dir: the user may
      // have cd'd inside the pane, and the drifted path would mis-key the dedup
      // guard / relay path / transcript lookup (BUG-15).
      const rec = loadWindowRecord(id);
      const paneCwd = run("tmux", "display-message", "-t", tmuxWindow, "-p", "#{pane_current_path}").out.trim();
      const cwd = rec?.launchCwd || paneCwd;
      if (!cwd) continue;

      const shellPid = parseInt(run("tmux", "display-message", "-t", tmuxWindow, "-p", "#{pane_pid}").out.trim());
      let pid: number | undefined;
      if (!isNaN(shellPid)) {
        const child = parseInt(run("pgrep", "-P", String(shellPid)).out.split("\n")[0]);
        pid = isNaN(child) ? undefined : child;
      }

      const isAlive = pid !== undefined && run("kill", "-0", String(pid)).ok;
      // Prefer the persisted claudeSessionId — binding by newest-mtime transcript
      // adopts an unrelated conversation when this window's transcript isn't the
      // newest in the dir (detached window, or another claude/codex run touched
      // it) (BUG-6). Fall back to the heuristic only when there's no record.
      const recTranscript = rec?.claudeSessionId
        ? join(cwdToTranscriptDir(cwd), `${rec.claudeSessionId}.jsonl`)
        : null;
      const transcriptPath = (recTranscript && existsSync(recTranscript))
        ? recTranscript
        : findLatestTranscript(cwdToTranscriptDir(cwd), 0);
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
      // Attach the relay (binds the session RPCs) even for ENDED sessions whose
      // tmux window still exists — so git status, the file browser, search and
      // diffs keep working on a finished session's directory (its cwd is still
      // there). Claude-dependent ops (send/abort) just no-op for a dead pane.
      //
      // Start watching (which replays the transcript from offset 0) ONLY after
      // the relay attaches — otherwise the synchronous backfill is forwarded
      // into a null relay and dropped (the same ordering bug create() avoids).
      // forwardedUuids (rebuilt from receipts.json) dedups already-sent history,
      // so only the downtime delta reaches the app.
      this.#attachRelayAsync(session, isAlive ? () => session.beginWatching() : undefined);
      process.stderr.write(`[recover] ${id} cwd=${cwd} alive=${isAlive} transcript=${transcriptPath}\n`);
    }
  }

  /** Re-attach relay sessions orphaned by a socket reconnect. */
  onRelayReconnect(): void {
    for (const session of this.#sessions.values()) {
      // Re-attach any session missing a relay — including ended ones, so their
      // file/git RPCs survive a socket reconnect too.
      if (session.relayAttached) {
        // A detached session keeps its relay, so it's skipped here — but a
        // one-shot joy__state:'detached' write lost to a merge timeout at the
        // moment of death would never be re-driven, leaving a dead session shown
        // green. Re-assert it on reconnect (no-ops if it already stuck).
        session.reassertLifecycle();
        continue;
      }
      process.stderr.write(`[relay] reconnect: creating session for orphaned ${session.id}\n`);
      this.#attachRelayAsync(session);
    }
  }

  // afterAttach runs once the relay is attached (or immediately if there's no
  // relay / attach fails) — recovery uses it to start the transcript tailer only
  // AFTER the relay is live, so the replay-from-0 backfill has somewhere to go.
  #attachRelayAsync(session: Session, afterAttach?: () => void): void {
    if (!this.relayClient) { afterAttach?.(); return; }
    // A session recovered as ended (window present, Claude dead) is detached;
    // anything else attaching here is running.
    const state = session.status === "ended" ? "detached" : "running";
    createRelaySession(this.relayClient, { tag: `joy-tmux-${session.id}`, cwd: session.cwd, id: session.id, state })
      .then(rs => {
        process.stderr.write(`[relay] session ${session.id} → relay ${rs.relaySessionId}\n`);
        // Recovery/reconnect contexts have no kill-race, so allow ended sessions
        // to attach (their file/git RPCs stay live; messages won't touch the pane).
        session.attachRelay(rs, true);
        afterAttach?.();
      })
      .catch(e => {
        process.stderr.write(`[relay] failed to create session for ${session.id}: ${e}\n`);
        afterAttach?.(); // still start watching (death detection, etc.) without a relay
      });
  }
}
