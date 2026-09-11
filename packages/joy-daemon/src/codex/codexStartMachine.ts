// The Codex session's START — connect or rejoin, read the thread's history
// once, replay it, then go live — as one explicit machine (the pattern of
// relay/leaseMachine.ts and relay/relayTurnMachine.ts: a pure total
// `nextStartState(state, event)` switch, effects handed back, every
// (phase, event) pair decided in codexStartMachine.test.ts).
//
// What it replaces in codexSession.ts: `#buffering` and `#notifBuffer`
// (notifications parked from connect until the reconcile finishes, finding
// #10), `#snapshotBoundary` (the client's notification barrier at the
// thread/read RESPONSE FRAME, #519), `#historyItems` (what the replay
// emitted, for binding a buffered live item to its replayed identity,
// #519), `#rejoined` (rejoin vs fresh spawn, finding #5 / #3c), and the
// delivered-turn high-water `#deliveredThrough` with its "" sentinel
// (finding #2, #67, #518).
//
// Phases:
//   idle              constructed; start() not called
//   rejoining         connect + thread/resume on the orphan's socket in
//                     flight (buffering; finding #7: nothing is trusted
//                     until the whole transaction succeeds)
//   spawning          a fresh app-server: spawn, connect, thread/start or
//                     thread/resume in flight (buffering)
//   reading_snapshot  the thread is bound; thread/read in flight. The
//                     barrier is UNKNOWN: a notification that arrives now
//                     may or may not be inside the snapshot (buffering)
//   snapshot_read     the read's response frame was handled at `barrier`;
//                     history is being replayed (buffering; binding pending)
//   live              flushed; notifications dispatch as they come
//   ended             the session is over; whatever a start step yields
//                     from now on is abandoned (Astra on d4fc9336 and
//                     d6b84547: a kill during the rejoin or the spawn owns
//                     nothing)
//
// The two rules the phases make expressible:
//   - `origin` (rejoin | fresh) is a variant of the bound phases, not a
//     flag: what an `inProgress` history turn means (a live orphan, or a
//     turn dead with the old server) is decided by which path bound the
//     thread, and cannot be set on one path and forgotten by the other;
//   - the barrier is a FACT OF THE RESPONSE FRAME: `read_response` carries
//     the client's notification count sampled when that frame was handled.
//     The old boundary was sampled after `await threadRead` resolved, and
//     a notification coalesced into the same socket write as the response
//     — dispatched before the continuation ran — counted as inside the
//     snapshot (#519). Here a buffered notification binds to a replayed
//     item only if `seq <= barrier`; past it, it is new by construction.
//
// The item-binding algorithm itself (exact ids first, then whole-content
// twins among positional history items, one candidate per (turn, type,
// live id), a slot consumed only when the normalizer binds) is the pure
// `bindBufferedItems` below; the machine decides WHEN it runs and with
// WHAT boundary (the `flush` effect).
import { itemSignature, isPositionalHistoryId, type CodexNotification } from "./normalize";

export type StartOrigin = "rejoin" | "fresh";
export type StartPhase = "idle" | "rejoining" | "spawning" | "reading_snapshot" | "snapshot_read" | "live" | "ended";
export const START_PHASES: readonly StartPhase[] = ["idle", "rejoining", "spawning", "reading_snapshot", "snapshot_read", "live", "ended"];

export interface Buffered { n: CodexNotification; seq: number }
/** One item the history replay emitted: its id (runtime or positional),
 *  type, canonical ordinal and whole-content signature; `matched` once a
 *  buffered live item bound to it. */
export interface HistoryItem { id: string; type: string; ordinal: number; sig: string; matched: boolean }

export interface StartState {
  phase: StartPhase;
  /** Which path bound the thread; null until one has. */
  origin: StartOrigin | null;
  threadId: string | null;
  /** The snapshot boundary (snapshot_read, live): the client's notification
   *  count at the thread/read response frame. 0 = no snapshot (a fresh
   *  thread has no history to bind to). */
  barrier: number;
  /** Notifications parked while buffering, in arrival order. */
  buffered: Buffered[];
  /** What the replay emitted, per turn (snapshot_read). */
  history: Map<string, HistoryItem[]>;
  endReason: string | null;
}

export type StartEvent =
  | { type: "start"; canRejoin: boolean }
  /** The rejoin transaction failed at any step: spawn fresh instead. */
  | { type: "rejoin_failed"; error: string }
  /** thread/resume answered on the current path (rejoin or fresh). */
  | { type: "thread_resumed"; threadId: string }
  /** thread/start answered: a new thread, nothing to read. */
  | { type: "thread_started"; threadId: string }
  /** The thread/read response FRAME was handled; `barrier` is the client's
   *  notification count at that moment. */
  | { type: "read_response"; barrier: number }
  /** The replay emitted these items for a turn. */
  | { type: "history_replayed"; turnId: string; items: HistoryItem[] }
  /** History replayed (or there was none): the runtime is up. */
  | { type: "reconcile_done" }
  | { type: "notification"; n: CodexNotification; seq: number }
  /** The session ended (end()). */
  | { type: "killed"; reason: string }
  /** The start sequence threw. */
  | { type: "start_failed"; error: string };
export const START_EVENT_TYPES: ReadonlyArray<StartEvent["type"]> = [
  "start", "rejoin_failed", "thread_resumed", "thread_started", "read_response", "history_replayed", "reconcile_done", "notification", "killed", "start_failed",
];

export type StartEffect =
  /** Spawn a fresh app-server (the rejoin did not hold). */
  | { type: "spawn" }
  /** Bind the buffered live items to the replayed history under `barrier`,
   *  then dispatch the buffered notifications in order. */
  | { type: "flush"; buffered: Buffered[]; barrier: number; history: Map<string, HistoryItem[]> }
  /** The runtime is up and its history replayed: tell the coordinator. */
  | { type: "ready" }
  /** A live notification: apply it now. */
  | { type: "dispatch"; n: CodexNotification }
  /** The session ended while this step was in flight: close what the step
   *  produced; this generation owns nothing. */
  | { type: "abandon" }
  /** The start failed: end the session as process_exited. */
  | { type: "end"; reason: "process_exited" };

export interface StartTransition { to: StartState; effects?: StartEffect[] }

export const initialStartState = (): StartState => ({
  phase: "idle", origin: null, threadId: null, barrier: 0, buffered: [], history: new Map(), endReason: null,
});

const BUFFERING: ReadonlySet<StartPhase> = new Set(["rejoining", "spawning", "reading_snapshot", "snapshot_read"]);
export const isBuffering = (s: StartState): boolean => BUFFERING.has(s.phase);
/** Did this session REJOIN a live app-server (vs spawn a fresh one)? Known
 *  from the thread binding on; false before. */
export const isRejoined = (s: StartState): boolean => s.origin === "rejoin";

/** The one answer for every (phase, event) pair, or null = the event is not
 *  meaningful in that phase and changes nothing. */
export function nextStartState(s: StartState, ev: StartEvent): StartTransition | null {
  // A notification's fate depends only on whether we are buffering.
  if (ev.type === "notification") {
    if (BUFFERING.has(s.phase)) return { to: { ...s, buffered: [...s.buffered, { n: ev.n, seq: ev.seq }] } };
    if (s.phase === "live") return { to: s, effects: [{ type: "dispatch", n: ev.n }] };
    return null; // idle: no client yet; ended: nobody to apply it
  }
  if (ev.type === "killed") {
    if (s.phase === "ended") return null;
    return { to: { ...s, phase: "ended", buffered: [], history: new Map(), endReason: ev.reason } };
  }
  if (ev.type === "start_failed") {
    if (s.phase === "ended" || s.phase === "idle") return null;
    return { to: { ...s, phase: "ended", buffered: [], history: new Map(), endReason: "process_exited" }, effects: [{ type: "end", reason: "process_exited" }] };
  }
  switch (s.phase) {
    case "idle": switch (ev.type) {
      case "start": return { to: { ...s, phase: ev.canRejoin ? "rejoining" : "spawning" }, effects: ev.canRejoin ? [] : [{ type: "spawn" }] };
      default: return null;
    }
    case "rejoining": switch (ev.type) {
      case "thread_resumed": return { to: { ...s, phase: "reading_snapshot", origin: "rejoin", threadId: ev.threadId } };
      // Reset any partial state so the fresh path starts clean.
      case "rejoin_failed": return { to: { ...s, phase: "spawning", origin: null, threadId: null }, effects: [{ type: "spawn" }] };
      default: return null;
    }
    case "spawning": switch (ev.type) {
      case "thread_resumed": return { to: { ...s, phase: "reading_snapshot", origin: "fresh", threadId: ev.threadId } };
      // A new thread has no history: nothing to read, nothing to bind.
      case "thread_started": return { to: { ...s, phase: "snapshot_read", origin: "fresh", threadId: ev.threadId, barrier: 0, history: new Map() } };
      default: return null;
    }
    case "reading_snapshot": switch (ev.type) {
      case "read_response": return { to: { ...s, phase: "snapshot_read", barrier: ev.barrier, history: new Map() } };
      default: return null;
    }
    case "snapshot_read": switch (ev.type) {
      case "history_replayed": {
        const history = new Map(s.history);
        history.set(ev.turnId, ev.items);
        return { to: { ...s, history } };
      }
      case "reconcile_done": return {
        to: { ...s, phase: "live", buffered: [], history: new Map() },
        effects: [{ type: "flush", buffered: s.buffered, barrier: s.barrier, history: s.history }, { type: "ready" }],
      };
      default: return null;
    }
    case "live": return null;
    case "ended": switch (ev.type) {
      // A start step that finishes after the end: whatever it made is not ours.
      case "rejoin_failed":
      case "thread_resumed":
      case "thread_started":
      case "read_response":
      case "reconcile_done":
        return { to: s, effects: [{ type: "abandon" }] };
      default: return null; // start, history_replayed: nothing to do
    }
  }
  return null;
}

// ── the flush: bind buffered live items to replayed history (#519) ──────────

type Candidate = { turnId: string; type: string; id: string; item: Record<string, unknown> };

/** A live item that completed while thread/read was pending may ALSO be in
 *  the history just replayed, under a positional id. Bind its live id to
 *  the ordinal replay allocated — its flush then re-emits the replayed
 *  localIds (relay-deduped) instead of minting a second identity for the
 *  same answer (#519) — but ONLY on proof it is the same occurrence:
 *   - the completion was on the wire before the thread/read response (its
 *     seq is within the barrier; anything past it is new by construction),
 *     AND
 *   - the runtime gave the same item id, or — for a history item under a
 *     POSITIONAL id only — the whole content, input and outcome, equals an
 *     unclaimed replayed item of the same turn+type.
 *  Exact ids are reserved FIRST, in their own pass: a content match made
 *  earlier in the buffer used to consume the replayed slot a later
 *  notification named by id, crossing the two identities. A history item
 *  that carries a runtime id (call_…/msg_…, not item-N) is that occurrence
 *  and no other: a live item under a DIFFERENT runtime id is a different
 *  execution however equal its content — call_old/call_new never alias.
 *  Equality of a command alone is not proof either: a NEW `date` buffered
 *  after the snapshot aliased the old `date` and the relay deduped its
 *  result away. An ambiguous occurrence keeps its own identity.
 *  One candidate per (turn, type, live id): a REPEATED completion of the
 *  same live item is the same occurrence, not another — it is coalesced
 *  before either pass, so it can neither consume a second history slot
 *  nor enter the content fallback. Uncoalesced, the repeat of msg-a
 *  claimed the slot of an equal second answer and the real msg-b was
 *  pushed to a third ordinal: three relay identities for two occurrences.
 *  And a slot is consumed only when the normalizer actually binds (`bind`
 *  answers true) — an id it already knows keeps the identity it has and
 *  leaves the slot free. */
export function bindBufferedItems(
  buffered: Buffered[], barrier: number, history: Map<string, HistoryItem[]>,
  bind: (turnId: string, type: string, id: string, ordinal: number) => boolean,
): void {
  if (!history.size) return;
  // Coalesced by occurrence identity, in first-seen order; a repeat's
  // payload (the latest word on the item) replaces the earlier one.
  const inside = new Map<string, Candidate>();
  for (const { n, seq } of buffered) {
    if (seq > barrier || n.method !== "item/completed") continue;
    const p = n.params ?? {};
    const turnId = typeof p.turnId === "string" ? p.turnId : "";
    const item = (p.item ?? {}) as Record<string, unknown>;
    const id = typeof item.id === "string" ? item.id : "";
    const type = typeof item.type === "string" ? item.type : "";
    if (!history.has(turnId) || !id || !type) continue;
    const key = `${turnId}|${type}|${id}`;
    const seen = inside.get(key);
    if (seen) seen.item = item; else inside.set(key, { turnId, type, id, item });
  }
  // Pass 1 — exact runtime ids: each binds its own twin, nothing else may.
  const unbound: Candidate[] = [];
  for (const c of inside.values()) {
    const hit = history.get(c.turnId)!.find((h) => !h.matched && h.type === c.type && h.id === c.id);
    if (!hit) { unbound.push(c); continue; }
    if (bind(c.turnId, c.type, c.id, hit.ordinal)) hit.matched = true;
  }
  // Pass 2 — whole-content twins among the still-unclaimed POSITIONAL
  // history items, for the live ids no history id named.
  for (const c of unbound) {
    const sig = itemSignature(c.item);
    if (!sig) continue;
    const hit = history.get(c.turnId)!.find((h) => !h.matched && h.type === c.type && isPositionalHistoryId(h.id) && h.sig === sig);
    if (!hit) continue;
    if (bind(c.turnId, c.type, c.id, hit.ordinal)) hit.matched = true;
  }
}

// ── the delivered-turn high-water (finding #2, #67, #518) ────────────────────
//
// The ledger's `codex_turn` checkpoint, as a value with three shapes instead
// of a nullable string whose empty string meant "a mark is pending, nothing
// committed": none | pending | committed(turnId). `deferredFloor` is the
// oldest turn whose history could NOT be replayed (itemsView != full): the
// mark never passes it, or the next recovery skips that turn's output for
// good once its full items are available (#518).

export type DeliveredMark = { kind: "none" } | { kind: "pending" } | { kind: "committed"; turnId: string };
export interface DeliveredState { mark: DeliveredMark; deferredFloor: string | null }
export type DeliveredEvent =
  /** The checkpoint row as loaded: null = none, "" = pending, else committed. */
  | { type: "loaded"; ref: string | null }
  /** A fresh thread under this id: the old mark is meaningless. */
  | { type: "cleared" }
  /** The read found the mark's turn gone from history (finding #5). */
  | { type: "rewound" }
  /** A turn whose replay was deferred (#518). */
  | { type: "deferred"; turnId: string }
  /** The relay acked the turn's terminal row. */
  | { type: "acked"; turnId: string };
export const DELIVERED_EVENT_TYPES: ReadonlyArray<DeliveredEvent["type"]> = ["loaded", "cleared", "rewound", "deferred", "acked"];
export interface DeliveredTransition { to: DeliveredState; /** Persist this mark. */ commit?: string; /** Clear the persisted mark. */ clear?: boolean }

export const initialDeliveredState = (): DeliveredState => ({ mark: { kind: "none" }, deferredFloor: null });
export const markRef = (m: DeliveredMark): string | null => (m.kind === "committed" ? m.turnId : null);
/** Is `turnId` covered by the mark (a lexicographic `<=` is chronological
 *  for UUIDv7)? A pending mark covers nothing. */
export const isDelivered = (m: DeliveredMark, turnId: string): boolean => m.kind === "committed" && !!turnId && turnId <= m.turnId;

export function nextDeliveredState(s: DeliveredState, ev: DeliveredEvent): DeliveredTransition | null {
  switch (ev.type) {
    case "loaded": return { to: { ...s, mark: ev.ref === null ? { kind: "none" } : ev.ref === "" ? { kind: "pending" } : { kind: "committed", turnId: ev.ref } } };
    case "cleared": return { to: { ...s, mark: { kind: "none" } }, clear: true };
    case "rewound": return s.mark.kind === "none" ? null : { to: { ...s, mark: { kind: "none" } }, clear: true };
    case "deferred": return s.deferredFloor && s.deferredFloor <= ev.turnId ? null : { to: { ...s, deferredFloor: ev.turnId } };
    case "acked": {
      if (!ev.turnId) return null;
      // Never past a turn whose history replay was deferred (#518): the mark
      // is a delivered PREFIX, and that turn is a hole in it.
      if (s.deferredFloor && ev.turnId >= s.deferredFloor) return null;
      // Only ever advances.
      if (s.mark.kind === "committed" && ev.turnId <= s.mark.turnId) return null;
      return { to: { ...s, mark: { kind: "committed", turnId: ev.turnId } }, commit: ev.turnId };
    }
  }
  return null;
}
