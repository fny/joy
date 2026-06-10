// Session: one Claude Code instance running in a tmux window, bridged to the
// Happy relay. Owns ALL per-session state that used to be scattered across
// eight parallel Maps in server.ts (relay session, transcript watcher, turn
// state, delivery receipts, pending attachments, prelaunch message buffer).
//
// The two invariants this class exists to enforce:
//   1. There is exactly ONE teardown path — end(reason). Every way a session
//      can die (app archive, RPC kill, HTTP DELETE, Claude process exit)
//      funnels through it, so cleanup steps can't be missed or mis-ordered.
//   2. There is exactly ONE send path — sendText(). Every transport (relay
//      message, HTTP /send, machine RPC) gets the same semantics: messages
//      sent while Claude is still booting are buffered and flushed when the
//      first transcript entry lands.

import { existsSync, readFileSync } from "fs";
import { run } from "./shell";
import {
  encodeTurnStart,
  encodeTextEvent,
  encodeToolCallStart,
  encodeToolCallEnd,
  encodeTurnEnd,
  encodeUserMessage,
  type RelayClient,
  type RelaySession,
} from "./relay.ts";
import {
  initDeliveryState,
  recordInboundReceipt,
  recordOutboundReceipt,
  type DeliveryState,
  type DeliverySource,
} from "./receipts";
import { writeAttachmentToCwd } from "./attachments";
import { cwdToTranscriptDir, findLatestTranscript, tailJsonl, type TranscriptTailer } from "./transcript";
import { parseKeyScript } from "./keyTokens";

export type SessionStatus = "starting" | "active" | "ended";

/** Wire shape — frozen. The app and the debug page consume this JSON. */
export interface SessionRecord {
  id: string;
  claude_session_id?: string;
  pid?: number;
  tmux_window: string;
  cwd: string;
  model?: string;
  effort?: string;
  flags: string[];
  status: SessionStatus;
  started_at: number;
  last_active_at: number;
  end_reason?: string;
  transcript_path?: string;
  relay_session_id?: string;
}

export interface ChatMessage {
  role: "user" | "assistant" | "event";
  content: string;
  source: "web" | "cli" | "rpc";
  chat_id?: string;
  session_id?: string;
  event_type?: string;
  event_status?: "info" | "success" | "error" | "warning";
}

/** Capabilities a Session needs from its environment, injected by the registry. */
export interface SessionDeps {
  relayClient: RelayClient | null;
  broadcast(event: string, data: unknown): void;
  addChatMessage(msg: ChatMessage): void;
  /** Called when a relay session is attached — the place to register session-scoped ops. */
  onRelayAttached?: (session: Session, rs: RelaySession) => void;
}

export interface SendOptions {
  seq?: number;
  source: DeliverySource;
  /** Mirror the message to the relay so the app's chat history shows it (web/rpc sends). */
  mirrorToRelay: boolean;
}

interface BufferedMessage extends SendOptions {
  text: string;
}

export interface SessionInit {
  id: string;
  tmuxWindow: string;
  cwd: string;
  model?: string;
  effort?: string;
  flags: string[];
  status: SessionStatus;
  startedAt: number;
  pid?: number;
  claudeSessionId?: string;
  transcriptPath?: string;
}

export class Session {
  readonly id: string;
  readonly tmuxWindow: string;
  readonly cwd: string;
  readonly model?: string;
  readonly effort?: string;
  readonly flags: string[];
  status: SessionStatus;
  startedAt: number;
  lastActiveAt: number;
  pid?: number;
  endReason?: string;
  claudeSessionId?: string;
  transcriptPath?: string;
  /** Survives relay detach so end() can still archive server-side. */
  relaySessionId?: string;

  #deps: SessionDeps;
  #relay: RelaySession | null = null;
  #tailer: TranscriptTailer | null = null;
  #turn: { turnId: string } | null = null;
  #delivery: DeliveryState | null = null;
  #pendingAttachments: Promise<Uint8Array | null>[] = [];
  #prelaunchBuffer: BufferedMessage[] = [];
  #promptPollActive = false;

  constructor(init: SessionInit, deps: SessionDeps) {
    this.id = init.id;
    this.tmuxWindow = init.tmuxWindow;
    this.cwd = init.cwd;
    this.model = init.model;
    this.effort = init.effort;
    this.flags = init.flags;
    this.status = init.status;
    this.startedAt = init.startedAt;
    this.lastActiveAt = Date.now();
    this.pid = init.pid;
    this.claudeSessionId = init.claudeSessionId;
    this.transcriptPath = init.transcriptPath;
    this.#deps = deps;
  }

  get relayAttached(): boolean {
    return this.#relay !== null;
  }

  get watcherActive(): boolean {
    return this.#tailer !== null;
  }

  /** Frozen snake_case wire shape (app metadata + debug page + RPC results). */
  toJSON(): SessionRecord {
    return {
      id: this.id,
      claude_session_id: this.claudeSessionId,
      pid: this.pid,
      tmux_window: this.tmuxWindow,
      cwd: this.cwd,
      model: this.model,
      effort: this.effort,
      flags: this.flags,
      status: this.status,
      started_at: this.startedAt,
      last_active_at: this.lastActiveAt,
      end_reason: this.endReason,
      transcript_path: this.transcriptPath,
      relay_session_id: this.relaySessionId,
    };
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  /** Start transcript discovery + PID-death polling. Call once after construction. */
  beginWatching(): void {
    this.pollForTranscript();
    this.#pollEnd();
  }

  /**
   * Wire a relay session: message/file-event callbacks, session-scoped op
   * registration (via deps hook), heartbeats. The ONE wiring path — used by
   * launch, recovery, and relay-reconnect alike.
   * Returns false (and stops the relay session) if this session already ended,
   * guarding against kill racing the async relay creation.
   */
  attachRelay(rs: RelaySession): boolean {
    if (this.status === "ended") {
      rs.stop();
      return false;
    }
    this.#relay = rs;
    this.relaySessionId = rs.relaySessionId;

    // File events arrive ahead of the user-text message. Kick off the
    // download/decrypt immediately; the next message drains the bucket.
    rs.onFileEvent = (ev) => {
      if (!this.#deps.relayClient) return;
      const { sessionKey, variant } = rs.encryptionMaterial;
      this.#pendingAttachments.push(
        this.#deps.relayClient.downloadAndDecryptAttachment(rs.relaySessionId, ev.ref, sessionKey, variant),
      );
    };

    rs.onMessage = async (text, seq) => {
      await this.#onRelayMessage(text, seq);
    };

    this.#deps.onRelayAttached?.(this, rs);
    rs.start();
    this.#deps.broadcast("session_update", this.toJSON());
    return true;
  }

  /**
   * The ONE teardown path. Ordered: stop transcript tailer → stop relay
   * heartbeats → archive server-side (flips active=false so the app drops
   * the session from the active list; mirrors happy-cli's deactivateSession)
   * → kill tmux window (only for explicit kills — process_exited means the
   * pane already returned to bash, which we leave for inspection) → mark
   * ended → broadcast.
   */
  end(reason: "killed" | "process_exited"): boolean {
    if (this.status === "ended") return false;

    // Capture before detaching the relay — needed for the archive POST.
    const relaySessionId = this.#relay?.relaySessionId ?? this.relaySessionId;

    this.#tailer?.close();
    this.#tailer = null;
    this.#turn = null;
    this.#delivery = null;
    this.#relay?.stop();
    this.#relay = null;

    if (this.#deps.relayClient && relaySessionId) {
      void this.#deps.relayClient.archiveSession(relaySessionId);
    }

    if (reason === "killed") {
      run("tmux", "kill-window", "-t", this.tmuxWindow);
    }

    this.status = "ended";
    this.endReason = reason;
    this.lastActiveAt = Date.now();
    this.#deps.broadcast("session_update", this.toJSON());
    return true;
  }

  // ── Op verbs ────────────────────────────────────────────────────────────────

  /**
   * The ONE send path. Buffers while Claude is still booting (status
   * 'starting') — send-keys during that window would land in bash or a
   * trust-prompt dialog and be lost/misinterpreted. Buffered messages flush
   * when Claude's ready prompt appears in the pane (see #pollPromptReady) or
   * when the first transcript entry lands, whichever comes first.
   */
  sendText(text: string, opts: SendOptions): { buffered: boolean } {
    if (this.status === "starting") {
      this.#prelaunchBuffer.push({ text, ...opts });
      this.#pollPromptReady();
      return { buffered: true };
    }
    this.#typeIntoTmux(text, opts);
    return { buffered: false };
  }

  /** Escape → Claude Code interactive interprets as "interrupt generation". */
  abort(): { ok: true } {
    run("tmux", "send-keys", "-t", this.tmuxWindow, "Escape");
    this.#relay?.setThinking(false);
    return { ok: true };
  }

  /**
   * Raw intervention path: parse a bracketed key script (see keyTokens.ts —
   * `git commit<Enter>oops<C-c>`) and replay it into the pane verbatim.
   * Unlike sendText this does NOT buffer, record receipts, mirror to the
   * relay, or auto-append Enter — it is a direct keyboard, for poking at
   * trust prompts, TUI menus, or a wedged claude. Consecutive named keys
   * are batched into one tmux call; literal runs are sent with -l so tmux
   * doesn't interpret them.
   */
  sendRawKeys(script: string): { ok: boolean; segments: number; error?: string } {
    const segments = parseKeyScript(script);
    let pendingKeys: string[] = [];
    const flushKeys = () => {
      if (pendingKeys.length === 0) return true;
      const ok = run("tmux", "send-keys", "-t", this.tmuxWindow, ...pendingKeys).ok;
      pendingKeys = [];
      return ok;
    };
    for (const seg of segments) {
      if (seg.type === "key") {
        pendingKeys.push(seg.key);
        continue;
      }
      if (!flushKeys()) return { ok: false, segments: segments.length, error: "tmux send-keys failed" };
      if (!run("tmux", "send-keys", "-l", "-t", this.tmuxWindow, seg.text).ok) {
        return { ok: false, segments: segments.length, error: "tmux send-keys failed" };
      }
    }
    if (!flushKeys()) return { ok: false, segments: segments.length, error: "tmux send-keys failed" };
    return { ok: true, segments: segments.length };
  }

  pane(): { ok: true; text: string } {
    return { ok: true, text: run("tmux", "capture-pane", "-p", "-t", this.tmuxWindow).out };
  }

  transcript(): { lines: unknown[] } {
    if (!this.transcriptPath || !existsSync(this.transcriptPath)) return { lines: [] };
    const lines = readFileSync(this.transcriptPath, "utf-8").split("\n").slice(0, -1)
      .filter((l) => l.trim())
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
    return { lines };
  }

  // ── Relay message handling ──────────────────────────────────────────────────

  async #onRelayMessage(text: string, seq: number): Promise<void> {
    // Drain attachments first so paths can be appended to this turn's text.
    // Atomic swap: take the bucket, replace with an empty one so any
    // late-arriving file event lands in the next batch (matches happy-cli's
    // drainAttachmentsForUserMessage swap-then-await order).
    const drained = this.#pendingAttachments;
    this.#pendingAttachments = [];
    let augmented = text;
    if (drained.length > 0) {
      const results = await Promise.all(drained);
      const paths: string[] = [];
      for (const bytes of results) {
        if (!bytes) continue;
        const refPath = writeAttachmentToCwd(this.cwd, bytes);
        if (refPath) paths.push(refPath);
      }
      if (paths.length > 0) {
        // Bare relative paths appended after the text, space-separated.
        // tmux send-keys -l + Enter sends a single line, so line breaks
        // can't be preserved. Claude resolves them against the session cwd
        // and reads each file as an image.
        augmented = text + " " + paths.join(" ");
      }
    }
    // mirrorToRelay: false — the message came FROM the relay; the app already
    // has it in the chat history.
    this.sendText(augmented, { seq, source: "relay", mirrorToRelay: false });
  }

  #ensureDelivery(): DeliveryState | null {
    if (!this.relaySessionId) return null;
    if (!this.#delivery) this.#delivery = initDeliveryState(this.relaySessionId);
    return this.#delivery;
  }

  /** Type a message into the pane + record receipt + bump thinking. */
  #typeIntoTmux(text: string, opts: SendOptions): void {
    const delivery = this.#ensureDelivery();
    if (delivery) {
      delivery.pending.push({ seq: opts.seq, text, source: opts.source, at: Date.now() });
    }
    const r = run("tmux", "send-keys", "-l", "-t", this.tmuxWindow, text.replace(/\n/g, " "));
    if (!r.ok) {
      delivery?.pending.pop();
      throw new Error("tmux send-keys failed");
    }
    run("tmux", "send-keys", "-t", this.tmuxWindow, "Enter");
    if (opts.mirrorToRelay) {
      this.#relay?.send(encodeUserMessage(text));
    }
    this.#relay?.setThinking(true);
    if (!this.#tailer && this.status !== "ended") this.pollForTranscript();
  }

  #flushPrelaunch(): void {
    const buffered = this.#prelaunchBuffer;
    this.#prelaunchBuffer = [];
    for (const m of buffered) {
      try {
        this.#typeIntoTmux(m.text, m);
      } catch (e) {
        process.stderr.write(`[prelaunch] flush failed for ${this.id}: ${e}\n`);
      }
    }
  }

  /**
   * Resolve the chicken-and-egg of a brand-new project directory: the
   * transcript JSONL only appears after Claude receives its first message,
   * but buffered messages only flushed on the first transcript entry — so a
   * fresh session would deadlock in 'starting' forever. Poll the pane for
   * Claude's ready input prompt and flush the buffer the moment it shows.
   * Transcript-entry activation remains the authoritative status flip.
   */
  #pollPromptReady(): void {
    if (this.#promptPollActive) return;
    this.#promptPollActive = true;
    const tick = () => {
      if (this.status === "ended" || this.#prelaunchBuffer.length === 0) {
        this.#promptPollActive = false;
        return;
      }
      if (this.status === "active") {
        // Transcript entry beat us to it — its activation already flushed.
        this.#promptPollActive = false;
        this.#flushPrelaunch();
        return;
      }
      const pane = run("tmux", "capture-pane", "-p", "-t", this.tmuxWindow);
      if (pane.ok && paneShowsReadyPrompt(pane.out)) {
        this.#promptPollActive = false;
        this.#flushPrelaunch();
        return;
      }
      setTimeout(tick, 700);
    };
    setTimeout(tick, 700);
  }

  // ── Transcript watching ─────────────────────────────────────────────────────

  // M4: 120 attempts × 500ms = 60s window, enough for slow first-runs
  // (trust prompts etc.)
  pollForTranscript(attempts = 0): void {
    if (this.#tailer || this.status === "ended") return;
    const path = findLatestTranscript(cwdToTranscriptDir(this.cwd), this.startedAt);
    if (path) {
      this.startTailer(path);
      return;
    }
    if (attempts < 120) {
      setTimeout(() => this.pollForTranscript(attempts + 1), 500);
    } else {
      process.stderr.write(`[transcript] WARN: no transcript found for ${this.id} after 60s — assistant output will not reach the relay\n`);
    }
  }

  /**
   * Attach (or with force=true, re-attach) the JSONL tailer. force is the
   * seam for the future /branch//fork/--resume handling, where Claude rotates
   * its session id and starts writing a new transcript file.
   */
  startTailer(transcriptPath: string, force = false): void {
    if (this.#tailer) {
      if (!force) return;
      this.#tailer.close();
      this.#tailer = null;
    }
    this.transcriptPath = transcriptPath;
    this.#tailer = tailJsonl(
      transcriptPath,
      (entry) => {
        this.onTranscriptEntry(entry);
        this.#deps.broadcast("transcript_entry", { session_id: this.claudeSessionId, entry });
      },
      () => this.status !== "ended",
    );
  }

  /** PID-death detection: poll every 5s; on exit, run the full teardown. */
  #pollEnd(): void {
    if (this.status === "ended") return;
    if (this.pid !== undefined && !run("kill", "-0", String(this.pid)).ok) {
      this.end("process_exited");
      return;
    }
    setTimeout(() => this.#pollEnd(), 5000);
  }

  // ── Transcript entry semantics ──────────────────────────────────────────────

  onTranscriptEntry(entry: Record<string, unknown>): void {
    const entryType = String(entry.type || "");

    // First entry activates the session — Claude is now reading the pane,
    // so flush any messages buffered during boot.
    if (this.status === "starting") {
      const sid = String(entry.sessionId || "");
      if (sid) {
        this.claudeSessionId = sid;
        this.status = "active";
        this.lastActiveAt = Date.now();
        this.#deps.broadcast("session_update", this.toJSON());
        this.#flushPrelaunch();
      }
    }

    const sid = this.claudeSessionId;

    // Turn complete → send turn-end and clear turn state
    if (entryType === "system" && entry.subtype === "stop_hook_summary") {
      this.#deps.broadcast("stop", { session_id: sid });
      if (this.#relay && this.#turn) {
        this.#relay.send(encodeTurnEnd("completed", { turn: this.#turn.turnId }));
      }
      this.#turn = null;
      this.#relay?.setThinking(false);
      return;
    }

    if (entryType !== "user" && entryType !== "assistant") return;

    const msg = entry.message as Record<string, unknown> | undefined;
    if (!msg) return;

    const role = String(msg.role || "");
    const content = msg.content;

    if (role === "user") {
      if (entry.isMeta) return;
      if (typeof content !== "string") {
        // Emit tool-call-end events for tool results
        if (this.#relay && this.#turn && Array.isArray(content)) {
          for (const item of content as Array<Record<string, unknown>>) {
            if (item.type === "tool_result" && typeof item.tool_use_id === "string") {
              this.#relay.send(encodeToolCallEnd(item.tool_use_id, { turn: this.#turn.turnId }));
            }
          }
        }
        return;
      }
      // skip slash command wrappers injected by the CLI
      if (content.startsWith("<local-command") || content.startsWith("<command-name>")) return;

      // Match this transcript entry against the front of the pending-send
      // queue. Identical messages are matched sequentially: two "yes" sends
      // pair with two "yes" transcript entries in order.
      const uuid = typeof entry.uuid === "string" ? entry.uuid : "";
      const delivery = this.#relay && uuid ? this.#ensureDelivery() : null;
      if (delivery && this.relaySessionId) {
        const front = delivery.pending[0];
        if (front && front.text === content) {
          delivery.pending.shift();
          recordInboundReceipt(delivery, this.relaySessionId, {
            seq: front.seq, uuid, text: content, source: front.source, at: Date.now(),
          });
          return; // self-echo of a relay/HTTP/RPC send — don't double-record locally
        }
        // No queue match → direct typing in the tmux pane. Skip if we already
        // forwarded it (recovery), otherwise mirror it to the relay so the app
        // sees the full conversation.
        if (!delivery.forwardedUuids.has(uuid)) {
          this.#relay!.send(encodeUserMessage(content));
          recordOutboundReceipt(delivery, this.relaySessionId, { uuid, turn: "", at: Date.now() });
        }
      }
      this.#deps.addChatMessage({ role: "user", content, source: "cli", session_id: sid });

    } else if (role === "assistant") {
      const blocks = Array.isArray(content) ? content as Array<Record<string, unknown>> : [];
      const entryUuid = typeof entry.uuid === "string" ? entry.uuid : "";
      // Skip if we've already forwarded this transcript entry (recovery case).
      if (this.#relay && entryUuid) {
        const delivery = this.#ensureDelivery();
        if (delivery?.forwardedUuids.has(entryUuid)) return;
      }
      if (this.#relay && blocks.length > 0) {
        // Ensure a turn is open; send turn-start on the first assistant entry per turn
        if (!this.#turn) {
          this.#turn = { turnId: crypto.randomUUID() };
          this.#relay.send(encodeTurnStart({ turn: this.#turn.turnId }));
        }
        const opts = { turn: this.#turn.turnId, claudeUuid: entryUuid || undefined };
        for (const block of blocks) {
          const blockType = String(block.type || "");
          if (blockType === "text") {
            const text = String(block.text || "").trim();
            if (text) this.#relay.send(encodeTextEvent(text, opts));
          } else if (blockType === "tool_use") {
            this.#relay.send(encodeToolCallStart({
              call: String(block.id || crypto.randomUUID()),
              name: String(block.name || "tool"),
              input: block.input,
              ...opts,
            }));
          }
        }
        // Record outbound receipt — we forwarded this transcript entry to the relay.
        const delivery = this.#ensureDelivery();
        if (entryUuid && delivery && this.relaySessionId) {
          recordOutboundReceipt(delivery, this.relaySessionId, {
            uuid: entryUuid, turn: this.#turn.turnId, at: Date.now(),
          });
        }
        // M3: send turn-end when the assistant finishes — don't require a
        // Stop hook. end_turn = normal completion; tool_use = more tool
        // calls pending (no turn-end yet).
        const stopReason = String(msg.stop_reason || "");
        if (stopReason === "end_turn" || stopReason === "max_tokens") {
          this.#relay.send(encodeTurnEnd("completed", { turn: this.#turn.turnId }));
          this.#turn = null;
          this.#relay.setThinking(false);
          this.#deps.broadcast("stop", { session_id: sid });
        }
      }
      for (const block of blocks) {
        const blockType = String(block.type || "");
        if (blockType === "text") {
          const text = String(block.text || "").trim();
          if (text) this.#deps.addChatMessage({ role: "assistant", content: text, source: "cli", session_id: sid });
        } else if (blockType === "tool_use") {
          const name = String(block.name || "tool");
          const detail = summarizeInput(block.input);
          this.#deps.addChatMessage({
            role: "event",
            content: detail ? `▶ ${name}: ${detail}` : `▶ ${name}`,
            source: "cli",
            event_type: "tool_use",
            event_status: "info",
            session_id: sid,
          });
        }
      }
    }
  }
}

/**
 * True when the pane shows Claude's interactive input prompt: a line whose
 * trimmed content starts with "❯" — EXCLUDING selector dialogs (folder-trust
 * prompt, /model picker, etc.) which render options as "❯ 1. Yes, …".
 * Ghost-text suggestions like `❯ Try "refactor <filepath>"` count as ready.
 */
export function paneShowsReadyPrompt(text: string): boolean {
  return text.split("\n").some(line => {
    const t = line.trim();
    if (!t.startsWith("❯")) return false;
    return !/^❯\s*\d+\./.test(t);
  });
}

function summarizeInput(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const inp = input as Record<string, unknown>;
  if (typeof inp.command === "string") return inp.command.split("\n")[0].slice(0, 70);
  if (typeof inp.file_path === "string") return inp.file_path;
  if (typeof inp.pattern === "string") return inp.pattern;
  return JSON.stringify(input).slice(0, 70);
}
