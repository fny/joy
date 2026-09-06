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
import { ledgerFor, type Ledger, type CommandRow, StaleCommandError, StaleGenerationError } from "../domain/ledger";

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
const INTERRUPT_RETRY_MS = 2_000;
const INTERRUPT_RETRY_MAX = 5;

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
  // Durable inbound queue: ledger commands, committed before delivery; each
  // prompt POST is a ledger attempt committed before the request goes out.
  #ledger: Ledger;
  #generation: number;
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
  }

  /** Test/diagnostic access to the session's ledger generation. */
  get ledgerGeneration(): number { return this.#generation; }

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
      await this.#drainInbound();
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

  /** /joy-prompt — re-deliver the CURRENT joy instructions in-band. Opencode's
   *  preamble rides the FIRST prompt only, so after enough turns (or a
   *  compaction) it genuinely scrolls out of context; this refreshes it. The
   *  body goes out as its own unmirrored message — only the /joy-prompt row
   *  (when mirror) appears in chat. Clears #needsPreamble: the reinjection IS
   *  the (newer) preamble. */
  #handleJoyPrompt(text: string, mirror: boolean, seq?: number): string | false {
    if (!/^\/joy-prompt(?:\s|$)/.test(text.trim())) return false;
    this.#needsPreamble = false;
    if (mirror && this.#relay) this.#relay.send(encodeUserMessage(text, Date.now()), `oc:in:${this.id}:${seq ?? Date.now()}`);
    const rein = this.enqueue(joyPromptReinjection(), { mirrorToRelay: false });
    return rein.id; // the reinjection item, so a cancelled relay turn can pluck it (#77)
  }

  #draining = false;
  async #drainInbound(): Promise<void> {
    const client = this.#client;
    if (!client || !this.#ocSessionId) return;
    // One ordered drain at a time — but a wakeup that arrives while one is
    // running is REMEMBERED, so an item enqueued after the snapshot is sent
    // by a fresh pass instead of waiting for unrelated intake (Astra, #79).
    if (this.#draining) { this.#drainAgain = true; return; }
    this.#draining = true;
    try {
      do { this.#drainAgain = false; await this.#drainInboundInner(client, this.#ocSessionId); } while (this.#drainAgain && this.status !== "ended");
    } finally { this.#draining = false; }
  }
  #drainAgain = false;
  /** Read through a call so TS does not narrow `status` across an await. */
  #isEnded(): boolean { return this.status === "ended"; }
  async #drainInboundInner(client: OpencodeClient, ocSessionId: string): Promise<void> {
    // queued rows, plus unknown ones (a transport failure mid-request): the
    // deterministic message id makes the retry idempotent server-side.
    for (const item of this.#ledger.listPending(this.id, ["queued", "unknown"])) {
      if (this.status === "ended") return; // a killed generation sends nothing more (#43)
      // The attempt is COMMITTED before the request goes out. The ledger
      // refuses a row whose cancel landed during the previous await (#77),
      // a stale generation (#481), and — should the commit itself fail —
      // the prompt is simply not sent this pass.
      let attemptId: string;
      try {
        if (item.state === "unknown" && !this.#ledger.requeueCommand(item.id)) continue;
        attemptId = this.#ledger.recordAttempt(item.id, this.#generation, item.id, "prompt").id;
      } catch (e) {
        if (e instanceof StaleGenerationError) return;
        if (e instanceof StaleCommandError) { this.#recordOutcome(item.id, this.#ledger.getCommand(item.id)?.state === "cancelled" ? "cancelled" : "delivered"); continue; }
        process.stderr.write(`[opencode ${this.id}] could not commit the prompt attempt for ${item.id}: ${e instanceof Error ? e.message : e} — holding the send\n`);
        this.#drainAgain = true;
        return;
      }
      try {
        // delivery:'steer' (the server default, claude-parity UX): idle →
        // starts a turn; busy → injected into the RUNNING turn between tool
        // calls (verified live 2026-08-03 — in-flight work continues and the
        // model incorporates the addition).
        const outText = this.#needsPreamble ? opencodeJoyPreamble() + item.text : item.text;
        const r = await client.prompt(ocSessionId, outText, { id: item.id, delivery: "steer" });
        this.#needsPreamble = false;
        // Admission ack = durable server-side; prompt.admitted event confirms
        // via the normalizer too, but the ack alone is safe to settle on
        // (admittedSeq is the server's own ordering receipt).
        if (this.#isEnded()) return; // retired mid-request: this generation owns nothing now (#43)
        if (r.messageID) {
          this.#noteAdmitted(item.id, r.admittedSeq >= 0 ? r.admittedSeq : undefined);
          // A cancel that raced the reply wins: confirmDelivery on a cancelled
          // row only adds the receipt (the terminal state stands).
          try { this.#ledger.confirmDelivery(item.id, [{ kind: "opencode_msg", ref: r.messageID }, ...(item.seq != null ? [{ kind: "seq", ref: String(item.seq) }] : [])], { attemptId, generation: this.#generation }); }
          catch (e) { process.stderr.write(`[opencode ${this.id}] admission commit for ${item.id} failed: ${e instanceof Error ? e.message : e}\n`); }
          this.#recordOutcome(item.id, "delivered");
        } else {
          try { this.#ledger.settleAttempt(attemptId, "unknown", { detail: "no messageID in the prompt reply", generation: this.#generation }); } catch { /* logged below on the next pass */ }
        }
        // The HTTP ack is admission evidence too: a prompt cancelled while
        // this request was in flight (tombstoned by cancelQueued) is now
        // running — interrupt it here, not only on the SSE confirm, which a
        // dropped stream never delivers (Astra on 170ec279, #77).
        if (r.messageID && this.#cancelledIds.has(item.id)) {
          process.stderr.write(`[opencode ${this.id}] ${item.id} was cancelled — interrupting the admitted prompt\n`);
          this.#interruptCancelled(item.id, client, ocSessionId);
        }
      } catch (e) {
        if (this.#isEnded()) return;
        const msg = e instanceof Error ? e.message : String(e);
        if (/→ \d{3}:/.test(msg)) {
          // The server ANSWERED and refused: this prompt is terminal. Leaving
          // it unknown re-ran it on the next unrelated intake, after the app
          // had already shown it failed (#79). A cancel that raced the reply
          // keeps its outcome (the row is already terminal).
          process.stderr.write(`[opencode ${this.id}] prompt rejected: ${msg} — dropped\n`);
          const wasOurs = !this.#cancelledIds.has(item.id) && this.#ledger.getCommand(item.id)?.state === "submitting";
          try { this.#ledger.settleAttempt(attemptId, "rejected", { detail: msg.slice(0, 200), generation: this.#generation }); } catch { /* best effort */ }
          if (wasOurs) this.#recordOutcome(item.id, "failed");
        } else {
          process.stderr.write(`[opencode ${this.id}] prompt failed: ${msg}\n`);
          // transport failure: an explicit unknown — the deterministic id makes the retry idempotent.
          try { this.#ledger.settleAttempt(attemptId, "unknown", { detail: msg.slice(0, 200), generation: this.#generation }); } catch { /* best effort */ }
        }
      }
    }
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
        case "thinking": this.#thinking = eff.value; this.#activeTurn = eff.value ? (this.#norm?.currentTurn ?? this.#activeTurn) : null; this.#relay?.setThinking(eff.value); break;
        case "confirmPrompt":
          if (eff.messageID) {
            this.#noteAdmitted(eff.messageID, eff.seq);
            // Admission proven by SSE: settle the attempt + row (idempotent
            // after the HTTP ack's confirm; a cancelled row keeps its state).
            const att = this.#ledger.matchAttemptByRef(this.id, eff.messageID);
            if (att || this.#ledger.getCommand(eff.messageID)?.sessionId === this.id) {
              try { this.#ledger.confirmDelivery(att?.commandId ?? eff.messageID, [{ kind: "opencode_msg", ref: eff.messageID }], { attemptId: att?.id, generation: this.#generation }); }
              catch (e) { process.stderr.write(`[opencode ${this.id}] admission commit for ${eff.messageID} failed: ${e instanceof Error ? e.message : e}\n`); }
            }
            this.#recordOutcome(eff.messageID, "delivered"); this.#armTurnDeadline(eff.messageID);
            if (this.#cancelledIds.has(eff.messageID) && this.#client && this.#ocSessionId) {
              // Admitted after the user cancelled it: interrupt now (#77).
              this.#interruptCancelled(eff.messageID, this.#client, this.#ocSessionId);
            }
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

  enqueue(text: string, opts?: { source?: DeliverySource; mirrorToRelay?: boolean; seq?: number; visible?: boolean }): QueuedMessage {
    const seq = opts?.seq;
    // /title — joy-level command, never forwarded to the model. With text:
    // set + lock. Bare: unlock (next agent <joy-title> applies again).
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
      if ((opts?.mirrorToRelay ?? true) && this.#relay) this.#relay.send(encodeUserMessage(text, Date.now()), `oc:in:${this.id}:${seq ?? Date.now()}`);
      return { id: String(seq ?? Date.now()), text, createdAt: Date.now(), handled: "command" }; // (#65)
    }
    const rein = this.#handleJoyPrompt(text, opts?.mirrorToRelay ?? true, seq);
    if (rein) {
      return { id: String(seq ?? Date.now()), text, createdAt: Date.now(), handled: "command", reinjectionId: rein };
    }
    // Acceptance = the ledger commit (throws when it cannot commit, or when
    // the session has ended — #553). A redelivered seq dedupes against the
    // pending row or the retained receipt: the same logical message, never a
    // second prompt.
    const at = Date.now();
    const accepted = this.#ledger.acceptCommand({
      sessionId: this.id, id: seq != null ? `msg_joy${this.id}s${seq}` : `msg_joy${this.id}r${randomUUID().replace(/-/g, "").slice(0, 12)}`, text,
      origin: seq != null ? "relay" : "local", source: opts?.source ?? "rpc", seq,
      visible: opts?.visible ?? false, mirrorToRelay: opts?.mirrorToRelay ?? true, createdAt: at,
    });
    if (accepted.deduped !== "none") { void this.#drainInbound(); return { id: accepted.id, text, createdAt: accepted.row?.createdAt ?? at }; }
    if ((opts?.mirrorToRelay ?? true) && this.#relay) this.#relay.send(encodeUserMessage(text, at), `oc:in:${this.id}:${seq ?? at}`);
    this.#maybeTitle(text);
    void this.#drainInbound();
    return { id: accepted.id, text, createdAt: at }; // the durable command id is the queue item id (#79)
  }

  queueState(): QueueState {
    const pending = this.#ledger.listPending(this.id, ["queued"]).length;
    return { queue: [], pendingCount: pending, hidden: [], inFlight: this.#activeTurn, paused: false };
  }

  resumeQueue(): void { void this.#drainInbound(); }
  editQueued(): boolean { return false; }
  cancelQueued(id: string): boolean {
    const row = this.#ledger.getCommand(id);
    if (!row || row.sessionId !== this.id || ["completed", "failed", "cancelled", "interrupted"].includes(row.state)) return false;
    const inFlight = row.state !== "queued";
    try { this.#ledger.requestCancel(id); if (inFlight) this.#ledger.transition(id, ["submitting", "accepted", "unknown", "running", "cancelling"], "cancelled", { terminalReason: "cancelled" }); }
    catch (e) { process.stderr.write(`[opencode ${this.id}] ledger cancel ${id} failed: ${e instanceof Error ? e.message : e}\n`); }
    this.#recordOutcome(id, "cancelled");
    if (inFlight) {
      // The HTTP prompt is in flight: it may be admitted after this. Tombstone
      // it (admission interrupts) and report "not plucked" so the caller aborts
      // now (Astra on 4b70d70c, #77).
      this.#cancelledIds.add(id);
      return false;
    }
    return true;
  }
  /** Cancelled while their prompt request was in flight (see cancelQueued). */
  #cancelledIds = new Set<string>();
  /** Interrupt a cancelled prompt that was admitted anyway. The tombstone is
   *  consumed only once the interrupt SUCCEEDS: consuming it first and
   *  swallowing the rejection lost the cancellation for good when the
   *  interrupt failed, leaving work active while queueItemState said
   *  cancelled (Astra on cde740c1, #77). A kept tombstone lets the next
   *  admission evidence (HTTP ack or SSE confirm) retry it. */
  /** Admission order is MONOTONIC: an id's first admission (HTTP ack or SSE
   *  confirm, whichever arrives first) assigns it a sequence; a duplicate or
   *  late admission of an already-admitted id never bumps it, so stale
   *  evidence for an OLD prompt cannot make it "the latest" again and steer
   *  an interrupt at newer work (Astra on 7c27b926, #77). */
  #noteAdmitted(id: string, serverSeq?: number): void {
    const known = this.#admissionSeq.get(id);
    if (known) {
      // Late evidence for a known id may still carry a server seq we lacked
      // (HTTP ack lost, SSE later): record it, never re-rank as newest.
      if (serverSeq !== undefined && known.server === undefined) { known.server = serverSeq; if (this.#lastAdmitted === id && this.#lastAdmittedRank) this.#lastAdmittedRank.server = serverSeq; }
      return;
    }
    const rank = { server: serverSeq, local: ++this.#admissionClock };
    this.#admissionSeq.set(id, rank);
    // Newest = SERVER order when both sides have it (admittedSeq / durable.seq
    // are the server's own counter); arrival order only as a fallback. First-
    // observed order let a delayed admission of an OLD prompt (seq 10) rank
    // above a newer one (seq 20) and interrupt the newer work (Astra on
    // a1c76416, #77).
    // The current admission's ordering evidence lives in #lastAdmittedRank,
    // independent of the cache: 500 older admissions arriving after B could
    // evict B's entry, and A's delayed first admission then found no current
    // rank, became newest and interrupted B (Astra on 94053e4f, #77).
    const cur = this.#lastAdmittedRank;
    const newer = !cur || (rank.server !== undefined && cur.server !== undefined ? rank.server > cur.server : rank.local > cur.local);
    if (newer) { this.#lastAdmitted = id; this.#lastAdmittedRank = rank; }
    // Admission identity must outlive any tombstone for the same id: evicting
    // a cancelled prompt's entry while its tombstone stayed let a later
    // unsequenced duplicate admission count as first-seen → newest → a
    // session-wide interrupt at current work (Astra on b8dc2bf6). Evict only
    // ids with no outstanding tombstone; a tombstone that outlives the cache
    // window is obsolete and retired with its identity.
    if (this.#admissionSeq.size > 500) {
      for (const key of this.#admissionSeq.keys()) {
        if (this.#admissionSeq.size <= 400) break;
        if (this.#cancelledIds.has(key) && this.#admissionSeq.size < 1000) continue; // keep fencing evidence while the tombstone lives
        this.#admissionSeq.delete(key); this.#cancelledIds.delete(key); this.#interruptAttempts.delete(key);
      }
    }
  }
  #admissionSeq = new Map<string, { server: number | undefined; local: number }>();
  #lastAdmittedRank: { server: number | undefined; local: number } | undefined;
  #admissionClock = 0;
  /** May an interrupt on behalf of cancelled `id` still fire? Only while no
   *  newer prompt has been admitted — the endpoint interrupts the SESSION. */
  #ownsInterrupt(id: string): boolean {
    return this.#cancelledIds.has(id) && !this.#isEnded() && this.#lastAdmitted === id;
  }

  #interruptCancelled(id: string, client: OpencodeClient, ocSessionId: string): void {
    if (!this.#ownsInterrupt(id)) return; // every path — first attempt, coalesced retry, timer retry
    // One interrupt in flight per tombstone: the HTTP ack and the SSE confirm
    // of the same prompt both arrive as admission evidence, and two interrupts
    // could stop the NEXT turn (the endpoint has no turn identity; Astra on
    // 343e3bb6). Later evidence retries only after a failure settled.
    if (this.#interrupting.has(id)) { this.#interruptAgain.add(id); return; } // evidence during an in-flight interrupt = retry if it fails
    this.#interrupting.add(id);
    void client.interrupt(ocSessionId)
      .then(() => { this.#cancelledIds.delete(id); this.#interruptAgain.delete(id); this.#interruptAttempts.delete(id); const t = this.#interruptTimers.get(id); if (t) { clearTimeout(t); this.#interruptTimers.delete(id); } })
      .catch((e) => {
        process.stderr.write(`[opencode ${this.id}] interrupt of cancelled ${id} failed (${e instanceof Error ? e.message : e}) — tombstone kept for retry\n`);
        // No further admission evidence may ever come (HTTP-only admission,
        // SSE dropped), so a failed interrupt also schedules its own bounded
        // retry: the tombstone alone is the evidence (Astra on 5b06ba5c, #77).
        const n = (this.#interruptAttempts.get(id) ?? 0) + 1;
        this.#interruptAttempts.set(id, n);
        // Fenced to the cancelled work: the endpoint interrupts the SESSION,
        // so once a newer prompt was admitted the retry would stop that one
        // instead (Astra on af76c787). The tombstone then stays for the next
        // admission evidence of THIS prompt, if any.
        // One pending retry timer per id: an HTTP failure and a later SSE
        // failure used to arm two (Astra on 7c27b926).
        const prior = this.#interruptTimers.get(id); if (prior) clearTimeout(prior);
        if (n < INTERRUPT_RETRY_MAX) {
          const t = setTimeout(() => { this.#interruptTimers.delete(id); this.#interruptCancelled(id, client, ocSessionId); }, INTERRUPT_RETRY_MS);
          t.unref?.(); this.#interruptTimers.set(id, t);
        }
        else process.stderr.write(`[opencode ${this.id}] giving up interrupting cancelled ${id} after ${n} attempts\n`);
      })
      .finally(() => {
        this.#interrupting.delete(id);
        // Admission evidence that arrived while this attempt was pending was
        // coalesced away; if the attempt failed, that evidence still owes a
        // retry (Astra on 03b558f0).
        if (this.#interruptAgain.delete(id)) this.#interruptCancelled(id, client, ocSessionId); // ownership re-checked inside
      });
  }
  #interrupting = new Set<string>();
  #interruptAgain = new Set<string>();
  #interruptAttempts = new Map<string, number>();
  #interruptTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** clientId of the most recently admitted prompt (HTTP ack or SSE confirm). */
  #lastAdmitted: string | null = null;
  #itemOutcome = new Map<string, "delivered" | "cancelled" | "failed">();
  #recordOutcome(id: string, outcome: "delivered" | "cancelled" | "failed"): void {
    // Terminal outcomes are monotonic: a late admission or reply for an item
    // the user cancelled must not turn "cancelled" into "delivered".
    const prev = this.#itemOutcome.get(id);
    if ((prev === "cancelled" || prev === "failed") && outcome === "delivered") return;
    this.#itemOutcome.set(id, outcome);
    if (this.#itemOutcome.size > 200) for (const k of this.#itemOutcome.keys()) { this.#itemOutcome.delete(k); if (this.#itemOutcome.size <= 150) break; }
  }
  queueItemState(id: string): "pending" | "delivered" | "cancelled" | "failed" | "unknown" {
    const local = this.#itemOutcome.get(id);
    if (local) return local;
    const row = this.#ledger.getCommand(id);
    if (!row || row.sessionId !== this.id) return this.#ledger.hasReceipt(this.id, "opencode_msg", id) ? "delivered" : "unknown";
    switch (row.state) {
      case "completed": return "delivered";
      case "failed": return "failed";
      case "cancelled": case "interrupted": return "cancelled";
      default: return "pending";
    }
  }
  reorderQueued(): boolean { return false; }

  async abort(): Promise<{ ok: boolean; error?: string }> {
    if (this.#client && this.#ocSessionId) {
      try { await this.#client.interrupt(this.#ocSessionId); }
      catch (e) { return { ok: false, error: `interrupt failed: ${e instanceof Error ? e.message : e}` }; } // the turn is NOT over locally (#8)
      this.#endTurn(this.#activeTurn ?? "", "cancelled");
    }
    return { ok: true };
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
    // A killed session will never deliver: its queued rows are interrupted.
    // A restart's replacement takes them; a process exit keeps them for the
    // restart that follows (the record — and the server session — remain).
    try { this.#ledger.closeGeneration(this.id, this.#generation, reason, { keepQueued: reason === "restart" || reason === "process_exited" }); }
    catch (e) { process.stderr.write(`[opencode ${this.id}] ledger closeGeneration failed: ${e instanceof Error ? e.message : e}\n`); }
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
      try { this.#ledger.closeGeneration(this.id, this.#generation, "killed"); } // nothing left to deliver (#43)
      catch (e) { process.stderr.write(`[opencode ${this.id}] ledger close on kill failed: ${e instanceof Error ? e.message : e}\n`); }
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
