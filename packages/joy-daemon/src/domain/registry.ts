// SessionRegistry: the single owner of all Session instances plus the
// machine-level concerns that span sessions — creating them (tmux window +
// claude spawn + relay attach), recovering them after a joy-daemon restart,
// and fanning out events to the debug page (SSE + bounded chat log).

import { setTimeout as sleep } from "timers/promises";
import { existsSync, mkdirSync, statSync, readFileSync, readdirSync } from "fs";
import { join, basename, resolve } from "path";
import { homedir } from "os";
import { run } from "../tmux/shell";
import { tmux, tmuxHandleFor, disposeTmuxHandle, type TmuxDriver } from "../tmux/driver";
import { tmuxServerLabel } from "../paths";
import { CLIENT_ATTACHED_HOOK } from "../tmux/controlClient";
import { createRelaySession, type RelayClient, type RelaySession } from "../relay/relay.ts";
import { CommandRegistry } from "./commands.ts";
import { Session, type ChatMessage, type SessionDeps } from "../claude/session";
import type { AgentSession } from "./agentSession";
import { CodexSession, type CodexInit } from "../codex/codexSession";
import { OpencodeSession } from "../opencode/opencodeSession";
import { PiSession } from "../pi/piSession";
import { PI_MODELS, defaultPiModel } from "../pi/models";
import { OPENCODE_MODELS, defaultOpencodeModel } from "../opencode/models";
import { codexJoyInstructions } from "./agentTagsPrompt";
import { cwdToTranscriptDir, findLatestTranscript, cappedTailOffset, resolveTranscriptId } from "../claude/transcript";
import { loadWindowRecord, saveWindowRecord, listWindowRecords } from "./windowRecord";
import { optionsPromptArg } from "../claude/optionsPrompt";
import { ensureHookSettings, daemonFilePath } from "../claude/hooks";

export interface CreateSessionOpts {
  cwd: string;
  /** Agent type. Absent/'claude' → the claude CLI path; 'codex' → the codex
   *  app-server adapter (CodexSession). */
  agent?: "claude" | "codex" | "opencode" | "pi";
  /** Reuse a specific joy session id (and thus the same relay tag/card) instead
   *  of minting a fresh one — used when restarting a daemon-forgotten session so
   *  it reattaches to its existing app card rather than spawning a duplicate. */
  id?: string;
  model?: string;
  effort?: string;
  continue?: boolean;
  resume_id?: string;
  /** Cap the --resume history backfill to ~this many MB (snapped to a turn). Default 1; 0 = full. */
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
 * Expand a leading ~ to the joy-daemon user's home directory. tmux's -c flag
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

// Per-session tmux servers (docs/per-session-tmux-design.md): every NEW
// claude window gets its own tmux server so a tmux leak dies with the
// session. Legacy shared-server windows keep working until they end.
const PER_SESSION_TMUX = process.env.JOY_TMUX_PER_SESSION !== "0";

export class SessionRegistry {
  readonly tmuxSession: string;
  readonly relayClient: RelayClient | null;
  /** Slash-command discovery: machine-wide set + per-session projections. */
  readonly commands: CommandRegistry;
  /** Daemon boot time — exposed via the status op as uptime. */
  readonly startedAt = Date.now();
  #claudeInfo: { available: boolean; version: string | null } | null = null;
  #sessions = new Map<string, AgentSession>();
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
    /** The machine-metadata blob server.ts upserts; the command registry
     *  re-sends it (full-blob upsert) with slashCommands folded in. */
    baseMachineMetadata?: Record<string, unknown>;
  }) {
    this.tmuxSession = opts.tmuxSession;
    this.relayClient = opts.relayClient;
    this.#onRelayAttached = opts.onRelayAttached;
    this.commands = new CommandRegistry({
      relayClient: opts.relayClient,
      baseMachineMetadata: opts.baseMachineMetadata ?? {},
    });
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
    // Negative-cache for 30s: a machine without claude would otherwise pay the
    // ~100ms blocking probe on EVERY status poll, forever.
    const now = Date.now();
    if (this.#claudeInfo && now - this.#claudeProbeAt < 30_000) return this.#claudeInfo;
    this.#claudeProbeAt = now;
    const r = run("claude", "--version");
    this.#claudeInfo = r.ok
      ? { available: true, version: r.out.split("\n")[0].trim() || null }
      : { available: false, version: null };
    return this.#claudeInfo;
  }
  #claudeProbeAt = 0;

  // ── Lookup ──────────────────────────────────────────────────────────────────

  get(id: string): AgentSession | undefined {
    return this.#sessions.get(id);
  }

  // Killed sessions are kept in #sessions (recovery/dedup bookkeeping) but should
  // not count as live: exclude them from the listing/count the debug surfaces use,
  // else the machine page's "Active Sessions" inflates with every kill until the
  // next daemon restart. Detached (process_exited) sessions remain listed — their
  // window/cwd is still around and their file/git RPCs still answer.
  #isKilled(s: AgentSession): boolean {
    return s.status === "ended" && s.endReason === "killed";
  }

  list(): AgentSession[] {
    return [...this.#sessions.values()].filter(s => !this.#isKilled(s));
  }

  get size(): number {
    return this.list().length;
  }

  // ── Event fan-out (debug page SSE + bounded chat log) ───────────────────────

  broadcast(event: string, data: unknown): void {
    // Called for every transcript entry of every session — don't pay the
    // stringify (tool results can be tens of KB) when nobody's watching the
    // debug page, which is nearly always.
    if (this.#sseListeners.size === 0) return;
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
      isTranscriptClaimed: (path, selfId) =>
        [...this.#sessions.values()].some(s => s.id !== selfId && s.transcriptPath === path && s.status !== "ended"),
    };
  }

  // ── Create ──────────────────────────────────────────────────────────────────

  async create(opts: CreateSessionOpts): Promise<AgentSession> {
    const id = opts.id ?? crypto.randomUUID().replace(/-/g, "").slice(0, 8);
    const windowName = `j-${id}`;

    // Resolve ~, then verify the directory exists. tmux -c silently falls
    // back to the daemon's cwd when the directory is missing, which cascades
    // into the transcript watcher looking in the wrong projects/ folder and
    // Claude's responses never reaching the app.
    const cwd = expandHome(opts.cwd);

    // Multiple sessions per directory are allowed: each fresh session is pinned to
    // its own Claude session id (--session-id, below), so they no longer collide
    // on "the latest .jsonl". What we still avoid is *recreating the same session*
    // — a second `claude --resume <id>` on a live conversation collides/forks.
    const target = resolve(cwd);
    // Identity of a session, resolved the way restart() does: its learned Claude id,
    // else the basename of the transcript it's tailing (= the Claude session uuid).
    const sessionIdentity = (s: AgentSession): string | undefined =>
      s.claudeSessionId ?? (s.transcriptPath ? basename(s.transcriptPath, ".jsonl") : undefined);
    const inCwd = [...this.#sessions.values()].filter((s) => resolve(s.cwd) === target);
    const liveInCwd = inCwd.find((s) => s.status === "active" || s.status === "starting");
    const detachedInCwd = inCwd.find((s) => s.status === "ended" && s.endReason === "process_exited");

    if (opts.resume_id) {
      // Resuming a specific conversation: if it's the one already here, open/revive
      // it instead of recreating it. A different (not-live) id falls through and
      // gets its own new window — its transcript is distinct, so it coexists.
      const liveMatch = inCwd.find(
        (s) => (s.status === "active" || s.status === "starting") && sessionIdentity(s) === opts.resume_id,
      );
      if (liveMatch) {
        process.stderr.write(`[create] resume ${opts.resume_id} already live (window ${liveMatch.id}) — returning existing\n`);
        return liveMatch;
      }
      if (detachedInCwd && sessionIdentity(detachedInCwd) === opts.resume_id) {
        process.stderr.write(`[create] resume ${opts.resume_id} detached (window ${detachedInCwd.id}) — restarting in place\n`);
        return this.restart({ id: detachedInCwd.id });
      }
    } else if (detachedInCwd) {
      // Auto-revive a detached session (Claude died, window lingering) rather than
      // leave a dead window — restart() resumes its own conversation.
      process.stderr.write(`[create] ${detachedInCwd.id} detached in ${target} — restarting in place\n`);
      return this.restart({ id: detachedInCwd.id });
    } else if (opts.continue && liveInCwd) {
      // continue-most-recent with a session already live here → open the running one.
      process.stderr.write(`[create] continue with ${liveInCwd.id} live in ${target} — returning existing\n`);
      return liveInCwd;
    }
    // Otherwise fall through and create a NEW session below.

    if (!existsSync(cwd)) {
      if (opts.createDir) {
        mkdirSync(cwd, { recursive: true });
      } else {
        throw new DirectoryCreationApprovalRequired(cwd);
      }
    }

    // Per-session server: this session's own tmux server (-L label), created
    // below via new-session; its control client attaches per handle. Legacy
    // (flag off) keeps the shared-server bootstrap.
    const sockLabel = PER_SESSION_TMUX ? tmuxServerLabel(id) : null;
    // BOOTSTRAP — spawn, never control: has-session gates creation, new-session creates
    // the very session the control client attaches to (chicken-and-egg), and this
    // set-hook runs only when there's no session yet (so the client can't be connected).
    if (!sockLabel && !tmux.runSync("has-session", "-t", this.tmuxSession).ok) {
      tmux.runSync("new-session", "-d", "-s", this.tmuxSession, "-c", cwd);
      // When a real terminal attaches, let it drive the window size (tmux's
      // default `latest` behavior). The app's resize-window flips windows to
      // `manual`; this hook hands control back on attach so the most recent
      // connector — app or terminal — owns the width. Filtered so the daemon's own
      // control-mode client does NOT count as an attach that resizes.
      tmux.runSync("set-hook", "-t", this.tmuxSession, "client-attached", CLIENT_ATTACHED_HOOK);
    }

    // ── Codex path: a separate, minimal flow (app-server drive + attached TUI)
    // that shares the window bootstrap above but NONE of claude's flag/transcript
    // machinery. Kept isolated so the claude create path is untouched.
    if (opts.agent === "codex") {
      return await this.#createCodexSession(opts, id, windowName, cwd);
    }
    if (opts.agent === "opencode") {
      return await this.#createOpencodeSession(opts, id, cwd);
    }
    if (opts.agent === "pi") {
      return await this.#createPiSession(opts, id, cwd);
    }

    // Validate user-supplied fields to prevent shell injection via send-keys
    const SAFE_ID = /^[a-zA-Z0-9:._/-]{1,128}$/;
    const SAFE_EFFORT = /^[a-z]{1,32}$/;
    if (opts.model && !SAFE_ID.test(opts.model)) throw new Error("invalid model");
    if (opts.fallbackModel && !SAFE_ID.test(opts.fallbackModel)) throw new Error("invalid fallbackModel");
    if (opts.resume_id && !SAFE_ID.test(opts.resume_id)) throw new Error("invalid resume_id");
    // Accept a short id: Claude's --resume (and the existence check + live-collision
    // guard below) all need the full session uuid, so expand a unique prefix to the
    // full id here. An ambiguous prefix throws; nothing matched leaves it unchanged
    // for the existence check below to report as "not found".
    if (opts.resume_id) {
      opts.resume_id = resolveTranscriptId(cwdToTranscriptDir(cwd), opts.resume_id);
    }
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
    // EXCEPTION: forkSession — `--resume <id> --fork-session` reads the live
    // transcript once and continues under a NEW id, so there is no lock
    // collision. This is the "fork a running session" button in the app.
    if (opts.resume_id && !opts.forkSession) {
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
    // PreCompact hook reaches the daemon via these: the daemon.json path (fresh
    // port+token, so it survives daemon restarts that rotate the token) and this
    // session's id, which the hook POSTs to /sessions/:id/compacting.
    envParts.push(`JOY_DAEMON_FILE='${daemonFilePath()}'`);
    envParts.push(`JOY_SESSION_ID='${id}'`);
    // Claude Code's harness-side Tasks feature conflicts with joy's own
    // task/queue surfaces — keep it off in every joy-spawned claude.
    envParts.push(`CLAUDE_CODE_ENABLE_TASKS=0`);
    // joy-managed Claude settings, merged on top of the user's own: adds the
    // PreCompact hook that drives the app's "compacting" status. "" = generation
    // failed → skip the flag rather than pass claude a broken --settings path.
    const claudeSettings = ensureHookSettings();

    // YOLO mode is the default for joy-daemon sessions — the app drives the
    // session and approving permission prompts via tmux send-keys is fragile.
    // An explicit permissionMode wins; otherwise `yolo: false` opts out.
    const mode = opts.permissionMode ?? ((opts.yolo ?? true) ? "bypassPermissions" : undefined);
    // Fresh sessions (no resume/continue) get a daemon-generated Claude session id
    // so their transcript path is deterministic — multiple sessions can then run in
    // the same cwd without racing on findLatestTranscript. Claude writes the
    // transcript at <cwd-projects>/<id>.jsonl; we pin the session to it and the
    // tailer (pollForTranscript) waits for that exact file to appear.
    const freshClaudeId = (!opts.resume_id && !opts.continue) ? crypto.randomUUID() : undefined;
    const freshTranscriptPath = freshClaudeId
      ? join(cwdToTranscriptDir(cwd), `${freshClaudeId}.jsonl`)
      : undefined;
    // Flag list builder, parameterized on whether --continue is included.
    const buildFlags = (withContinue: boolean): string[] => {
      const f: string[] = [];
      // Teach Claude the <options> convention the app renders as a picker (the
      // the app SDK injected this per-message; a tmux pane can't, so bake it in).
      f.push("--append-system-prompt", optionsPromptArg());
      if (claudeSettings) f.push("--settings", `'${claudeSettings}'`);
      if (opts.model) f.push("--model", opts.model);
      if (opts.fallbackModel) f.push("--fallback-model", opts.fallbackModel);
      if (withContinue && opts.continue) f.push("--continue");
      if (opts.resume_id) f.push("--resume", opts.resume_id);
      if (freshClaudeId) f.push("--session-id", freshClaudeId);
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
    const drv: TmuxDriver = sockLabel ? tmuxHandleFor(sockLabel, windowName) : tmux;
    // On its own server the session IS the window: target by session name.
    const tmuxWindow = sockLabel ? windowName : `${this.tmuxSession}:${windowName}`;
    const primaryCmd = [...envParts, "claude", ...flags].join(" ");
    // `--continue` exits non-zero ("No conversation found to continue") in a
    // cwd with no prior conversation, leaving a stuck/dead pane. Fall back to a
    // fresh launch (no --continue) via `||` so the session still comes up.
    const cmd = opts.continue
      ? `${primaryCmd} || ${[...envParts, "claude", ...buildFlags(false)].join(" ")}`
      : primaryCmd;
    // STEADY STATE — control mode when the client is connected (spawn fallback while
    // not). The session exists now, so these target it over the live control
    // connection; the first-ever session is the only one likely to fall back (its
    // new-session above just ran, the client hasn't re-attached yet).
    //
    // Every NON-IDEMPOTENT step is checked. new-window goes through commandOnce (no
    // spawn retry), so a control failure can't create a DUPLICATE j-<id>. Each launch
    // keystroke is checked too: on any failure we best-effort kill the (possibly
    // half-created) window and throw, rather than march on through Enter / PID
    // discovery / relay attach on a window that may not hold a live shell. (A relay
    // session isn't created until after these succeed, so a failure here can't orphan
    // one.)
    const abortCreate = (why: string): never => {
      if (sockLabel) {
        drv.runSync("kill-server"); // half-made per-session server: the whole thing goes
        disposeTmuxHandle(sockLabel);
      } else {
        void tmux.command(["kill-window", "-t", tmuxWindow]); // idempotent cleanup of any half-made window
      }
      throw new Error(`session create failed: ${why}`);
    };
    if (sockLabel) {
      // Spawns the per-session SERVER too (first command on a fresh -L label);
      // -x/-y pins the initial size resize-window below re-asserts.
      if (!drv.runSync("new-session", "-d", "-s", windowName, "-x", "100", "-y", "40", "-c", cwd).ok) {
        abortCreate("new-session");
      }
    } else if (!(await drv.commandOnce(["new-window", "-t", this.tmuxSession, "-n", windowName, "-c", cwd])).ok) {
      abortCreate("new-window");
    }
    // Pin a sane default size so the window doesn't inherit whatever terminal last
    // touched the session (could be 182+ cols). Idempotent + cosmetic, so a failure
    // here is non-fatal — claude just renders at the default size until joy-resize.
    await drv.command(["resize-window", "-t", tmuxWindow, "-x", "100", "-y", "40"]);
    // Replace the pane shell with a fresh login shell so it re-sources the user's
    // profile (.bashrc/.zshrc) — a default tmux pane only carries the tmux server's
    // frozen env, so without this a launch/restart wouldn't pick up env-var changes.
    // `exec` keeps the same PID, so PID discovery below is unaffected. (literal text +
    // a named Enter — -l forces the text literal so a command that looks like a key
    // name can't be misread.)
    const shell = process.env.SHELL || "/bin/bash";
    if (!(await drv.literal(tmuxWindow, `exec ${shell} -l`)).ok) abortCreate("exec-shell");
    if (!(await drv.key(tmuxWindow, "Enter")).ok) abortCreate("exec-shell-enter");

    // Give the login shell time to source the profile, then launch claude. (Skipped
    // for a detached create — the window stays at the shell prompt and the session is
    // marked detached below.)
    if (!opts.detached) {
      await sleep(900);
      if (!(await drv.literal(tmuxWindow, cmd)).ok) abortCreate("launch-claude");
      if (!(await drv.key(tmuxWindow, "Enter")).ok) abortCreate("launch-claude-enter");
    }

    // Build the relay session (local card holder — no network) now that the
    // window is confirmed live; it's attached once the Session object exists.
    const relaySession = this.relayClient
      ? createRelaySession(this.relayClient, { tag: `joy-daemon-${id}`, cwd, id })
      : null;

    await sleep(400);
    const shellPid = parseInt(
      (await tmux.command(["display-message", "-t", tmuxWindow, "-p", "#{pane_pid}"])).out,
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
    // Cap the backfill to the last ~resumeLimitMb (default 1), snapped back to a
    // turn boundary so a huge transcript doesn't flood the UI on resume.
    let resumeTranscriptPath: string | undefined;
    let resumeStartOffset = 0;
    if (opts.resume_id) {
      resumeTranscriptPath = join(cwdToTranscriptDir(cwd), `${opts.resume_id}.jsonl`);
      const capBytes = Math.max(0, opts.resumeLimitMb ?? 1) * 1024 * 1024;
      resumeStartOffset = cappedTailOffset(resumeTranscriptPath, capBytes);
    }

    // --continue has the SAME flooding problem as --resume (it replays a
    // full-history transcript), but its file isn't known here — Claude picks
    // it at launch. So pass the cap down and let the Session apply it when the
    // transcript binds (startTailer). Same default (1MB) and flag as --resume;
    // 0 = full. Not for fresh sessions (empty transcript) or --resume (capped
    // above at create).
    const backfillCapBytes = opts.continue
      ? Math.max(0, opts.resumeLimitMb ?? 1) * 1024 * 1024
      : 0;

    const session = new Session({
      id, pid, tmuxWindow, cwd,
      tmux: sockLabel ? drv : undefined,
      tmuxSocket: sockLabel,
      model: opts.model,
      effort: opts.effort,
      flags,
      status: "starting",
      startedAt: Date.now(),
      transcriptPath: resumeTranscriptPath ?? freshTranscriptPath,
      transcriptStartOffset: resumeStartOffset,
      backfillCapBytes,
    }, this.#sessionDeps());

    this.#sessions.set(id, session);
    // Persist the window→launch-cwd binding now; the claudeSessionId is merged in
    // once the first transcript entry reveals it. recover()/restart() prefer this
    // over the newest-mtime / pane-current-path heuristics (BUG-6/13/15).
    saveWindowRecord(id, { launchCwd: cwd, socket: sockLabel });
    this.broadcast("session_update", session.toJSON());

    if (relaySession) session.attachRelay(relaySession); // no-ops (and stops rs) if kill raced the create

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
  /** Codex session creation: window + shell + CodexSession (which owns the
   *  app-server) + relay. Directory existence is validated by the shared create()
   *  before this is reached; here we only build the window and the session. */
  /** Opencode session creation: NO tmux window — the session is an app-server
   *  (opencode serve) + relay only. v1 model policy: curated fireworks pair
   *  (kimi-k3 default) — see docs/plans/opencode-adapter-design.md. */
  async #createOpencodeSession(opts: CreateSessionOpts, id: string, cwd: string): Promise<AgentSession> {
    if (!existsSync(cwd)) {
      if (opts.createDir) mkdirSync(cwd, { recursive: true });
      else throw new DirectoryCreationApprovalRequired(cwd);
    }
    // Model must be on the curated allowlist; an unknown request falls back to
    // the default rather than sending an arbitrary id to the provider.
    const requested = OPENCODE_MODELS.find((m) => m.id === opts.model) ?? defaultOpencodeModel();
    const session = new OpencodeSession({
      id, cwd,
      model: requested.id,
      providerID: requested.providerID,
      status: "starting",
      startedAt: Date.now(),
      // Resume an existing server-side opencode session (restart path).
      opencodeSessionId: opts.resume_id,
      continueLast: opts.continue === true,
    }, this.#sessionDeps());
    this.#sessions.set(id, session);
    saveWindowRecord(id, { launchCwd: cwd, agent: "opencode" });
    this.broadcast("session_update", session.toJSON());
    if (this.relayClient) {
      try {
        const rs = createRelaySession(this.relayClient, { tag: `joy-daemon-${id}`, cwd, id, flavor: "opencode" });
        session.attachRelay(rs);
      } catch (e) {
        process.stderr.write(`[relay] failed to create opencode session for ${id}: ${e}\n`);
      }
    }
    session.beginWatching();
    return session;
  }

  /** pi session creation: NO tmux window — a headless `pi --mode rpc` process
   *  + relay only (bare v1: no resume/recovery; relay history is the durable
   *  record). Model policy mirrors opencode: curated fireworks list. */
  async #createPiSession(opts: CreateSessionOpts, id: string, cwd: string): Promise<AgentSession> {
    if (!existsSync(cwd)) {
      if (opts.createDir) mkdirSync(cwd, { recursive: true });
      else throw new DirectoryCreationApprovalRequired(cwd);
    }
    const requested = PI_MODELS.find((m) => m.spec === opts.model) ?? defaultPiModel();
    const session = new PiSession({
      id, cwd, model: requested.spec, status: "starting", startedAt: Date.now(),
    }, this.#sessionDeps());
    this.#sessions.set(id, session);
    saveWindowRecord(id, { launchCwd: cwd, agent: "pi" });
    this.broadcast("session_update", session.toJSON());
    if (this.relayClient) {
      try {
        const rs = createRelaySession(this.relayClient, { tag: `joy-daemon-${id}`, cwd, id, flavor: "pi" });
        session.attachRelay(rs);
      } catch (e) {
        process.stderr.write(`[relay] failed to create pi session for ${id}: ${e}\n`);
      }
    }
    session.beginWatching();
    return session;
  }

  async #createCodexSession(opts: CreateSessionOpts, id: string, windowName: string, cwd: string): Promise<AgentSession> {
    if (!existsSync(cwd)) {
      if (opts.createDir) mkdirSync(cwd, { recursive: true });
      else throw new DirectoryCreationApprovalRequired(cwd);
    }
    const tmuxWindow = `${this.tmuxSession}:${windowName}`;
    const abortCreate = (why: string): never => {
      void tmux.command(["kill-window", "-t", tmuxWindow]);
      throw new Error(`codex session create failed: ${why}`);
    };
    if (!(await tmux.commandOnce(["new-window", "-t", this.tmuxSession, "-n", windowName, "-c", cwd])).ok) abortCreate("new-window");
    await tmux.command(["resize-window", "-t", tmuxWindow, "-x", "100", "-y", "40"]);
    const shell = process.env.SHELL || "/bin/bash";
    if (!(await tmux.literal(tmuxWindow, `exec ${shell} -l`)).ok) abortCreate("exec-shell");
    if (!(await tmux.key(tmuxWindow, "Enter")).ok) abortCreate("exec-shell-enter");

    // continue → resume the NEWEST codex thread that ran in this cwd (rollout
    // scan). Explicit resume_id wins. Fails loudly rather than silently
    // starting fresh — "continue" with nothing to continue is a user error.
    let resumeThread = opts.resume_id;
    if (!resumeThread && opts.continue) {
      const { findLatestCodexThreadForCwd } = await import("../codex/codexThreads");
      resumeThread = findLatestCodexThreadForCwd(cwd) ?? undefined;
      if (!resumeThread) abortCreate(`no prior codex conversation found in ${cwd}`);
    }
    // extraArgs for codex = `-c key=value` config overrides on the app-server.
    let codexConfig: Record<string, string> | undefined;
    if (opts.extraArgs?.trim()) {
      const { parseCodexConfigArgs } = await import("../codex/codexThreads");
      const parsed = parseCodexConfigArgs(opts.extraArgs);
      if (Object.keys(parsed).length > 0) codexConfig = parsed;
    }
    const init: CodexInit = {
      id, tmuxWindow, cwd,
      model: opts.model,
      effort: opts.effort,
      // Fail closed (finding #1): absent mode → collaborative default, not yolo.
      permissionMode: opts.permissionMode ?? "default",
      status: "starting",
      startedAt: Date.now(),
      // resume_id (a codex thread id) → thread/resume instead of thread/start.
      codexThreadId: resumeThread,
      // Resuming a thread into a NEWLY-created relay card: history replay must
      // include user rows (no prior card carries them).
      freshCard: !!resumeThread,
      config: codexConfig,
      // The joy tag vocabulary (options/img/file/notify/title) — codex's
      // system-prompt channel. Resumed threads keep their original
      // instructions (thread/resume doesn't retake them).
      developerInstructions: codexJoyInstructions(),
    };
    const session = new CodexSession(init, this.#sessionDeps());
    this.#sessions.set(id, session);
    saveWindowRecord(id, { launchCwd: cwd, agent: "codex" });
    this.broadcast("session_update", session.toJSON());

    if (this.relayClient) {
      try {
        const rs = createRelaySession(this.relayClient, { tag: `joy-daemon-${id}`, cwd, id, flavor: "codex" });
        session.attachRelay(rs);
      } catch (e) {
        process.stderr.write(`[relay] failed to create codex session for ${id}: ${e}\n`);
      }
    }
    // beginWatching spawns the app-server + connects + thread/start (after relay).
    session.beginWatching();
    return session;
  }

  async restart(opts: { id: string; cwd?: string }): Promise<AgentSession> {
    const existing = this.get(opts.id);
    // A daemon-forgotten session (window already gone after a daemon restart) has
    // no Session object — fall back to its persisted record so we can resume the
    // RIGHT conversation and reattach to its existing card (BUG-13).
    const rec = existing ? null : loadWindowRecord(opts.id);
    if (!existing && !opts.cwd && !rec) throw new Error(`unknown session: ${opts.id}`);

    const cwd = existing?.cwd ?? rec?.launchCwd ?? opts.cwd!;

    // Codex restart (review #5): restarting a codex session must NOT fall
    // through to the claude create path. Rebuild a codex session resuming its
    // thread. (A live `existing` codex session provides no claude id anyway.)
    // Opencode restart: same shape as codex — never fall through to the claude
    // path; resume the same server-side opencode session in a fresh server.
    const isOpencode = (existing instanceof OpencodeSession) || rec?.agent === "opencode";
    if (isOpencode) {
      const ocSessionId = (existing instanceof OpencodeSession ? existing.opencodeSessionId : undefined) ?? rec?.opencodeSessionId;
      const model = (existing instanceof OpencodeSession ? existing.model : undefined) ?? rec?.opencodeSettings?.model;
      if (existing) existing.forceKill();
      return this.create({
        agent: "opencode",
        id: existing ? undefined : opts.id,
        cwd,
        resume_id: ocSessionId,
        model,
      });
    }

    const isCodex = (existing instanceof CodexSession) || rec?.agent === "codex";
    if (isCodex) {
      // Resume the SAME thread. When a live session exists, `rec` is null, so
      // read the thread id off the session itself — otherwise restart would
      // start a brand-new thread instead of resuming (finding #7).
      const codexThreadId = (existing instanceof CodexSession ? existing.codexThreadId : undefined) ?? rec?.codexThreadId;
      if (existing) existing.forceKill();
      return this.create({
        agent: "codex",
        id: existing ? undefined : opts.id,
        cwd,
        resume_id: codexThreadId,
        model: existing?.model,
        effort: existing?.effort,
      });
    }

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
    // untracked/orphaned windows in one shot. Spawn (teardown of the very session the
    // control client is attached to — killing it over the client would race its %exit).
    tmux.runSync("kill-session", "-t", this.tmuxSession);
    process.stderr.write(`[killAll] archived ${n} sessions + killed tmux session ${this.tmuxSession}\n`);
    return n;
  }

  // ── Recovery (joy-daemon restart with live tmux windows) ──────────────────────

  /** Window-record passthroughs for the nucleus lane (v2 linkage + keys). */
  listRecords(): ReturnType<typeof listWindowRecords> { return listWindowRecords(); }
  saveRecord(id: string, patch: Parameters<typeof saveWindowRecord>[1]): void { saveWindowRecord(id, patch); }

  recover(): void {
    // Startup scan — spawn (runs before the control client is reliably attached; kept
    // synchronous so daemon boot doesn't depend on the connection coming up first).
    const result = tmux.runSync("list-windows", "-t", this.tmuxSession, "-F", "#{window_name}");
    // No tmux session at all → no windows to scan, but codex sessions can still
    // be resurrected from their records below (their substance is the
    // daemon-owned app-server + thread, not the window).
    const windowNames = result.ok ? result.out.split("\n").map(l => l.trim()).filter(Boolean) : [];

    // Two populations: legacy windows on the shared server, and per-session
    // servers discovered from their RECORDS (record-driven — no single server
    // knows them). Same adoption body for both, parameterized by driver.
    const candidates: Array<{ winName: string; target: string; drv: TmuxDriver; socket: string | null }> =
      windowNames
        .filter(w => /^j-[0-9a-f]{8}$/.test(w))
        .map(w => ({ winName: w, target: `${this.tmuxSession}:${w}`, drv: tmux, socket: null }));
    for (const rec of listWindowRecords()) {
      if (!rec.socket || !rec.id) continue;
      const winName = `j-${rec.id}`;
      if (run("tmux", "-L", rec.socket, "has-session", "-t", winName).ok) {
        candidates.push({ winName, target: winName, drv: tmuxHandleFor(rec.socket, winName), socket: rec.socket });
      } else {
        process.stderr.write(`[recover] ${rec.id}: per-session server gone (socket ${rec.socket})\n`);
      }
    }

    for (const { winName, target, drv, socket } of candidates) {
      const id = winName.slice(2);
      if (this.#sessions.has(id)) continue;

      const tmuxWindow = target;
      // Prefer the persisted launch cwd over the pane's CURRENT dir: the user may
      // have cd'd inside the pane, and the drifted path would mis-key the dedup
      // guard / relay path / transcript lookup (BUG-15).
      const rec = loadWindowRecord(id);
      const paneCwd = drv.runSync("display-message", "-t", tmuxWindow, "-p", "#{pane_current_path}").out.trim();
      const cwd = rec?.launchCwd || paneCwd;
      if (!cwd) continue;

      const shellPid = parseInt(drv.runSync("display-message", "-t", tmuxWindow, "-p", "#{pane_pid}").out.trim());
      let pid: number | undefined;
      if (!isNaN(shellPid)) {
        const child = parseInt(run("pgrep", "-P", String(shellPid)).out.split("\n")[0]);
        pid = isNaN(child) ? undefined : child;
      }

      const isAlive = pid !== undefined && run("kill", "-0", String(pid)).ok;

      // ── Codex recovery: reconstruct a CodexSession that respawns its own
      // app-server (the old one died with the daemon) and thread/resumes.
      // Codex recovery does NOT depend on the pane-child (attach TUI) being
      // alive (finding #7): the daemon-owned app-server died with the daemon
      // regardless, and a cleanly-exited TUI can coexist with a resumable
      // thread. So always attempt to respawn + resume.
      if (rec?.agent === "codex") {
        const s = rec.codexSettings ?? {};
        const session = new CodexSession({
          id, tmuxWindow, cwd,
          model: s.model,
          effort: s.effort,
          permissionMode: s.permissionMode ?? "default",
          // Always the CURRENT wording, not the snapshot saved at first spawn —
          // a daemon update between runs would otherwise resume threads with
          // stale joy instructions (claude gets the same for free: its
          // --append-system-prompt file is rewritten at every spawn).
          developerInstructions: codexJoyInstructions(),
          config: s.config,
          status: "active",
          startedAt: Date.now(),
          codexThreadId: rec.codexThreadId,
        }, this.#sessionDeps());
        this.#sessions.set(id, session);
        this.#attachRelayAsync(session, () => session.beginWatching());
        process.stderr.write(`[recover] codex ${id} cwd=${cwd} thread=${rec.codexThreadId} (respawn+resume)\n`);
        continue;
      }

      // Prefer the persisted claudeSessionId — binding by newest-mtime transcript
      // adopts an unrelated conversation when this window's transcript isn't the
      // newest in the dir (detached window, or another claude/codex run touched
      // it) (BUG-6). Fall back to the heuristic only when there's no record.
      const recTranscript = rec?.claudeSessionId
        ? join(cwdToTranscriptDir(cwd), `${rec.claudeSessionId}.jsonl`)
        : null;
      // Newest-mtime fallback must never adopt a transcript another recovered
      // session already owns — with several sessions per cwd, both recordless
      // windows would otherwise bind the same (newest) conversation and mirror
      // each other's turns. Better to stay unbound and let pollForTranscript
      // pick up a fresh transcript when it appears.
      const claimed = new Set(
        [...this.#sessions.values()].filter(s => s.status !== "ended").map(s => s.transcriptPath).filter(Boolean),
      );
      const fallback = findLatestTranscript(cwdToTranscriptDir(cwd), 0);
      const transcriptPath = (recTranscript && existsSync(recTranscript))
        ? recTranscript
        : (fallback && !claimed.has(fallback) ? fallback : undefined);
      const claudeSessionId = transcriptPath ? basename(transcriptPath, ".jsonl") : undefined;

      // Replay checkpoint (codex review finding 8): resume the tail where the
      // previous daemon left off instead of replaying the whole file from 0 —
      // receipts then only dedupe the small post-checkpoint overlap. Path-
      // scoped: applies only when we bind the SAME transcript file.
      const checkpoint = rec?.transcriptCheckpoint;
      const startOffset = (checkpoint && transcriptPath && checkpoint.path === transcriptPath
        && existsSync(transcriptPath) && statSync(transcriptPath).size >= checkpoint.offset)
        ? checkpoint.offset : 0;

      const session = new Session({
        id, pid, tmuxWindow, cwd,
        tmux: socket ? drv : undefined,
        tmuxSocket: socket,
        flags: [],
        status: isAlive ? "active" : "ended",
        startedAt: transcriptPath ? statSync(transcriptPath).mtimeMs : Date.now(),
        claudeSessionId,
        transcriptPath: transcriptPath ?? undefined,
        transcriptStartOffset: startOffset,
      }, this.#sessionDeps());
      if (startOffset > 0) process.stderr.write(`[recover] ${id} resuming transcript at checkpoint offset ${startOffset}\n`);

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

    this.#resurrectCodexOrphans();
    this.#sweepOrphanTmuxServers();
  }

  /** Retire per-session tmux servers with NO window record (a crash between
   *  server-spawn and record write, or manual mischief). Conservative: only
   *  sockets matching OUR label scheme, only when no human client is
   *  attached. Never touches the shared server or foreign sockets. */
  #sweepOrphanTmuxServers(): void {
    try {
      const dir = process.env.TMUX_TMPDIR || `/tmp/tmux-${process.getuid?.() ?? ""}`;
      const prefix = tmuxServerLabel("");
      const known = new Set(listWindowRecords().map(r => r.socket).filter(Boolean));
      for (const name of (existsSync(dir) ? readdirSync(dir) : [])) {
        if (!name.startsWith(prefix) || known.has(name)) continue;
        if (!run("tmux", "-L", name, "has-session").ok) continue; // dead socket file; tmux cleans it
        const clients = run("tmux", "-L", name, "list-clients").out.trim();
        if (clients) continue; // a human is attached — leave it alone
        run("tmux", "-L", name, "kill-server");
        process.stderr.write(`[recover] retired orphan tmux server ${name} (no record, no clients)\n`);
      }
    } catch { /* sweep is best-effort */ }
  }

  /** RECORD-based codex recovery (2026-07-31): a codex session whose tmux
   *  window vanished (window churn, tmux death) but whose app-server is STILL
   *  RUNNING was previously forgotten forever — the window scan above never
   *  sees it, the card in the app goes dead (`session_not_found`) while the
   *  live thread keeps running orphaned. A codex session's substance is the
   *  daemon-owned app-server + thread; the window only hosts the attach TUI.
   *  So: scan the persisted window records and resurrect any codex session
   *  whose recorded app-server is VERIFIABLY alive (socket present + recorded
   *  pid running `codex app-server` on that exact socket — never a recycled
   *  pid), recreating its window. Intentional kills can't resurrect: end
   *  ('killed') deletes the record. */
  #resurrectCodexOrphans(): void {
    // Opencode recovery: window-less by design, so records are the ONLY
    // discovery path. opencode persists sessions server-side per project dir,
    // so recovery is simply: fresh server in the cwd + resume the stored
    // session id (reaping any recorded live server pid on takeover).
    for (const rec of listWindowRecords()) {
      if (rec.agent !== "opencode" || !rec.id || this.#sessions.has(rec.id)) continue;
      if (!existsSync(rec.launchCwd)) continue;
      const session = new OpencodeSession({
        id: rec.id, cwd: rec.launchCwd,
        model: rec.opencodeSettings?.model,
        providerID: rec.opencodeSettings?.providerID,
        status: "active", startedAt: Date.now(),
        opencodeSessionId: rec.opencodeSessionId,
        opencodeServerPid: rec.opencodeServerPid,
        opencodeDeliveredThrough: rec.opencodeDeliveredThrough,
      }, this.#sessionDeps());
      this.#sessions.set(rec.id, session);
      this.#attachRelayAsync(session, () => session.beginWatching());
      process.stderr.write(`[recover] opencode ${rec.id} respawn+resume session=${rec.opencodeSessionId}\n`);
    }
    for (const rec of listWindowRecords()) {
      if (rec.agent !== "codex" || !rec.id || this.#sessions.has(rec.id)) continue;
      const sock = rec.codexSocketPath;
      const pid = rec.codexServerPid;
      if (!sock || !pid || !existsSync(sock) || !existsSync(rec.launchCwd)) continue;
      let cmdline = "";
      try { cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8"); } catch { continue; }
      if (!cmdline.includes("app-server") || !cmdline.includes(sock)) continue;

      const winName = `j-${rec.id}`;
      const tmuxWindow = `${this.tmuxSession}:${winName}`;
      if (!tmux.runSync("has-session", "-t", this.tmuxSession).ok) {
        tmux.runSync("new-session", "-d", "-s", this.tmuxSession, "-c", rec.launchCwd);
      }
      if (!tmux.runSync("new-window", "-t", this.tmuxSession, "-n", winName, "-c", rec.launchCwd).ok) continue;
      const shell = process.env.SHELL || "/bin/bash";
      tmux.runSync("send-keys", "-t", tmuxWindow, "-l", `exec ${shell} -l`);
      tmux.runSync("send-keys", "-t", tmuxWindow, "Enter");

      const s = rec.codexSettings ?? {};
      const session = new CodexSession({
        id: rec.id, tmuxWindow, cwd: rec.launchCwd,
        model: s.model, effort: s.effort,
        permissionMode: s.permissionMode ?? "default",
        // Current wording, not the first-spawn snapshot (see the restore path
        // above for why).
        developerInstructions: codexJoyInstructions(),
        config: s.config,
        status: "active", startedAt: Date.now(),
        codexThreadId: rec.codexThreadId,
      }, this.#sessionDeps());
      this.#sessions.set(rec.id, session);
      // beginWatching's orphan-rejoin path connects to the live socket and
      // reconciles the thread; the attach TUI relaunches into the new window.
      this.#attachRelayAsync(session, () => session.beginWatching());
      process.stderr.write(`[recover] codex ${rec.id} resurrected from record (window was gone, app-server pid ${pid} alive) thread=${rec.codexThreadId}\n`);
    }
  }

  // afterAttach runs once the relay is attached (or immediately if there's no
  // relay / attach fails) — recovery uses it to start the transcript tailer only
  // AFTER the relay is live, so the replay-from-0 backfill has somewhere to go.
  #attachRelayAsync(session: AgentSession, afterAttach?: () => void): void {
    if (!this.relayClient) { afterAttach?.(); return; }
    // A session recovered as ended (window present, Claude dead) is detached;
    // anything else attaching here is running.
    const state = session.status === "ended" ? "detached" : "running";
    try {
      const rs = createRelaySession(this.relayClient, { tag: `joy-daemon-${session.id}`, cwd: session.cwd, id: session.id, state });
      // Recovery contexts have no kill-race, so allow ended sessions to attach
      // (their file/git RPCs stay live; messages won't touch the pane).
      session.attachRelay(rs, true);
    } catch (e) {
      process.stderr.write(`[relay] failed to create session for ${session.id}: ${e}\n`);
    }
    afterAttach?.(); // start watching (death detection, etc.) with or without a relay
  }
}
