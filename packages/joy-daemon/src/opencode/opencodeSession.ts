// OpencodeSession — the tmux-free AgentSession for opencode (design:
// docs/plans/opencode-adapter-design.md). One `opencode serve` per session
// (ephemeral localhost port), driven over HTTP/SSE; NO tmux window at all —
// pane()/sendRawKeys degrade gracefully and the app hides terminal affordances
// for flavor 'opencode'.
//
// Durability model (simpler than codex BY CONSTRUCTION — verified live):
//  - opencode persists sessions server-side per project dir: a cold server
//    restart lists the same session with full history, so recovery = spawn a
//    fresh server in the cwd and GET /message. No orphan-rejoin dance needed
//    (we still reap a recorded live server pid on takeover).
//  - part ids are STABLE live-vs-history → deterministic localIds alone give
//    exactly-once at the relay append layer; no delivered-turn checkpoint.
//  - inbound: durable spool before the socket write (reused codex store),
//    deterministic msg_ prompt id per relay seq (idempotent), delivery:'queue'
//    (opencode queues natively while busy).
//  - silent-drop guard: a prompt admitted with no idle within the wait
//    deadline surfaces an error note instead of hanging forever.

import { randomUUID } from "crypto";
import { type ChildProcess } from "child_process";
import { saveWindowRecord, deleteWindowRecord, loadWindowRecord } from "../domain/windowRecord";
import {
  createRelaySession, encodeUserMessage, encodeTurnEnd,
  encodeTurnStart, encodeTextEvent, encodeToolCallStart, encodeToolCallEnd,
  type RelaySession,
} from "../relay/relay";
import type { SessionDeps, SessionStatus, SessionRecord, QueuedMessage, QueueState } from "../claude/session";
import type { DeliverySource } from "../domain/agentSession";
import type { AgentSession } from "../domain/agentSession";
import { spawnOpencodeServer, OpencodeClient, isOpencodeServerPid, killOpencodeServerPid } from "./opencodeClient";
import { OpencodeNormalizer, type OpencodeEffect } from "./normalize";
import { opencodeJoyPreamble, joyPromptReinjection } from "../domain/agentTagsPrompt";
import { ledgerFor, type Ledger } from "../domain/ledger";
import { coordinatorFor, type SessionCoordinator, type CommandView, type HandledCommand } from "../domain/coordinator";
import { OpencodeDriver, type OpencodeRuntimePort } from "./opencodeDriver";

export interface OpencodeInit {
  id: string;
  cwd: string;
  model?: string;          // full provider model id, e.g. accounts/fireworks/models/kimi-k3
  providerID?: string;     // e.g. fireworks-ai
  status: SessionStatus;
  startedAt: number;
  /** Resume an existing opencode session (recovery). */
  opencodeSessionId?: string;
  /** Reap this recorded server pid on takeover (recovery). */
  opencodeServerPid?: number;
  /** Continue: resume the newest existing opencode session in this cwd
   *  (ignored when opencodeSessionId is set). Falls back to a fresh session
   *  when the cwd has none. */
  continueLast?: boolean;
}

/** Newest session for a cwd from GET /api/session. The directory filter is
 *  load-bearing: non-git dirs all share opencode's "global" project, so the
 *  list commingles sessions from unrelated directories. */
export function pickNewestSessionForCwd(
  sessions: Array<Record<string, unknown>>,
  cwd: string,
): string | null {
  const dir = (s: Record<string, unknown>): string =>
    String((s.location as Record<string, unknown> | undefined)?.directory ?? "");
  const updated = (s: Record<string, unknown>): number => {
    const t = s.time as Record<string, unknown> | undefined;
    return Number(t?.updated ?? t?.created ?? 0);
  };
  const mine = sessions.filter((s) => dir(s) === cwd);
  if (!mine.length) return null;
  mine.sort((a, b) => updated(b) - updated(a));
  return String(mine[0].id ?? "") || null;
}

/** Card title from the first user prompt: opencode's own title generation
 *  never runs on the serve path (placeholder "New session - <date>" forever),
 *  so joy derives one — first line, clipped to 60 chars on a word boundary. */
export function titleFromPrompt(text: string): string {
  // A prompt that arrived from another session is wrapped in <joy-message …>;
  // the title must come from what was SAID, not the wrapper (an Antigravity
  // session was titled "joy-message from=joy:b52bf522 from-label=…").
  const body = text.trim().replace(/^<joy-message\b[^>]*>\s*/i, "").replace(/\s*<\/joy-message>\s*$/i, "");
  const line = body.trim().split("\n")[0].replace(/\s+/g, " ");
  if (line.length <= 60) return line;
  const cut = line.slice(0, 60);
  const sp = cut.lastIndexOf(" ");
  return (sp > 30 ? cut.slice(0, sp) : cut) + "…";
}

/** Order history oldest-first (GET /message returns NEWEST-first) and drop
 *  everything at or before the delivered checkpoint, so restart replay cost is
 *  O(gap) instead of O(history). Unknown checkpoint (foreign session, server
 *  rewound) → full list; localId dedupe makes that safe, just not free. */
export function messagesForReplay(
  msgs: Array<Record<string, unknown>>,
  deliveredThrough?: string,
): Array<Record<string, unknown>> {
  const time = (m: Record<string, unknown>): number =>
    Number((m.time as Record<string, unknown> | undefined)?.created ?? 0);
  const asc = [...msgs].sort((a, b) => time(a) - time(b));
  if (!deliveredThrough) return asc;
  const at = asc.findIndex((m) => String(m.id ?? "") === deliveredThrough);
  return at >= 0 ? asc.slice(at + 1) : asc;
}

const WAIT_TIMEOUT_MS = 10 * 60_000;

// The full joy tag vocabulary rides the FIRST prompt of a fresh session
// (config `instructions` — like `permission` — is present-but-ignored on the
// v2 serve path, verified 2026-08-03). Persists in server-side context.

export class OpencodeSession implements AgentSession {
  readonly agentFlavor = "opencode" as const;
  readonly id: string;
  readonly cwd: string;
  readonly model?: string;
  readonly effort?: string = undefined;
  status: SessionStatus;
  endReason?: string;
  claudeSessionId?: string = undefined;
  transcriptPath?: string = undefined;
  relaySessionId?: string;
  summary?: string;
  currentModel?: string;
  pid?: number;                       // opencode server pid
  readonly tmuxWindow = "";           // no tmux window — capability absent

  #providerID?: string;
  #startedAt: number;
  #deps: SessionDeps;
  #client: OpencodeClient | null = null;
  #proc: ChildProcess | null = null;
  #relay: RelaySession | null = null;
  #norm: OpencodeNormalizer | null = null;
  #ocSessionId: string | null = null;
  #resumeOcSessionId?: string;
  #reapPid?: number;
  #thinking = false;
  #started = false;
  #activeTurn: string | null = null;
  #archivePromise: Promise<boolean> | null = null;
  // Durable inbound queue: ledger commands the coordinator owns; this
  // session's driver POSTs them (each prompt is an attempt committed before
  // the request goes out).
  #ledger: Ledger;
  #generation: number;
  #coordinator: SessionCoordinator;
  #driver: OpencodeDriver;
  #unsubscribeQueue: () => void = () => {};
  /** The message id most recently admitted (HTTP ack or SSE confirm). */
  #lastAdmitted: string | null = null;
  // Reconcile checkpoint — `checkpoints(kind='opencode_msg')` in the ledger:
  // last message id fully delivered to the relay, committed only once its
  // outbox rows are acked. Advanced on live turn completion and after
  // reconcile replay.
  #deliveredThrough?: string;
  #continueLast = false;
  // First-prompt auto-title fires once, and only for sessions whose card is
  // NEW (fresh create / continue). Resume/recovery reattaches an existing
  // card that already carries its title — never retitle those.
  #titled = false;
  // /title lock: a user-set title beats agent <joy-title> emissions.
  #titleLocked = false;
  // Send the title preamble with the first prompt of a FRESH oc session.
  #needsPreamble = false;
  // Set when continue actually resolved to an existing session (drives the
  // reconcile backfill; a fresh fallback session has nothing to replay).
  #continuedInto = false;

  constructor(init: OpencodeInit, deps: SessionDeps) {
    this.id = init.id;
    this.cwd = init.cwd;
    this.model = init.model;
    this.status = init.status;
    this.#providerID = init.providerID;
    this.#startedAt = init.startedAt;
    this.#deps = deps;
    this.#resumeOcSessionId = init.opencodeSessionId;
    this.#reapPid = init.opencodeServerPid;
    this.#continueLast = init.continueLast === true;
    this.#titled = init.opencodeSessionId != null;
    this.#titleLocked = loadWindowRecord(init.id)?.titleLockedByUser === true;
    // The ledger is opened before the relay starts pulling; a new generation
    // closes the previous one (its in-flight prompts become `unknown`).
    this.#ledger = deps.ledger ?? ledgerFor();
    this.#generation = this.#ledger.openGeneration(init.id, "opencode");
    this.#deliveredThrough = init.opencodeSessionId ? (this.#ledger.getCheckpoint(init.id, "opencode_msg")?.ref || undefined) : undefined; // "" = pending, nothing committed
    if (!init.opencodeSessionId) {
      this.#ledger.clearCheckpoint(init.id, "opencode_msg");
      // A fresh opencode session under this id: nothing queued for an earlier
      // one can run here.
      for (const r of this.#ledger.listPending(init.id)) this.#ledger.transition(r.id, ["queued", "submitting", "accepted", "unknown", "running", "cancelling"], "interrupted", { terminalReason: "fresh_session" });
    }
    this.#coordinator = deps.coordinator ?? coordinatorFor(this.#ledger);
    // Adopted before the relay pull can start; the pump waits for `ready`.
    this.#driver = new OpencodeDriver(this.#runtimePort(), this.#generation);
    this.#coordinator.adopt(this.id, this.#driver);
    this.#unsubscribeQueue = this.#coordinator.subscribe((ev) => {
      if (ev.type !== "session" && ev.type !== "command") return;
      if (ev.sessionId !== this.id || !this.#relay) return;
      void this.#relay.updateQueue(this.#coordinator.snapshot(this.id));
    });
  }

  #runtimePort(): OpencodeRuntimePort {
    return {
      sessionId: this.id,
      client: () => (this.status === "ended" ? null : this.#client),
      ocSessionId: () => this.#ocSessionId,
      currentTurn: () => this.#norm?.currentTurn ?? null,
      lastAdmitted: () => this.#lastAdmitted,
      takePreamble: () => { if (!this.#needsPreamble) return ""; this.#needsPreamble = false; return opencodeJoyPreamble(); },
      turnInterrupted: () => { if (this.#activeTurn) this.#endTurn(this.#activeTurn, "cancelled"); },
      handleCommand: (text, opts) => this.#handleCommand(text, opts),
      mirrorAccepted: (cmd) => this.#mirrorAccepted(cmd),
    };
  }

  /** Test/diagnostic access to the session's ledger generation. */
  get ledgerGeneration(): number { return this.#generation; }
  get coordinator(): SessionCoordinator { return this.#coordinator; }

  get relayAttached(): boolean { return this.#relay !== null; }
  get opencodeSessionId(): string | undefined { return this.#ocSessionId ?? this.#resumeOcSessionId; }

  // ── lifecycle ──────────────────────────────────────────────────────────────

  attachRelay(rs: RelaySession, allowEnded = false): boolean {
    if (this.status === "ended" && !allowEnded) return false;
    this.#relay = rs;
    this.relaySessionId = rs.relaySessionId;
    if (this.status === "ended") rs.pausePull();
    rs.setReceiptSink(() => { /* exactly-once rides localId dedupe; no checkpoint */ });
    this.#deps.onRelayAttached?.(this, rs);
    rs.start();
    void rs.updateJoyState(this.status === "ended" ? "detached" : "running");
    return true;
  }

  beginWatching(): void {
    if (this.#started) return;
    this.#started = true;
    void this.#start();
  }

  async #start(): Promise<void> {
    try {
      // Takeover: if a recorded server is verifiably alive, reap it — we always
      // spawn fresh (sessions persist server-side; a fresh server is simpler
      // and safer than rejoining an unknown-state one).
      if (this.#reapPid && isOpencodeServerPid(this.#reapPid)) {
        const gone = await killOpencodeServerPid(this.#reapPid); // gone before a replacement opens the same conversation (#71)
        if (!gone) throw new Error(`recorded opencode server ${this.#reapPid} could not be stopped — not starting a second one`);
      }
      // Killed while we waited for the reap: this generation must not spawn.
      if (this.status === "ended") return;
      const { proc, port } = spawnOpencodeServer(this.cwd, { joySessionId: this.id });
      this.#proc = proc;
      proc.on("exit", () => { if (this.status !== "ended") this.end("process_exited"); });
      proc.on("error", () => { if (this.status !== "ended") this.end("process_exited"); });
      const p = await port;
      this.pid = proc.pid;
      const client = new OpencodeClient(p);
      this.#client = client;

      if (this.#resumeOcSessionId) {
        this.#ocSessionId = this.#resumeOcSessionId;
      } else {
        if (this.#continueLast) {
          try {
            const found = pickNewestSessionForCwd(await client.request("GET", "/api/session").then((r) => ((r as { data?: Array<Record<string, unknown>> })?.data ?? [])), this.cwd);
            if (found) {
              this.#ocSessionId = found;
              this.#continuedInto = true;
              process.stderr.write(`[opencode ${this.id}] continue: resuming newest session ${found} in ${this.cwd}\n`);
            }
          } catch (e) { process.stderr.write(`[opencode ${this.id}] continue lookup failed (${e}) — starting fresh\n`); }
        }
        if (!this.#ocSessionId) {
          const s = await client.createSession();
          this.#ocSessionId = s.id;
          this.#needsPreamble = true;
        }
      }
      this.#norm = new OpencodeNormalizer(this.#ocSessionId);
      client.onEvent((e) => {
        this.touchTurnActivity();
        if (this.#norm) this.#applyEffects(this.#norm.handle(e));
      });
      client.subscribeEvents();

      if (this.model && this.#providerID) {
        try {
          await client.switchModel(this.#ocSessionId, this.#providerID, this.model);
          this.currentModel = this.model;
          void this.#relay?.updateModelCode(this.model);
        } catch (e) { process.stderr.write(`[opencode ${this.id}] model switch failed: ${e}\n`); }
      }

      // Backfill for every non-fresh session: explicit resume AND continue.
      if (this.#resumeOcSessionId || this.#continuedInto) await this.#reconcileHistory();

      this.#persistRecord();
      if (this.status === "starting") this.status = "active";
      this.#deps.broadcast("session_update", this.toJSON());
      // The server is up and history replayed: the coordinator reconciles
      // anything still unknown (our message ids in the session's messages)
      // and pumps the queued rows.
      this.#driver.emit({ kind: "ready" });
    } catch (e) {
      process.stderr.write(`[opencode ${this.id}] start failed: ${e}\n`);
      this.end("process_exited");
    }
  }

  /** Commit the delivered-through mark, pending until every outbox row of
   *  this session so far is acked (#67); a restart before that replays from
   *  the previous mark, deduped by the relay's runtime event ids. */
  #advanceDeliveredThrough(messageId: string): void {
    if (this.status === "ended") return;
    try {
      this.#ledger.setCheckpoint(this.id, "opencode_msg", messageId, 0, { throughSeq: "latest" });
      this.#deliveredThrough = messageId;
    } catch (e) {
      process.stderr.write(`[opencode ${this.id}] checkpoint ${messageId} failed: ${e instanceof Error ? e.message : e}\n`);
    }
  }

  #persistRecord(): void {
    if (this.status === "ended") return; // a retired/killed generation must not recreate a deleted record (#52)
    saveWindowRecord(this.id, {
      launchCwd: this.cwd, agent: "opencode",
      opencodeSessionId: this.#ocSessionId ?? undefined,
      opencodeServerPid: this.#proc?.pid,
      opencodeSettings: { model: this.currentModel ?? this.model, providerID: this.#providerID },
    });
  }

  // ── inbound ────────────────────────────────────────────────────────────────

  /** Joy-owned slash commands the harness executes itself (never forwarded
   *  to the model); the coordinator completes their row in the accept
   *  transaction (#65).
   *   - /title: with text set + lock, bare unlock (next agent <joy-title> applies again);
   *   - /joy-prompt: re-deliver the CURRENT joy instructions in-band.
   *     Opencode's preamble rides the FIRST prompt only, so after enough turns
   *     (or a compaction) it scrolls out of context; the reinjection is a
   *     hidden follow-up command and IS the (newer) preamble, so the pending
   *     first-prompt preamble is cleared. */
  #handleCommand(text: string, opts: { source: string; mirrorToRelay: boolean; seq?: number | null }): HandledCommand | null {
    const titleCmd = /^\/title(?:\s+(.*))?$/s.exec(text.trim());
    if (titleCmd) {
      const t = (titleCmd[1] ?? "").trim();
      if (t) {
        this.#titleLocked = true;
        saveWindowRecord(this.id, { launchCwd: this.cwd, titleLockedByUser: true });
        this.summary = t;
        void this.#relay?.updateSummary(t);
      } else {
        this.#titleLocked = false;
        saveWindowRecord(this.id, { launchCwd: this.cwd, titleLockedByUser: false });
      }
      this.#deps.broadcast("session_update", this.toJSON());
      if (opts.mirrorToRelay && this.#relay) this.#relay.send(encodeUserMessage(text, Date.now()), `oc:in:${this.id}:${opts.seq ?? Date.now()}`);
      return { handled: true };
    }
    if (/^\/joy-prompt(?:\s|$)/.test(text.trim())) {
      this.#needsPreamble = false;
      if (opts.mirrorToRelay && this.#relay) this.#relay.send(encodeUserMessage(text, Date.now()), `oc:in:${this.id}:${opts.seq ?? Date.now()}`);
      return { handled: true, reinjection: joyPromptReinjection() };
    }
    return null;
  }

  #mirrorAccepted(cmd: CommandView): void {
    if (cmd.mirrorToRelay && this.#relay) this.#relay.send(encodeUserMessage(cmd.text, cmd.createdAt), `oc:in:${this.id}:${cmd.seq ?? cmd.createdAt}`);
    this.#maybeTitle(cmd.text);
  }

  /** Silent-drop guard: /wait is unusable (permanent 503 on 1.18.10), so turn
   *  end comes from step-finish events — but a turn that dies server-side with
   *  NO events (the "Failed to drain Session" drop) would spin forever. This
   *  inactivity deadline is re-armed on every session event and surfaces the
   *  failure instead. */
  #turnDeadline: ReturnType<typeof setTimeout> | null = null;
  #armTurnDeadline(turnID: string): void {
    this.#clearTurnDeadline();
    this.#turnDeadline = setTimeout(() => {
      this.#endTurn(turnID, "failed");
      this.#relay?.send(encodeUserMessage(`⚠ opencode turn produced no activity for ${WAIT_TIMEOUT_MS / 60000} min — giving up`, Date.now()));
    }, WAIT_TIMEOUT_MS);
  }

  #clearTurnDeadline(): void {
    if (this.#turnDeadline) { clearTimeout(this.#turnDeadline); this.#turnDeadline = null; }
  }

  /** Any event for an active turn counts as activity — push the deadline out. */
  touchTurnActivity(): void {
    const turn = this.#norm?.currentTurn;
    if (turn && this.#turnDeadline) this.#armTurnDeadline(turn);
  }

  #endTurn(turnID: string, status: "completed" | "failed" | "cancelled"): void {
    this.#clearTurnDeadline();
    // Checkpoint AFTER the turn's final records (open-tool closes, turn-end)
    // have been handed to the relay sink, which spools them durably before
    // returning — a crash between the two used to skip them on recovery
    // (Astra's review of 6229b647, #67).
    const advance = () => {
      if (status === "cancelled") return;
      if (this.#relay?.outboundPersistDegraded) return; // records only in RAM: hold the checkpoint
      const last = this.#norm?.lastMessageId;
      if (last && last !== this.#deliveredThrough) this.#advanceDeliveredThrough(last);
    };
    if (!this.#norm) { advance(); return; }
    const turn = this.#norm.currentTurn ?? turnID;
    if (!turn) { advance(); return; }
    this.#applyEffects(this.#norm.closeOpenTools());
    this.#relay?.send(encodeTurnEnd(status, { turn }), `oc:${this.#ocSessionId}:${turn}:turn-end`);
    advance();
    this.#norm.setTurn(null);
    this.#activeTurn = null;
    this.#thinking = false;
    this.#relay?.setThinking(false);
    // Every command that rode this turn (a fresh prompt, the steers that
    // joined it) ends with it — the coordinator settles them.
    this.#driver.emit({ kind: "turn_ended", runtimeTurnId: turn, status });
  }

  #applyEffects(effects: OpencodeEffect[]): void {
    for (const eff of effects) {
      switch (eff.kind) {
        case "wire": {
          this.#relay?.send(eff.record, eff.localId);
          // Live text mirrors into the daemon chat log too (the reconcile
          // path shares #chatSeen, so replay never duplicates a live row).
          const data = (eff.record as { content?: { data?: { ev?: { t?: string; text?: string } } } }).content?.data;
          if (data?.ev?.t === "text" && data.ev.text && eff.localId) this.#mirrorChat(eff.localId, data.ev.text);
          break;
        }
        case "thinking":
          this.#thinking = eff.value;
          this.#activeTurn = eff.value ? (this.#norm?.currentTurn ?? this.#activeTurn) : null;
          this.#relay?.setThinking(eff.value);
          if (eff.value && this.#activeTurn) this.#driver.emit({ kind: "turn_started", runtimeTurnId: this.#activeTurn });
          break;
        case "confirmPrompt":
          if (eff.messageID) {
            // Admission proven by SSE: the coordinator pairs it with its
            // attempt (idempotent after the HTTP ack's echo; a cancelled row
            // is interrupted from there — the tombstone rule, #77).
            this.#lastAdmitted = eff.messageID;
            this.#driver.emit({ kind: "echo", runtimeRef: eff.messageID, runtimeTurnId: this.#norm?.currentTurn ?? eff.messageID, receiptKind: "opencode_msg" });
            this.#armTurnDeadline(eff.messageID);
          }
          break; // admission proven by SSE too (#79)
        case "model": if (eff.code !== this.currentModel) { this.currentModel = eff.code; void this.#relay?.updateModelCode(eff.code); } break;
        case "receipt": this.#relay?.stampReceiptOnLastQueued({ uuid: eff.uuid, turn: eff.turn }); break;
        case "context": void this.#relay?.updateContext(eff.tokens); break;
        case "notify": this.#relay?.notifyCustom(eff.headline, eff.detail); break;
        case "title":
          if (!this.#titleLocked) {
            this.summary = eff.value;
            void this.#relay?.updateSummary(eff.value);
            this.#deps.broadcast("session_update", this.toJSON());
          }
          break;
        case "turnDone": this.#endTurn(this.#norm?.currentTurn ?? "", "completed"); break;
        case "turnFailed":
          this.#relay?.send(encodeUserMessage(`⚠ opencode turn failed: ${eff.message}`, Date.now()));
          this.#endTurn(this.#norm?.currentTurn ?? "", "failed");
          break;
      }
    }
  }

  /** Replay history through the SAME localId scheme (part ids are stable, so
   *  already-delivered rows dedupe at the relay append layer). */
  async #reconcileHistory(): Promise<void> {
    const client = this.#client;
    const sid = this.#ocSessionId;
    if (!client || !sid || !this.#norm) return;
    try {
      const all = await client.messages(sid);
      const msgs = messagesForReplay(all, this.#deliveredThrough);
      if (this.#deliveredThrough && msgs.length < all.length) {
        process.stderr.write(`[opencode ${this.id}] reconcile: ${all.length - msgs.length} messages already delivered, replaying ${msgs.length}\n`);
      }
      let turn: string | null = null;
      // Advance the checkpoint only through COMPLETED work: the last assistant
      // message with a finish. A trailing user prompt / in-flight assistant is
      // left past the checkpoint so the next reconcile picks it up whole.
      let completedThrough: string | null = null;
      for (const m of msgs) {
        const type = String(m.type ?? "");
        const mid = String(m.id ?? "");
        if (type === "user") {
          turn = mid;
          this.#relay?.send(encodeTurnStart({ turn }), `oc:${sid}:${turn}:turn-start`);
          continue;
        }
        if (type !== "assistant" || !turn) continue;
        const parts = Array.isArray(m.content) ? (m.content as Array<Record<string, unknown>>) : [];
        for (const p of parts) {
          const pt = String(p.type ?? "");
          const pidPart = String(p.id ?? p.callID ?? "");
          const core = `${mid}:${pidPart}`;
          if (pt === "text") {
            const text = String(p.text ?? "").trim();
            if (text) {
              this.#relay?.send(encodeTextEvent(text, { turn }), `oc:${sid}:${core}:text`);
              this.#mirrorChat(`oc:${sid}:${core}:text`, text);
            }
          } else if (pt === "tool" || pt === "tool-call" || pt === "toolCall") {
            this.#relay?.send(encodeToolCallStart({ call: core, name: "OpencodeTool", input: p.input ?? null, turn }), `oc:${sid}:${core}:tool-start`);
            // Same outcome semantics as the live normalizer (#68): the stored
            // part state carries output / error / status.
            const st = (p.state ?? {}) as Record<string, unknown>;
            const isError = String(st.status ?? "") === "error" || st.error != null;
            const raw = isError ? (st.error ?? st.output) : (st.output ?? st.result);
            const result = raw == null ? undefined : (typeof raw === "string" ? raw : JSON.stringify(raw));
            const clamped = result && result.length > 48_000 ? `${result.slice(0, 24_000)}\n…[truncated]…\n${result.slice(-24_000)}` : result;
            this.#relay?.send(encodeToolCallEnd(core, { turn, ...(clamped ? { result: clamped } : {}), ...(isError ? { isError: true } : {}) }), `oc:${sid}:${core}:tool-end`);
          }
        }
        // Assistant message completed → close the turn row (deterministic id
        // means a live-emitted turn-end for the same turn dedupes).
        if (m.finish) {
          this.#relay?.send(encodeTurnEnd("completed", { turn }), `oc:${sid}:${turn}:turn-end`);
          completedThrough = mid;
        }
      }
      if (completedThrough && !this.#relay?.outboundPersistDegraded) this.#advanceDeliveredThrough(completedThrough);
    } catch (e) {
      process.stderr.write(`[opencode ${this.id}] reconcile failed: ${e}\n`);
    }
  }

  /** First-prompt auto-title: once, fresh cards only (see #titled). */
  #maybeTitle(text: string): void {
    if (this.#titled || !this.#relay) return;
    this.#titled = true;
    const title = titleFromPrompt(text);
    if (title) void this.#relay.updateSummary(title);
  }

  /** Mid-session model switch (curated ids only — validated by the op). */
  async setModel(modelId: string, providerID: string): Promise<{ ok: boolean; error?: string }> {
    const client = this.#client;
    const sid = this.#ocSessionId;
    if (!client || !sid) return { ok: false, error: "session not started" };
    try {
      await client.switchModel(sid, providerID, modelId);
      this.currentModel = modelId;
      this.#providerID = providerID;
      void this.#relay?.updateModelCode(modelId);
      this.#persistRecord();
      this.#deps.broadcast("session_update", this.toJSON());
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }

  // ── AgentSession surface ───────────────────────────────────────────────────

  busy(): boolean { return this.#thinking; }

  /** Stop what is executing: every command in flight is cancelled durably
   *  and the session-wide interrupt is sent (the coordinator retries until
   *  the turn's end confirms it). A failed interrupt is reported: the turn
   *  is NOT over locally (#8). */
  async abort(): Promise<{ ok: boolean; error?: string }> {
    return this.#coordinator.abortRunning(this.id);
  }

  // No tmux window: pane/keys/resize degrade gracefully (app hides these for
  // flavor 'opencode' via capabilities metadata).
  async pane(): Promise<{ ok: true; text: string }> { return { ok: true, text: "(opencode session — no terminal pane)" }; }
  async resize(): Promise<{ ok: boolean }> { return { ok: true }; }
  async sendRawKeys(): Promise<{ ok: boolean; segments: number; error?: string }> { return { ok: false, segments: 0, error: "no pane for opencode sessions" }; }
  detectPermissionMode(): string | null { return null; }
  async setPermissionMode(): Promise<{ ok: boolean; mode?: string; error?: string }> { return { ok: false, error: "not supported for opencode (v1)" }; }
  // Chat-log mirror (once per part id — reconcile re-walks in-flight
  // assistant messages until they complete, and the relay-side localId dedupe
  // does not cover the daemon chat log).
  #chatSeen = new Set<string>();
  #mirrorChat(localId: string, text: string): void {
    if (this.#chatSeen.has(localId)) return;
    this.#chatSeen.add(localId);
    this.#deps.addChatMessage({ role: "assistant", content: text, source: "cli", session_id: this.id });
  }

  transcript(): { lines: unknown[] } { return { lines: [] }; }
  onHookEvent(): { ok: boolean } { return { ok: true }; }
  /** Card snapshot for the nucleus lane's v2 publish (see AgentSession). */
  cardMetadata(): Record<string, unknown> | null {
    return this.#relay?.metadataSnapshot ?? null;
  }

  setV2Link(link: { sessionId: string; relay: string; keyEnvelope: string }): void {
    // localSessionId lets the app address this session's MACHINE plane
    // (/v2/sessions/<local id>/…) through the sealed tunnel.
    void this.#relay?.mergeMetadata({ v2: { ...link, localSessionId: this.id } });
  }

  setHandoff(info: import("../relay/relay").JoyHandoffInfo | null): void { saveWindowRecord(this.id, { handoff: info }); void this.#relay?.updateHandoff(info); }
  markCompacting(): void { /* server-side */ }

  // ── teardown ──────────────────────────────────────────────────────────────

  end(reason: "killed" | "process_exited" | "restart"): boolean {
    if (this.status === "ended") return false;
    this.status = "ended";
    this.endReason = reason;
    try { this.#client?.close(); } catch { /* ignore */ }
    this.#client = null;
    if (this.#proc?.pid) killOpencodeServerPid(this.#proc.pid);
    this.#proc = null;
    // The coordinator is retired FIRST: the turn-end below must not be
    // mistaken for the runtime's verdict on a dead generation's commands.
    this.#unsubscribeQueue();
    this.#coordinator.retire(this.id, reason);
    if (this.#activeTurn) this.#endTurn(this.#activeTurn, "cancelled");
    this.#relay?.setThinking(false);
    if (reason === "process_exited") {
      void this.#relay?.updateJoyState("detached");
      this.#relay?.pausePull();
    } else {
      if (this.#relay && reason !== "restart") this.#archivePromise = this.#relay.archive(); // restart keeps the card
      this.#relay?.stop();
      if (reason !== "restart") this.#recordTerminated = deleteWindowRecord(this.id);
    }
    this.#deps.broadcast("session_update", this.toJSON());
    return true;
  }

  /** #567 residual: false once an intentional kill could NOT durably commit a
   *  termination marker (the record's unlink AND its tombstone both refused).
   *  The kill op reports that instead of ok — a restart would otherwise
   *  recover the "killed" session — and the delete is retried on every record
   *  scan and on the next kill of this id. */
  #recordTerminated = true;
  recordTerminated(): boolean { return this.#recordTerminated; }

  forceKill(): boolean {
    if (this.status === "ended") {
      // A detached session killed on purpose: archive, stop the relay, mark
      // killed and delete the record — otherwise recovery resurrected it
      // (Astra on 2f803b14, #43).
      if (this.#relay) { this.#archivePromise = this.#relay.archive(); this.#relay.stop(); this.#relay = null; }
      this.endReason = "killed";
      this.#recordTerminated = deleteWindowRecord(this.id);
      this.#coordinator.retire(this.id, "killed"); // nothing left to deliver (#43)
      this.#deps.broadcast("session_update", this.toJSON());
      return true;
    }
    return this.end("killed");
  }

  async awaitArchive(): Promise<boolean> {
    return this.#archivePromise ? await this.#archivePromise : true;
  }

  toJSON(): SessionRecord {
    return {
      id: this.id,
      agent: this.agentFlavor,
      current_model: this.currentModel,
      pid: this.pid,
      tmux_window: this.tmuxWindow,
      cwd: this.cwd,
      model: this.model,
      effort: this.effort,
      flags: [],
      status: this.status,
      started_at: this.#startedAt,
      last_active_at: Date.now(),
      end_reason: this.endReason,
      transcript_path: this.transcriptPath,
      relay_session_id: this.relaySessionId,
      summary: this.summary,
      busy: this.#thinking,
    };
  }

  async createAndAttachRelay(): Promise<void> {
    if (!this.#deps.relayClient) return;
    const rs = await createRelaySession(this.#deps.relayClient, { tag: `joy-daemon-${this.id}`, cwd: this.cwd, id: this.id });
    this.attachRelay(rs);
  }
}
