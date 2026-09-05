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
import { tmuxServerLabel, tmuxNamesFor, TMUX_AGENT_WINDOW } from "../paths";
import { applyEnvStore } from "./envStore";
import { CLIENT_ATTACHED_HOOK } from "../tmux/controlClient";
import { createRelaySession, type RelayClient, type RelaySession } from "../relay/relay.ts";
import { CommandRegistry } from "./commands.ts";
import { Session, type ChatMessage, type SessionDeps, type QueuedItem } from "../claude/session";
import type { AgentSession } from "./agentSession";
import { CodexSession, type CodexInit } from "../codex/codexSession";
import { OpencodeSession } from "../opencode/opencodeSession";
import { PiSession } from "../pi/piSession";
import { AgySession } from "../agy/agySession";
import { resumeHandoffJobs } from "./handoff";
import { PI_MODELS, defaultPiModel } from "../pi/models";
import { OPENCODE_MODELS, defaultOpencodeModel } from "../opencode/models";
import { codexJoyInstructions } from "./agentTagsPrompt";
import { cwdToTranscriptDir, findLatestTranscript, cappedTailOffset, resolveTranscriptId } from "../claude/transcript";
import { loadWindowRecord, saveWindowRecord, listWindowRecords, deleteWindowRecord } from "./windowRecord";
import { optionsPromptArg } from "../claude/optionsPrompt";
import { ensureHookSettings, daemonFilePath } from "../claude/hooks";

export interface CreateSessionOpts {
  cwd: string;
  /** Agent type. Absent/'claude' → the claude CLI path; 'codex' → the codex
   *  app-server adapter (CodexSession). */
  agent?: "claude" | "codex" | "opencode" | "pi" | "agy";
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
  /** Never revive/adopt a session already in this cwd — ALWAYS a new one.
   *  Fork, handoff and teleport set it: create()'s auto-revive of a detached
   *  session in the folder was restarting an unrelated old conversation and
   *  handing it the pickup note instead (codex review, 2026-09-04). */
  forceNew?: boolean;
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
  // Registered by the nucleus lane: mark every relay turn this LOCAL session
  // is executing as cancel-requested, so a restart mid-turn terminalizes it
  // as cancelled instead of the lane observing busy()=false on the corpse
  // and reporting "completed" (codex review #7, 2026-09-04).
  /** Relay-lane hook: cancel the running turn(s) of a session being
   *  restarted, except those whose queue item ids are in `keep` — they move
   *  to the replacement and keep running under the same ids. */
  #turnCanceller?: (localId: string, keep: ReadonlySet<string>) => void;
  setTurnCanceller(fn: (localId: string, keep: ReadonlySet<string>) => void): void { this.#turnCanceller = fn; }
  /** Relay-lane hook: bind a daemon-created session to a relay card now. */
  #announcer?: (session: AgentSession) => Promise<void>;
  setAnnouncer(fn: (session: AgentSession) => Promise<void>): void { this.#announcer = fn; }
  async announce(id: string): Promise<void> {
    const s = this.get(id);
    if (s && this.#announcer) await this.#announcer(s);
  }

  /** Tear a session down for an in-place restart: pluck the prompts not yet
   *  dispatched (they move to the replacement), cancel the relay turn(s)
   *  that WERE (the interrupted one must end cancelled, not "completed" off
   *  the dead object's busy() dropping), end the process without archiving
   *  the card, and — for adapters that reopen the same on-disk conversation —
   *  wait for the old process to be really gone. */
  async #retire(existing: AgentSession | undefined, id: string): Promise<QueuedItem[]> {
    if (!existing) return [];
    const carried = (existing.takeQueuedForRestart?.() ?? []) as QueuedItem[];
    this.#turnCanceller?.(id, new Set(carried.map((q) => q.id)));
    existing.end("restart");
    this.#sessions.delete(id);
    await existing.awaitExit?.();
    return carried;
  }

  /** Launch the replacement and hand it the carried prompts. A launch that
   *  fails must not leave a live-looking card with no session behind it —
   *  the app kept a "running" ghost that answered session_not_found forever
   *  (codex review, 2026-09-04) — so archive it and rethrow. */
  async #replace(id: string, cwd: string, carried: QueuedItem[], make: () => Promise<AgentSession>): Promise<AgentSession> {
    let next: AgentSession;
    this.#replacing.add(id);
    try { next = await make(); }
    catch (e) {
      if (this.relayClient) {
        try { await createRelaySession(this.relayClient, { tag: `joy-daemon-${id}`, cwd, id }).archive(); } catch { /* best effort */ }
      }
      // The card is archived; a surviving record would resurrect an agy or
      // opencode session as running against it on the next boot (#52).
      deleteWindowRecord(id);
      throw e;
    } finally {
      this.#replacing.delete(id);
    }
    for (const q of carried) next.enqueue(q.text, { id: q.id, source: q.source, mirrorToRelay: q.mirrorToRelay, seq: q.seq, visible: q.visible });
    if (carried.length) process.stderr.write(`[restart] ${id}: ${carried.length} queued prompt(s) carried to the replacement\n`);
    return next;
  }

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
    const cwd = expandHome(opts.cwd);
    // Reserved while this create runs: a second create({id}) during the tmux
    // setup used to kill the first one's server and return a second object
    // (Astra on 01bdac2f). Released in the wrapper below.
    // Join an in-flight restart of this id BEFORE reserving: a joiner that
    // reserved first made the restart's own replacement fail id_in_use
    // (Astra on 45e1653a).
    const pendingRestart = opts.id ? this.#restarting.get(opts.id) : undefined;
    if (pendingRestart && !this.#replacing.has(id)) return pendingRestart;
    if (this.#creating.has(id)) throw new Error(`session ${id} is being created (id_in_use)`);
    this.#creating.add(id);
    try { return await this.#createInner(opts, id, cwd); } finally { this.#creating.delete(id); }
  }
  #creating = new Set<string>();
  /** Ids whose restart is currently running its replacement create (see create). */
  #replacing = new Set<string>();
  async #createInner(opts: CreateSessionOpts, id: string, cwd: string): Promise<AgentSession> {
    // Legacy shared-server layout only: the window that carries the id.
    const windowName = `j-${id}`;

    // Resolve ~, then verify the directory exists. tmux -c silently falls
    // back to the daemon's cwd when the directory is missing, which cascades
    // into the transcript watcher looking in the wrong projects/ folder and
    // Claude's responses never reaching the app.

    // Multiple sessions per directory are allowed: each fresh session is pinned to
    // its own Claude session id (--session-id, below), so they no longer collide
    // on "the latest .jsonl". What we still avoid is *recreating the same session*
    // — a second `claude --resume <id>` on a live conversation collides/forks.
    const target = resolve(cwd);
    // Identity of a session, resolved the way restart() does: its learned Claude id,
    // else the basename of the transcript it's tailing (= the Claude session uuid).
    const sessionIdentity = (s: AgentSession): string | undefined =>
      s.claudeSessionId ?? (s.transcriptPath ? basename(s.transcriptPath, ".jsonl") : undefined);
    // Same folder AND same harness: a detached Claude must never answer a
    // request for a codex/pi/agy session there (#44).
    const flavor = opts.agent ?? "claude";
    const inCwd = [...this.#sessions.values()].filter((s) => resolve(s.cwd) === target && s.agentFlavor === flavor);
    const liveInCwd = inCwd.find((s) => s.status === "active" || s.status === "starting");
    // Auto-revive only when the caller expressed no preference: an explicit
    // model / permission mode / extra args is a request for THAT launch, not
    // for whatever the dead session had.
    const explicit = !!(opts.model || opts.permissionMode || opts.extraArgs || opts.effort || opts.fallbackModel || opts.chrome || opts.yolo !== undefined);
    /** Does a live session already match every setting the caller asked for? */
    const matchesRequest = (live: AgentSession): boolean => {
      if (opts.model && (live.currentModel ?? live.model) !== opts.model) return false;
      if (opts.effort && live.effort !== opts.effort) return false;
      // Launch-only flags a live session cannot report: a request for them is
      // a request for a new launch (Astra on 45e1653a).
      if (opts.fallbackModel || opts.chrome || opts.extraArgs?.trim()) return false;
      // An explicit permissionMode wins over yolo (the launch rule).
      if (opts.permissionMode) return live.detectPermissionMode() === opts.permissionMode;
      if (opts.yolo === false && live.detectPermissionMode() === "bypassPermissions") return false;
      if (opts.yolo === true && live.detectPermissionMode() !== null && live.detectPermissionMode() !== "bypassPermissions") return false;
      return true;
    };
    const conflict = (live: AgentSession): never => {
      throw new Error(`a ${flavor} session (${live.id}) is already live in ${target} with different settings; restart it with the new settings, or resume without --continue`);
    };
    const detachedInCwd = explicit ? undefined : inCwd.find((s) => s.status === "ended" && s.endReason === "process_exited");

    // An EXPLICIT id (a restart's replacement, a spawn's reserved id) is a
    // request for exactly that session: none of the cwd adoption/revival
    // below applies to it (a replacement once came back as a different live
    // session in the same folder — Astra on 2f803b14), a live object under
    // that id is a conflict rather than something to launch over, and an
    // in-flight restart of it is joined, not raced (#42/#45/#75).
    if (opts.id) {
      // Join an in-flight restart of this id — unless WE are that restart's
      // replacement (self-join deadlocked every restart; Astra on 01bdac2f).
      const pendingRestart = this.#restarting.get(opts.id);
      if (pendingRestart && !this.#replacing.has(opts.id)) return pendingRestart;
      const live = this.#sessions.get(opts.id);
      if (live && live.status !== "ended") throw new Error(`session ${opts.id} is already live (id_in_use)`);
      // (the in-flight-create reservation is checked in create() itself, BEFORE
      // it reserves this id — checking it here saw our own reservation)
    }
    // A FORK is never "the one already here": --fork-session reads the
    // transcript once and continues under a new id, so a live match must not
    // be returned in its place (that handed "Fork" the very session it was
    // forking, 2026-09-03) and a detached one must not be restarted instead.
    if (opts.id) {
      // explicit id: skip adoption (see above)
    } else if (opts.resume_id && !opts.forkSession) {
      // Resuming a specific conversation: if it's the one already here, open/revive
      // it instead of recreating it. A different (not-live) id falls through and
      // gets its own new window — its transcript is distinct, so it coexists.
      const liveMatch = inCwd.find(
        (s) => (s.status === "active" || s.status === "starting") && sessionIdentity(s) === opts.resume_id,
      );
      if (liveMatch) {
        if (explicit && !matchesRequest(liveMatch)) conflict(liveMatch); // the caller asked for settings this session does not have (#44)
        process.stderr.write(`[create] resume ${opts.resume_id} already live (window ${liveMatch.id}) — returning existing\n`);
        return liveMatch;
      }
      if (detachedInCwd && sessionIdentity(detachedInCwd) === opts.resume_id) {
        process.stderr.write(`[create] resume ${opts.resume_id} detached (window ${detachedInCwd.id}) — restarting in place\n`);
        return this.restart({ id: detachedInCwd.id });
      }
    } else if (detachedInCwd && !opts.forceNew) {
      // Auto-revive a detached session (Claude died, window lingering) rather than
      // leave a dead window — restart() resumes its own conversation.
      process.stderr.write(`[create] ${detachedInCwd.id} detached in ${target} — restarting in place\n`);
      return this.restart({ id: detachedInCwd.id });
    } else if (opts.continue && liveInCwd && !opts.forceNew) {
      // continue-most-recent with a session already live here → open the
      // running one — unless the caller asked for different settings, which
      // that session does not have: say so instead of silently returning a
      // different launch (Astra on 2f803b14, #44).
      if (explicit && !matchesRequest(liveInCwd)) conflict(liveInCwd);
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
    // Provider keys from the sealed store, refreshed at EVERY spawn so a key
    // set from the app since boot reaches this session (every agent's process
    // — tmux server, app-server, pi — inherits process.env).
    applyEnvStore();

    // Per-session server: this session's own tmux server (-L label), created
    // below via new-session; its control client attaches per handle. Legacy
    // (flag off) keeps the shared-server bootstrap.
    const sockLabel = PER_SESSION_TMUX ? tmuxServerLabel(id) : null;
    // BOOTSTRAP (legacy shared layout only) — spawn, never control: has-session gates
    // creation, new-session creates the very session the control client attaches to
    // (chicken-and-egg), and this set-hook runs only when there's no session yet.
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
      return await this.#createCodexSession(opts, id, sockLabel, windowName, cwd);
    }
    if (opts.agent === "opencode") {
      return await this.#createOpencodeSession(opts, id, cwd);
    }
    if (opts.agent === "pi") {
      return await this.#createPiSession(opts, id, cwd);
    }
    if (opts.agent === "agy") {
      return await this.#createAgySession(opts, id, cwd);
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
      // Teach Claude the <joy-options> convention the app renders as a picker (the
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
    // Own server: session `joy-<id>`, the agent in its pinned `agent` window.
    const names = sockLabel ? tmuxNamesFor(sockLabel, id) : null;
    const drv: TmuxDriver = names ? tmuxHandleFor(sockLabel!, names.session) : tmux;
    const tmuxWindow = names ? names.target : `${this.tmuxSession}:${windowName}`;
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
    if (names) {
      // Spawns the per-session SERVER too (first command on a fresh -L label).
      if (!(await this.#newAgentServer(drv, names.session, cwd))) abortCreate("new-session");
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
      (await drv.command(["display-message", "-t", tmuxWindow, "-p", "#{pane_pid}"])).out,
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
    saveWindowRecord(id, { launchCwd: cwd, socket: sockLabel, claudePermissionMode: mode ?? "default" });
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
    // pi persists sessions itself (~/.pi/agent/sessions/<cwd>/…): a fresh
    // session gets an id we choose (--session-id), so the record can resume
    // it; --resume <id> reuses one; --continue takes pi's newest for the cwd.
    const piSessionId = opts.resume_id ?? (opts.continue ? undefined : crypto.randomUUID());
    const session = new PiSession({
      id, cwd, model: requested.spec, status: "starting", startedAt: Date.now(),
      piSessionId, continueLast: opts.continue === true && !opts.resume_id,
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

  async #createAgySession(opts: CreateSessionOpts, id: string, cwd: string): Promise<AgentSession> {
    if (!existsSync(cwd)) {
      if (opts.createDir) mkdirSync(cwd, { recursive: true });
      else throw new DirectoryCreationApprovalRequired(cwd);
    }
    // Model is a display name from `agy models` (validated loosely: no shell
    // is involved, it goes to spawn argv). Absent → the CLI's own default.
    if (opts.model && !/^[\w .()+-]{1,64}$/.test(opts.model)) throw new Error("invalid model");
    const session = new AgySession({
      id, cwd, model: opts.model, status: "starting", startedAt: Date.now(),
      conversationId: opts.resume_id, continueLast: opts.continue === true && !opts.resume_id,
    }, this.#sessionDeps());
    this.#sessions.set(id, session);
    saveWindowRecord(id, { launchCwd: cwd, agent: "agy" });
    this.broadcast("session_update", session.toJSON());
    if (this.relayClient) {
      try {
        const rs = createRelaySession(this.relayClient, { tag: `joy-daemon-${id}`, cwd, id, flavor: "agy" });
        session.attachRelay(rs);
      } catch (e) {
        process.stderr.write(`[relay] failed to create agy session for ${id}: ${e}\n`);
      }
    }
    session.beginWatching();
    return session;
  }

  async #createCodexSession(opts: CreateSessionOpts, id: string, sockLabel: string | null, windowName: string, cwd: string): Promise<AgentSession> {
    if (!existsSync(cwd)) {
      if (opts.createDir) mkdirSync(cwd, { recursive: true });
      else throw new DirectoryCreationApprovalRequired(cwd);
    }
    // Same per-session server as every other agent (the window only hosts
    // the attach TUI, but a TUI redraws like any other — the leak the split
    // exists for). Legacy layout (flag off) keeps the shared window.
    const names = sockLabel ? tmuxNamesFor(sockLabel, id) : null;
    const drv: TmuxDriver = names ? tmuxHandleFor(sockLabel!, names.session) : tmux;
    const tmuxWindow = names ? names.target : `${this.tmuxSession}:${windowName}`;
    const abortCreate = (why: string): never => {
      if (sockLabel) { drv.runSync("kill-server"); disposeTmuxHandle(sockLabel); }
      else void tmux.command(["kill-window", "-t", tmuxWindow]);
      throw new Error(`codex session create failed: ${why}`);
    };
    if (names) {
      if (!(await this.#newAgentServer(drv, names.session, cwd))) abortCreate("new-session");
    } else if (!(await drv.commandOnce(["new-window", "-t", this.tmuxSession, "-n", windowName, "-c", cwd])).ok) {
      abortCreate("new-window");
    }
    await drv.command(["resize-window", "-t", tmuxWindow, "-x", "100", "-y", "40"]);
    const shell = process.env.SHELL || "/bin/bash";
    if (!(await drv.literal(tmuxWindow, `exec ${shell} -l`)).ok) abortCreate("exec-shell");
    if (!(await drv.key(tmuxWindow, "Enter")).ok) abortCreate("exec-shell-enter");

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
      tmux: sockLabel ? drv : undefined,
      tmuxSocket: sockLabel,
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
    saveWindowRecord(id, { launchCwd: cwd, agent: "codex", socket: sockLabel });
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

  /** In-flight restarts by id: a second Restart (double tap, tunnel retry)
   *  while the first is mid-relaunch used to find no session, fall back to
   *  the record, hit "duplicate session" on the first one's fresh server,
   *  kill it and archive the card (#45). It now joins the first. */
  #restarting = new Map<string, Promise<AgentSession>>();
  async restart(opts: { id: string; cwd?: string }): Promise<AgentSession> {
    const pending = this.#restarting.get(opts.id);
    if (pending) return pending;
    const run = this.#restartInner(opts).finally(() => { this.#restarting.delete(opts.id); });
    this.#restarting.set(opts.id, run);
    return run;
  }
  async #restartInner(opts: { id: string; cwd?: string }): Promise<AgentSession> {
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
      const carried = await this.#retire(existing, opts.id);
      return this.#replace(opts.id, cwd, carried, () => this.create({
        agent: "opencode",
        id: opts.id,
        cwd,
        resume_id: ocSessionId,
        model,
      }));
    }

    // Antigravity / pi restart: resume THEIR conversation under the same id —
    // both fell through to the claude path and came back as a fresh Claude
    // session with the record still saying agy/pi (codex review, 2026-09-04).
    const isAgy = (existing instanceof AgySession) || rec?.agent === "agy";
    if (isAgy) {
      const conversationId = (existing instanceof AgySession ? existing.conversationId : undefined) ?? rec?.agySettings?.conversationId;
      const model = existing?.model ?? rec?.agySettings?.model;
      const carried = await this.#retire(existing, opts.id);
      return this.#replace(opts.id, cwd, carried, () => this.create({ agent: "agy", id: opts.id, cwd, resume_id: conversationId, model, forceNew: true }));
    }
    const isPi = (existing instanceof PiSession) || rec?.agent === "pi";
    if (isPi) {
      const piSessionId = (existing instanceof PiSession ? existing.piSessionId : undefined) ?? rec?.piSettings?.sessionId;
      const model = existing?.model ?? rec?.piSettings?.model;
      const carried = await this.#retire(existing, opts.id);
      return this.#replace(opts.id, cwd, carried, () => this.create({ agent: "pi", id: opts.id, cwd, resume_id: piSessionId, model, forceNew: true }));
    }
    const isCodex = (existing instanceof CodexSession) || rec?.agent === "codex";
    if (isCodex) {
      // Resume the SAME thread. When a live session exists, `rec` is null, so
      // read the thread id off the session itself — otherwise restart would
      // start a brand-new thread instead of resuming (finding #7).
      const codexThreadId = (existing instanceof CodexSession ? existing.codexThreadId : undefined) ?? rec?.codexThreadId;
      // Settings come back with it: model, effort AND permission mode (the
      // old restart dropped the mode → "default").
      const codexRec = rec ?? loadWindowRecord(opts.id);
      const codexMode = existing?.detectPermissionMode() ?? codexRec?.codexSettings?.permissionMode ?? undefined;
      const carried = await this.#retire(existing, opts.id);
      return this.#replace(opts.id, cwd, carried, () => this.create({
        agent: "codex",
        id: opts.id,
        cwd,
        resume_id: codexThreadId,
        model: existing?.currentModel ?? existing?.model ?? codexRec?.codexSettings?.model,
        effort: existing?.effort ?? codexRec?.codexSettings?.effort,
        permissionMode: codexMode && PERMISSION_MODES.has(codexMode) ? codexMode : undefined,
      }));
    }

    // Resume THIS session's specific conversation — its learned Claude id, or
    // failing that the exact transcript file it was tailing (basename = the
    // Claude session uuid). Crucially, do NOT fall back to `--continue` for a
    // known session: `--continue` resumes whatever conversation was most recent
    // in the cwd, so with several sessions in one directory it restarts the
    // WRONG one. `--continue` is only a last resort when we have nothing but a
    // cwd (recovery after the daemon lost the session entirely).
    // A fresh session's transcript path is pinned before Claude writes the
    // file (first turn). Resuming that uuid before any turn ran threw
    // "Session not found" and the failed replacement archived the card —
    // exactly when people restart (trust prompt, login screen) (#113). Only
    // a transcript that exists is a conversation to resume; otherwise the
    // replacement starts fresh under the same id.
    const tp = existing?.transcriptPath;
    const resumeId = existing?.claudeSessionId
      ?? (tp && existsSync(tp) ? basename(tp, ".jsonl") : undefined)
      ?? rec?.claudeSessionId;
    // Tear the process down WITHOUT archiving the card or deleting the
    // record, then come back under the SAME id. forceKill() archived the
    // relay card and minted a fresh id, so from the app "Restart" killed the
    // session you were looking at and spawned a stranger elsewhere in the
    // list — the app's handler had always assumed the identity survived.
    // The record still holds the v2 session id + content key, so the lane
    // rebinds the new process to the existing card.
    // The permission mode comes back too. Read it off the pane BEFORE the
    // window dies, else from the record (launch / last /permissions set):
    // omitting it made create() default to bypassPermissions, so a session
    // the user ran in plan or default mode restarted with every permission
    // silently granted (codex review, 2026-09-04).
    const claudeMode = existing?.detectPermissionMode() ?? (rec ?? loadWindowRecord(opts.id))?.claudePermissionMode ?? undefined;
    const carried = await this.#retire(existing, opts.id);

    // Env is refreshed automatically: create() launches claude through a fresh
    // login shell, so a restart re-sources the user's profile (.bashrc/.zshrc).
    // No resumable history (a record with no Claude uuid, a session that
    // never ran a turn): launch FRESH under the same id. `--continue` here
    // would resume whatever conversation is newest in the folder — someone
    // else's (Astra on 2f803b14, #113).
    return this.#replace(opts.id, cwd, carried, () => this.create({
      id: opts.id,
      cwd,
      resume_id: resumeId,
      model: existing?.currentModel ?? existing?.model,
      effort: existing?.effort,
      permissionMode: claudeMode && PERMISSION_MODES.has(claudeMode) ? claudeMode : undefined,
    }));
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

  async recover(): Promise<void> {
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
      const names = tmuxNamesFor(rec.socket, rec.id);
      if (run("tmux", "-L", rec.socket, "has-session", "-t", names.session).ok) {
        candidates.push({ winName: `j-${rec.id}`, target: names.target, drv: tmuxHandleFor(rec.socket, names.session), socket: rec.socket });
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
          tmux: socket ? drv : undefined,
          tmuxSocket: socket,
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

      // Bind to the file the previous daemon was ACTUALLY tailing first: the
      // checkpoint path is direct evidence, claudeSessionId is a belief. They
      // diverge whenever Claude is started with --resume/--continue: it writes a
      // NEW transcript under a new id while the record keeps the id we asked
      // for. Preferring the id bound a live session to its dead predecessor —
      // no output mirrored, no echo confirms (slash commands timed out and
      // PAUSED the queue), the goal bar frozen — and, with the checkpoint path
      // no longer matching, replayed the whole 150MB file from byte 0, firing
      // a burst of stale "done" pushes (faraz-vip b52bf522, 2026-09-03).
      // Then the id (BUG-6: never the newest-mtime file while a record exists —
      // that adopts an unrelated conversation). Heuristic only with no record.
      const ckptTranscript = rec?.transcriptCheckpoint?.path && existsSync(rec.transcriptCheckpoint.path)
        ? rec.transcriptCheckpoint.path
        : null;
      const recTranscript = ckptTranscript ?? (rec?.claudeSessionId
        ? join(cwdToTranscriptDir(cwd), `${rec.claudeSessionId}.jsonl`)
        : null);
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

    await this.#resurrectCodexOrphans();
    this.#sweepOrphanTmuxServers();
    resumeHandoffJobs(this);
  }

  /** Start a per-session server: session `<name>` with the agent's window
   *  pinned to `agent` (automatic-rename off, so the running command never
   *  renames it and `<name>:agent` stays a stable target while the user adds
   *  other windows beside it). Spawn, never control — the control client
   *  attaches to the session this creates. */
  async #newAgentServer(drv: TmuxDriver, session: string, cwd: string): Promise<boolean> {
    // A detached session (Claude exited, window sat at the shell) keeps its
    // per-session server alive; end("restart") on an already-ended session is
    // a no-op, so the restart's new-session failed with "duplicate session",
    // abortCreate killed the server and the card was archived — every first
    // Restart of a detached card (#42). Retire the stale server first.
    if (drv.runSync("has-session", "-t", session).ok) {
      process.stderr.write(`[create] ${session}: retiring stale per-session server before relaunch\n`);
      drv.runSync("kill-server");
    }
    // The previous server (end("restart") just killed it) may still be
    // releasing its socket: one short retry, and the tmux error is logged —
    // "session create failed: new-session" alone said nothing.
    let r = drv.runSync("new-session", "-d", "-s", session, "-n", TMUX_AGENT_WINDOW, "-x", "100", "-y", "40", "-c", cwd);
    if (!r.ok) {
      process.stderr.write(`[create] ${session}: new-session failed (${(r.error ?? r.out ?? "").trim().slice(0, 200)}) — retrying once\n`);
      await sleep(400); // the previous server may still be releasing its socket
      r = drv.runSync("new-session", "-d", "-s", session, "-n", TMUX_AGENT_WINDOW, "-x", "100", "-y", "40", "-c", cwd);
      if (!r.ok) { process.stderr.write(`[create] ${session}: new-session failed again (${(r.error ?? r.out ?? "").trim().slice(0, 200)})\n`); return false; }
    }
    drv.runSync("set-window-option", "-t", `${session}:${TMUX_AGENT_WINDOW}`, "automatic-rename", "off");
    drv.runSync("set-hook", "-t", session, "client-attached", CLIENT_ATTACHED_HOOK);
    return true;
  }

  /** Retire per-session tmux servers with NO window record (a crash between
   *  server-spawn and record write, or manual mischief). Conservative: only
   *  sockets matching OUR label scheme, only when no human client is
   *  attached. Never touches the shared server or foreign sockets. */
  #sweepOrphanTmuxServers(): void {
    try {
      const dir = process.env.TMUX_TMPDIR || `/tmp/tmux-${process.getuid?.() ?? ""}`;
      // Only OUR per-session label shapes (`joy-<8 hex>` and the legacy
      // `joy-<relayKey>-s-<8 hex>`): the shared server's socket is `joy-<relayKey>`
      // and must never be swept.
      const ours = /^joy-[0-9a-f]{8}$|-s-[0-9a-f]{8}$/;
      const known = new Set(listWindowRecords().map(r => r.socket).filter(Boolean));
      for (const name of (existsSync(dir) ? readdirSync(dir) : [])) {
        if (!ours.test(name) || known.has(name)) continue;
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
  async #resurrectCodexOrphans(): Promise<void> {
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
    // Antigravity: headless, one process per turn, so there is nothing that
    // can have died — a record with a conversation id IS the session. Recreate
    // it live; the next prompt resumes the conversation.
    // pi: the process died with the daemon, but `pi --session-id` resumes the
    // conversation; without this loop a pi record stayed on disk forever and
    // its card read "running" while every send answered session_not_found (#47).
    for (const rec of listWindowRecords()) {
      if (rec.agent !== "pi" || !rec.id || this.#sessions.has(rec.id)) continue;
      if (!existsSync(rec.launchCwd)) continue;
      const session = new PiSession({
        id: rec.id, cwd: rec.launchCwd,
        model: rec.piSettings?.model,
        piSessionId: rec.piSettings?.sessionId,
        status: "starting", startedAt: Date.now(),
      }, this.#sessionDeps());
      this.#sessions.set(rec.id, session);
      this.#attachRelayAsync(session, () => session.beginWatching());
      process.stderr.write(`[recover] pi ${rec.id} resumed session=${rec.piSettings?.sessionId ?? "(none yet)"}\n`);
    }
    for (const rec of listWindowRecords()) {
      if (rec.agent !== "agy" || !rec.id || this.#sessions.has(rec.id)) continue;
      if (!existsSync(rec.launchCwd)) continue;
      const session = new AgySession({
        id: rec.id, cwd: rec.launchCwd,
        model: rec.agySettings?.model,
        conversationId: rec.agySettings?.conversationId,
        status: "active", startedAt: Date.now(),
      }, this.#sessionDeps());
      this.#sessions.set(rec.id, session);
      this.#attachRelayAsync(session, () => session.beginWatching());
      process.stderr.write(`[recover] agy ${rec.id} resumed conversation=${rec.agySettings?.conversationId ?? "(none yet)"}\n`);
    }
    for (const rec of listWindowRecords()) {
      if (rec.agent !== "codex" || !rec.id || this.#sessions.has(rec.id)) continue;
      const sock = rec.codexSocketPath;
      const pid = rec.codexServerPid;
      if (!sock || !pid || !existsSync(sock) || !existsSync(rec.launchCwd)) continue;
      let cmdline = "";
      try { cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8"); } catch { continue; }
      if (!cmdline.includes("app-server") || !cmdline.includes(sock)) continue;

      // The TUI window is gone: give the session a fresh server of its own
      // (never the shared server — that layout is legacy-only now).
      const sockLabel = tmuxServerLabel(rec.id);
      const names = tmuxNamesFor(sockLabel, rec.id);
      run("tmux", "-L", sockLabel, "kill-server"); // a half-dead one from before, if any
      disposeTmuxHandle(sockLabel);
      const drv = tmuxHandleFor(sockLabel, names.session);
      if (!(await this.#newAgentServer(drv, names.session, rec.launchCwd))) { disposeTmuxHandle(sockLabel); continue; }
      const tmuxWindow = names.target;
      const shell = process.env.SHELL || "/bin/bash";
      drv.runSync("send-keys", "-t", tmuxWindow, "-l", `exec ${shell} -l`);
      drv.runSync("send-keys", "-t", tmuxWindow, "Enter");
      saveWindowRecord(rec.id, { launchCwd: rec.launchCwd, socket: sockLabel });

      const s = rec.codexSettings ?? {};
      const session = new CodexSession({
        id: rec.id, tmuxWindow, cwd: rec.launchCwd,
        tmux: drv, tmuxSocket: sockLabel,
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
