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
import { saveWindowRecord, deleteWindowRecord } from "../domain/windowRecord";
import {
  createRelaySession, encodeUserMessage, encodeTurnEnd,
  encodeTurnStart, encodeTextEvent, encodeToolCallStart, encodeToolCallEnd,
  type RelaySession,
} from "../relay/relay";
import type { SessionDeps, SessionStatus, SessionRecord, QueuedMessage, QueueState } from "../claude/session";
import type { DeliverySource } from "../domain/receipts";
import type { AgentSession } from "../domain/agentSession";
import { spawnOpencodeServer, OpencodeClient, isOpencodeServerPid, killOpencodeServerPid } from "./opencodeClient";
import { OpencodeNormalizer, type OpencodeEffect } from "./normalize";
import { loadCodexInbound, saveCodexInbound, clearCodexInbound, type CodexInboundItem } from "../codex/codexInboundStore";

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
  /** Reconcile checkpoint: last fully-delivered message id (recovery). */
  opencodeDeliveredThrough?: string;
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

export class OpencodeSession implements AgentSession {
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
  #inbound: CodexInboundItem[] = [];
  // Reconcile checkpoint (persisted): last message id fully delivered to the
  // relay. Advanced on live turn completion and after reconcile replay.
  #deliveredThrough?: string;
  #continueLast = false;
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
    this.#deliveredThrough = init.opencodeDeliveredThrough;
    this.#continueLast = init.continueLast === true;
    // Load the durable spool before the relay starts pulling.
    this.#inbound = init.opencodeSessionId ? loadCodexInbound(this.id) : [];
    if (!init.opencodeSessionId) clearCodexInbound(this.id);
  }

  get relayAttached(): boolean { return this.#relay !== null; }
  get opencodeSessionId(): string | undefined { return this.#ocSessionId ?? this.#resumeOcSessionId; }

  // ── lifecycle ──────────────────────────────────────────────────────────────

  attachRelay(rs: RelaySession, allowEnded = false): boolean {
    if (this.status === "ended" && !allowEnded) return false;
    this.#relay = rs;
    this.relaySessionId = rs.relaySessionId;
    if (this.status === "ended") rs.pausePull();
    rs.onMessage = async (text, seq) => { await this.#onRelayMessage(text, seq); };
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
        killOpencodeServerPid(this.#reapPid);
      }
      const { proc, port } = spawnOpencodeServer(this.cwd);
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

  #persistRecord(): void {
    saveWindowRecord(this.id, {
      launchCwd: this.cwd, agent: "opencode",
      opencodeSessionId: this.#ocSessionId ?? undefined,
      opencodeServerPid: this.#proc?.pid,
      opencodeDeliveredThrough: this.#deliveredThrough,
      opencodeSettings: { model: this.currentModel ?? this.model, providerID: this.#providerID },
    });
  }

  // ── inbound ────────────────────────────────────────────────────────────────

  async #onRelayMessage(text: string, seq: number): Promise<void> {
    if (this.status === "ended") return;
    if (this.#inbound.some((i) => i.seq === seq)) { void this.#drainInbound(); return; }
    // msg_ prefix is REQUIRED by the prompt schema; deterministic per relay seq
    // so a cursor redelivery reuses the same id (idempotent server-side).
    const item: CodexInboundItem = { clientId: `msg_joy${this.id}s${seq}`, text, state: "queued", at: Date.now(), seq };
    this.#inbound.push(item);
    if (!saveCodexInbound(this.id, this.#inbound)) {
      this.#inbound.pop();
      throw new Error("opencode inbound persist failed");
    }
    await this.#drainInbound();
  }

  async #drainInbound(): Promise<void> {
    const client = this.#client;
    if (!client || !this.#ocSessionId) return;
    for (const item of [...this.#inbound]) {
      if (item.state !== "queued" && item.state !== "sentUnknown") continue;
      try {
        item.state = "sentUnknown";
        saveCodexInbound(this.id, this.#inbound);
        // delivery:'queue' → opencode queues natively while a turn is running.
        const r = await client.prompt(this.#ocSessionId, item.text, { id: item.clientId, delivery: "queue" });
        // Admission ack = durable server-side; prompt.admitted event confirms
        // via the normalizer too, but the ack alone is safe to remove on
        // (admittedSeq is the server's own ordering receipt).
        if (r.messageID) this.#removeInbound(item.clientId);
      } catch (e) {
        process.stderr.write(`[opencode ${this.id}] prompt failed: ${e}\n`);
        // leave sentUnknown: the deterministic id makes a retry idempotent.
      }
    }
  }

  #removeInbound(clientId: string): void {
    const before = this.#inbound.length;
    this.#inbound = this.#inbound.filter((i) => i.clientId !== clientId);
    if (this.#inbound.length !== before) saveCodexInbound(this.id, this.#inbound);
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
    if (status !== "cancelled") {
      const last = this.#norm?.lastMessageId;
      if (last && last !== this.#deliveredThrough) {
        this.#deliveredThrough = last;
        this.#persistRecord();
      }
    }
    if (!this.#norm) return;
    const turn = this.#norm.currentTurn ?? turnID;
    if (!turn) return;
    this.#applyEffects(this.#norm.closeOpenTools());
    this.#relay?.send(encodeTurnEnd(status, { turn }), `oc:${this.#ocSessionId}:${turn}:turn-end`);
    this.#norm.setTurn(null);
    this.#activeTurn = null;
    this.#thinking = false;
    this.#relay?.setThinking(false);
  }

  #applyEffects(effects: OpencodeEffect[]): void {
    for (const eff of effects) {
      switch (eff.kind) {
        case "wire": this.#relay?.send(eff.record, eff.localId); break;
        case "thinking": this.#thinking = eff.value; this.#activeTurn = eff.value ? (this.#norm?.currentTurn ?? this.#activeTurn) : null; this.#relay?.setThinking(eff.value); break;
        case "confirmPrompt": this.#removeInbound(eff.messageID); this.#armTurnDeadline(eff.messageID); break;
        case "model": if (eff.code !== this.currentModel) { this.currentModel = eff.code; void this.#relay?.updateModelCode(eff.code); } break;
        case "receipt": this.#relay?.stampReceiptOnLastQueued({ uuid: eff.uuid, turn: eff.turn }); break;
        case "context": void this.#relay?.updateContext(eff.tokens); break;
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
            if (text) this.#relay?.send(encodeTextEvent(text, { turn }), `oc:${sid}:${core}:text`);
          } else if (pt === "tool" || pt === "tool-call" || pt === "toolCall") {
            this.#relay?.send(encodeToolCallStart({ call: core, name: "OpencodeTool", input: p.input ?? null, turn }), `oc:${sid}:${core}:tool-start`);
            this.#relay?.send(encodeToolCallEnd(core, { turn }), `oc:${sid}:${core}:tool-end`);
          }
        }
        // Assistant message completed → close the turn row (deterministic id
        // means a live-emitted turn-end for the same turn dedupes).
        if (m.finish) {
          this.#relay?.send(encodeTurnEnd("completed", { turn }), `oc:${sid}:${turn}:turn-end`);
          completedThrough = mid;
        }
      }
      if (completedThrough) {
        this.#deliveredThrough = completedThrough;
        this.#persistRecord();
      }
    } catch (e) {
      process.stderr.write(`[opencode ${this.id}] reconcile failed: ${e}\n`);
    }
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

  enqueue(text: string, opts?: { source?: DeliverySource; mirrorToRelay?: boolean; seq?: number; visible?: boolean; requireDurable?: boolean }): QueuedMessage {
    const seq = opts?.seq;
    if (seq != null && this.#inbound.some((i) => i.seq === seq)) { void this.#drainInbound(); return { id: String(seq), text, createdAt: Date.now() }; }
    const item: CodexInboundItem = {
      clientId: seq != null ? `msg_joy${this.id}s${seq}` : `msg_joy${this.id}r${randomUUID().replace(/-/g, "").slice(0, 12)}`,
      text, state: "queued", at: Date.now(), seq,
    };
    this.#inbound.push(item);
    if (!saveCodexInbound(this.id, this.#inbound) && opts?.requireDurable) {
      this.#inbound.pop();
      throw new Error("opencode inbound persist failed");
    }
    if ((opts?.mirrorToRelay ?? true) && this.#relay) this.#relay.send(encodeUserMessage(text, item.at), `oc:in:${this.id}:${seq ?? item.at}`);
    void this.#drainInbound();
    return { id: String(item.at), text, createdAt: item.at };
  }

  queueState(): QueueState {
    const pending = this.#inbound.filter((i) => i.state === "queued").length;
    return { queue: [], pendingCount: pending, hidden: [], inFlight: this.#activeTurn, paused: false };
  }

  resumeQueue(): void { void this.#drainInbound(); }
  editQueued(): boolean { return false; }
  cancelQueued(): boolean { return false; }
  reorderQueued(): boolean { return false; }

  async abort(): Promise<{ ok: true }> {
    if (this.#client && this.#ocSessionId) {
      try { await this.#client.interrupt(this.#ocSessionId); } catch { /* best effort */ }
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
  transcript(): { lines: unknown[] } { return { lines: [] }; }
  onHookEvent(): { ok: boolean } { return { ok: true }; }
  markCompacting(): void { /* server-side */ }
  reassertLifecycle(): void { void this.#relay?.updateJoyState(this.status === "ended" ? "detached" : "running"); }

  // ── teardown ──────────────────────────────────────────────────────────────

  end(reason: "killed" | "process_exited"): boolean {
    if (this.status === "ended") return false;
    this.status = "ended";
    this.endReason = reason;
    const relaySessionId = this.#relay?.relaySessionId ?? this.relaySessionId;
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
      void this.#relay?.updateJoyState("archived");
      if (this.#deps.relayClient && relaySessionId) this.#archivePromise = this.#deps.relayClient.archiveSession(relaySessionId);
      this.#relay?.stop();
      clearCodexInbound(this.id);
      deleteWindowRecord(this.id);
    }
    this.#deps.broadcast("session_update", this.toJSON());
    return true;
  }

  forceKill(): boolean {
    if (this.status === "ended") {
      const relaySessionId = this.relaySessionId;
      if (this.#deps.relayClient && relaySessionId) this.#archivePromise = this.#deps.relayClient.archiveSession(relaySessionId);
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
    const rs = await createRelaySession(this.#deps.relayClient, { tag: `joy-tmux-${this.id}`, cwd: this.cwd, id: this.id });
    this.attachRelay(rs);
  }
}
