// Normalize codex app-server notifications into the SAME wire records the
// claude Session emits (turn-start / text / tool-call-start / tool-call-end /
// turn-end), plus the side-signals a Session applies (thinking, receipts, model
// code, context tokens, dispatch confirmation). Output parity with the claude
// variant is deliberate: the app renders both identically, and the tests assert
// the same wire sequence for the same logical turn.
//
// Built against a live 0.144.6 capture (src/codex/__fixtures__/) — the ground
// truth for the notification order:
//   turn/started → item(userMessage,clientId) → item(commandExecution) →
//   item(agentMessage) → thread/tokenUsage → thread/status(idle) → turn/completed
//
// The normalizer is a small stateful mapper (mirrors the claude Session's
// #turn / #openTools state): it maps codex turn ids → joy turn ids and tracks
// open tool calls, so CodexSession stays a thin applier of the effects.

import { randomUUID, createHash } from "crypto";
import { parseJoyTags } from "../domain/agentTagsPrompt";
import {
  encodeTurnStart,
  encodeTextEvent,
  encodeToolCallStart,
  encodeToolCallEnd,
  encodeTurnEnd,
  type WireRecord, encodeUserMessage } from "../relay/relay";

/** A codex JSON-RPC notification: { method, params }. */
export interface CodexNotification { method: string; params?: Record<string, unknown>; }

/** Side-effects a CodexSession applies to its RelaySession. Kept as data (not
 *  direct relay calls) so the mapping is pure and unit-testable. Each `wire`
 *  effect carries a DETERMINISTIC localId (the codex event identity) so a
 *  reconnect+replay re-sends the same id and the relay append layer dedupes. */
export type CodexEffect =
  | { kind: "wire"; record: WireRecord; localId: string }
  | { kind: "thinking"; value: boolean }
  | { kind: "receipt"; uuid: string; turn: string }
  | { kind: "confirmDispatch"; clientId: string; turn: string }
  /** A completed userMessage: the session decides (from the ids it dispatched)
   *  whether this is its own echo or a prompt typed in the attached TUI (#78). */
  | { kind: "userMessage"; clientId: string; text: string; turn: string; localId: string }
  | { kind: "model"; code: string }
  | { kind: "effort"; effort: string }
  | { kind: "context"; tokens: number }
  | { kind: "title"; value: string }
  | { kind: "notify"; headline: string; detail: string | null };

// Tool-name parity with joy-app's codex renderers (CodexDiffView /
// CodexPatchView) and the claude wire vocabulary.
const TOOL_BASH = "CodexBash";
const TOOL_PATCH = "CodexPatch";
const TOOL_MCP = "McpTool";

type Item = Record<string, unknown>;

/** Per-turn canonical identity state (#522): ordinal counters per item type and
 *  the transient-id → core mappings allocated within THIS turn only. */
interface TurnIdentity { ordinals: Map<string, number>; byId: Map<string, string> }

/** How many ended turns keep their identity state for late completions. */
const RETAINED_ENDED_TURNS = 16;

function itemType(item: Item): string { return typeof item.type === "string" ? item.type : ""; }
function str(v: unknown): string { return typeof v === "string" ? v : ""; }

export class CodexNormalizer {
  #mintId: () => string;
  // canonical tool call id → codex turn id it belongs to (survives turn close,
  // like claude's #openTools, so tool-call-end resolves after turn-end). Also
  // the set used to close any still-open tools when a turn terminates (so app
  // tool cards can't spin forever — review #10).
  #openTools = new Map<string, { turn: string; core: string }>();
  // The codex turn id currently in flight.
  #currentTurn: string | null = null;
  // The root thread id — the namespace for deterministic event ids. Captured
  // from the first notification carrying one (or set explicitly).
  #threadId = "";

  // CANONICAL ITEM IDENTITY (gpt-5.6-sol M2 finding #5). Live notifications and
  // thread/read history use DIFFERENT transient item ids (live msg_…/call_…;
  // history positional item-N), so keying wire dedup on the transient id
  // double-shows items across a restart. Instead we key on an ORDINAL within
  // (turnId, itemType): the Nth commandExecution of a turn is `…:commandExecution:N`
  // in BOTH live and history, because items appear in the same order. We map
  // each transient id → its canonical core on first sighting and reuse it.
  //
  // The transient→canonical map is scoped PER TURN and PER TYPE (#522). History
  // reuses positional ids across turns (every turn has an item-0, item-1, …),
  // so a flat map keyed by the transient id alone let turn 2's `item-1` inherit
  // turn 1's `commandExecution:0`: recovery then minted ids live delivery never
  // produced, duplicating one answer and suppressing another against the wrong
  // relay row. A mapping is only ever reused within the turn that allocated it.
  #turns = new Map<string, TurnIdentity>();
  // transient item id → where it was allocated. A completion that arrives AFTER
  // its turn ended (a late tool completion) is attributed to the turn that
  // STARTED the item, never to whatever turn is current — otherwise it consumed
  // the next turn's `commandExecution:0` completion id and the real one deduped
  // away as a replay (Astra medium, normalize.ts:264).
  #byTransient = new Map<string, { turn: string; type: string; core: string }>();
  // Ended turns, oldest first — identity state is retained for a few turns so a
  // late completion still resolves, then pruned so a long session stays bounded.
  #endedTurns: string[] = [];

  // The joy wire `turn` field IS the codex turn id (a stable UUIDv7). Using it
  // directly — rather than minting a random id per turn — makes turn identity
  // survive restarts, keeps reconciliation dedupe possible, and makes the
  // session's synthesized cancellation id match (gpt-5.6-sol review #6).
  constructor(mintId: () => string = randomUUID) {
    this.#mintId = mintId;
  }

  setThreadId(id: string): void { if (id) this.#threadId = id; }

  #turnState(turnId: string): TurnIdentity {
    let t = this.#turns.get(turnId);
    if (!t) { t = { ordinals: new Map(), byId: new Map() }; this.#turns.set(turnId, t); }
    return t;
  }

  /** Allocate (or reuse) the canonical `${type}:${ordinal}` core for an item,
   *  keyed by (turn, type, transient id). Same order of items → same ordinals
   *  live vs history, regardless of the transient id strings; a transient id
   *  seen in ANOTHER turn (history's positional ids) never shares a mapping (#522). */
  #canonicalCore(turnId: string, type: string, transientId: string): string {
    const state = this.#turnState(turnId);
    const key = `${type}|${transientId}`;
    if (transientId && state.byId.has(key)) return state.byId.get(key)!;
    const ord = state.ordinals.get(type) ?? 0;
    state.ordinals.set(type, ord + 1);
    const core = `${type}:${ord}`;
    if (transientId) {
      state.byId.set(key, core);
      this.#byTransient.set(transientId, { turn: turnId, type, core });
    }
    return core;
  }

  /** Bind a LIVE transient item id to a canonical ordinal that history replay
   *  already allocated for the same item (#519). A live item buffered while
   *  thread/read was pending is also in the returned history under a
   *  positional id; without the binding its flush allocated a second ordinal
   *  — a second localId for the same answer, past the relay's dedupe. */
  bindTransient(turnId: string, type: string, transientId: string, ordinal: number): void {
    if (!turnId || !type || !transientId) return;
    const state = this.#turnState(turnId);
    const key = `${type}|${transientId}`;
    if (state.byId.has(key)) return;
    const core = `${type}:${ordinal}`;
    state.byId.set(key, core);
    this.#byTransient.set(transientId, { turn: turnId, type, core });
  }

  /** The turn an item/completed belongs to. An item whose start we saw resolves
   *  to the turn that allocated it — even after that turn ended and a new one
   *  began (late tool completion). An explicit turnId that names a DIFFERENT
   *  turn means the transient id was reused (history positional ids) and wins. */
  #turnForCompleted(p: Item, type: string, transientId: string): string {
    const explicit = str(p.turnId);
    const seen = transientId ? this.#byTransient.get(transientId) : undefined;
    if (seen && seen.type === type && (!explicit || explicit === seen.turn) && this.#turns.has(seen.turn)) return seen.turn;
    return explicit || (this.#currentTurn ?? "");
  }

  /** Forget the identity state of turns that ended long enough ago that no
   *  late completion can still reference them (bounded memory; #522). */
  #pruneEndedTurns(): void {
    while (this.#endedTurns.length > RETAINED_ENDED_TURNS) {
      const old = this.#endedTurns.shift()!;
      this.#turns.delete(old);
      for (const [id, meta] of this.#byTransient) if (meta.turn === old) this.#byTransient.delete(id);
    }
  }

  /** Deterministic relay localId for a wire event — a reconnect replay of the
   *  same codex event produces the same id, so the append layer dedupes it. */
  #eventId(suffix: string): string { return `codex:${this.#threadId}:${suffix}`; }
  #wire(record: WireRecord, suffix: string): CodexEffect {
    return { kind: "wire", record, localId: this.#eventId(suffix) };
  }

  handle(n: CodexNotification): CodexEffect[] {
    const p = n.params ?? {};
    // Capture the thread id lazily from any notification that carries one.
    if (!this.#threadId) {
      const tid = typeof p.threadId === "string" ? p.threadId : ((p.thread as Item | undefined)?.id);
      if (typeof tid === "string") this.#threadId = tid;
    }
    switch (n.method) {
      case "thread/status/changed": return this.#status(p);
      case "turn/started": return this.#turnStarted(p);
      case "turn/completed": return this.#turnEnded(p);
      case "item/started": return this.#itemStarted(p);
      case "item/completed": return this.#itemCompleted(p);
      case "thread/tokenUsage/updated": return this.#tokenUsage(p);
      case "thread/settings/updated": return this.#settings(p);
      case "model/rerouted": return this.#rerouted(p);
      case "error": return this.#error(p);
      default: return [];
    }
  }

  #settings(p: Item): CodexEffect[] {
    // The authoritative configured model AND reasoning effort for the thread
    // (there is no `thread.model` on thread/started — review #4; settings
    // carries BOTH — finding #8).
    const s = (p.threadSettings ?? {}) as Item;
    const out: CodexEffect[] = [];
    const model = str(s.model);
    if (model) out.push({ kind: "model", code: model });
    const effort = str(s.effort) || str(s.reasoningEffort);
    if (effort) out.push({ kind: "effort", effort });
    return out;
  }

  #rerouted(p: Item): CodexEffect[] {
    // The server rerouted the turn to a different model — reflect it so the
    // displayed model metadata doesn't go stale (finding #10).
    const model = str(p.model) || str((p.to as Item | undefined)?.model);
    return model ? [{ kind: "model", code: model }] : [];
  }

  #error(p: Item): CodexEffect[] {
    // `error {threadId, turnId, error, willRetry}` — a non-retrying error still
    // gets a terminal turn/completed(status:failed) after it, which closes the
    // turn. Nothing to emit as a wire record here (M1); surface later.
    void p;
    return [];
  }

  #status(p: Item): CodexEffect[] {
    const status = (p.status ?? {}) as Item;
    const t = str(status.type);
    if (t === "active") return [{ kind: "thinking", value: true }];
    if (t === "idle" || t === "systemError") return [{ kind: "thinking", value: false }];
    return [];
  }

  #turnStarted(p: Item): CodexEffect[] {
    const turn = (p.turn ?? {}) as Item;
    const codexTurnId = str(turn.id);
    if (!codexTurnId) return [];
    this.#currentTurn = codexTurnId;
    return [this.#wire(encodeTurnStart({ turn: codexTurnId }), `turn:${codexTurnId}:start`)];
  }

  #turnEnded(p: Item): CodexEffect[] {
    const turn = (p.turn ?? {}) as Item;
    const codexTurnId = str(turn.id) || (this.#currentTurn ?? "");
    if (!codexTurnId) return [];
    const codexStatus = str(turn.status);
    const status: "completed" | "failed" | "cancelled" =
      codexStatus === "interrupted" ? "cancelled"
        : codexStatus === "failed" ? "failed"
          : "completed";
    const out: CodexEffect[] = [];
    // Close any tool calls still open at turn end so their cards don't spin.
    for (const [call, meta] of this.#openTools) {
      if (meta.turn === codexTurnId) out.push(this.#wire(encodeToolCallEnd(call, { turn: codexTurnId }), `turn:${codexTurnId}:item:${meta.core}:tool-end`));
    }
    for (const [call, meta] of [...this.#openTools]) if (meta.turn === codexTurnId) this.#openTools.delete(call);
    this.#currentTurn = null;
    if (!this.#endedTurns.includes(codexTurnId)) { this.#endedTurns.push(codexTurnId); this.#pruneEndedTurns(); }
    out.push(this.#wire(encodeTurnEnd(status, { turn: codexTurnId }), `turn:${codexTurnId}:complete`));
    // Delivery receipt on the turn's TERMINAL row (the turn-end just queued).
    // The session advances the delivered-turn checkpoint only when THIS row is
    // ACKed by the relay server — never before (gpt-5.6-sol M2 finding #2), so
    // a crash before the terminal records are durable replays the turn.
    out.push({ kind: "receipt", uuid: `turn:${codexTurnId}`, turn: codexTurnId });
    out.push({ kind: "thinking", value: false });
    return out;
  }

  #itemStarted(p: Item): CodexEffect[] {
    const item = (p.item ?? {}) as Item;
    const joyTurn = this.#turnFor(p);
    const type = itemType(item);
    // Allocate this item's canonical ordinal on first sighting (started), so
    // live and history agree — even for types that emit no wire record.
    const core = this.#canonicalCore(joyTurn, type, str(item.id));
    switch (type) {
      case "userMessage": {
        // The echo of a dispatched message — confirms delivery by clientId,
        // does NOT re-emit as a wire record (the app already has the row).
        // (Fresh-card replay emits user rows from the SESSION, BEFORE the
        // turn bracket — see #reconcileHistoryInner — because live ordering
        // is user-row-then-turn-start and the app's positional grouper
        // mis-brackets a user message that lands inside the turn.)
        const clientId = str(item.clientId) || str(item.clientUserMessageId);
        return clientId ? [{ kind: "confirmDispatch", clientId, turn: joyTurn }] : [];
      }
      case "commandExecution":
        return this.#toolStart(joyTurn, core, TOOL_BASH, { command: str(item.command), cwd: str(item.cwd) });
      case "fileChange":
        return this.#toolStart(joyTurn, core, TOOL_PATCH, { changes: item.changes ?? item.content ?? null });
      case "mcpToolCall":
        return this.#toolStart(joyTurn, core, TOOL_MCP, { server: item.server ?? null, tool: item.tool ?? item.name ?? null, arguments: item.arguments ?? null });
      default:
        return [];
    }
  }

  #itemCompleted(p: Item): CodexEffect[] {
    const item = (p.item ?? {}) as Item;
    const type = itemType(item);
    const transientId = str(item.id);
    const joyTurn = this.#turnForCompleted(p, type, transientId);
    const core = this.#canonicalCore(joyTurn, type, transientId);
    switch (type) {
      case "agentMessage": {
        const raw = str(item.text).trim();
        if (!raw) return [];
        const { title, notifies, text } = parseJoyTags(raw);
        const out: CodexEffect[] = [];
        if (title) out.push({ kind: "title", value: title });
        for (const n of notifies) out.push({ kind: "notify", headline: n.headline, detail: n.detail });
        // Canonical (turn, ordinal) localId — same across live + history replay.
        if (text) out.push(this.#wire(encodeTextEvent(text, { turn: joyTurn }), `turn:${joyTurn}:item:${core}:text`));
        return out;
      }
      case "commandExecution":
      case "fileChange":
      case "mcpToolCall":
        return this.#toolEnd(joyTurn, core, item);
      case "userMessage": {
        const clientId = str(item.clientId) || str(item.clientUserMessageId);
        const text = userMessageText(item);
        return text ? [{ kind: "userMessage", clientId, text, turn: joyTurn, localId: `turn:${joyTurn}:item:${core}:user` }] : [];
      }
      default:
        return [];
    }
  }

  #toolStart(joyTurn: string, core: string, name: string, input: unknown): CodexEffect[] {
    const call = `${joyTurn}:${core}`;
    this.#openTools.set(call, { turn: joyTurn, core });
    return [this.#wire(encodeToolCallStart({ call, name, input, turn: joyTurn }), `turn:${joyTurn}:item:${core}:tool-start`)];
  }

  #toolEnd(joyTurn: string, core: string, item?: Item): CodexEffect[] {
    const call = `${joyTurn}:${core}`;
    // The end row belongs to the turn that owns the call — NOT to #currentTurn.
    // A completion landing after its turn closed (and the next one opened) used
    // to be stamped with the new turn, so its localId collided with the next
    // turn's first `…:tool-end` and the relay deduped the real one away.
    const turn = this.#openTools.get(call)?.turn ?? joyTurn;
    this.#openTools.delete(call);
    // Carry the harness's output and failure status: a completion with an
    // empty result was indistinguishable from success in the app (#68).
    const { result, isError } = toolOutcome(item);
    return [this.#wire(encodeToolCallEnd(call, { turn, ...(result !== undefined ? { result } : {}), ...(isError ? { isError } : {}) }), `turn:${turn}:item:${core}:tool-end`)];
  }

  #turnFor(p: Item): string {
    return str(p.turnId) || (this.#currentTurn ?? "");
  }

  #tokenUsage(p: Item): CodexEffect[] {
    // `last.inputTokens` is the current context size (the analog to claude's
    // context gauge). The cumulative `total.totalTokens` is billing usage incl.
    // output — NOT context — so we do NOT fall back to it (finding #10): a wrong
    // gauge is worse than a briefly-absent one.
    const usage = (p.tokenUsage ?? {}) as Item;
    const last = (usage.last ?? {}) as Item;
    return typeof last.inputTokens === "number" ? [{ kind: "context", tokens: last.inputTokens }] : [];
  }
}

/** Is `id` one of thread/read's POSITIONAL item ids (`item-N`, reissued per
 *  turn) rather than the runtime's own identity for an item (`msg_…`,
 *  `call_…`, a UUID)? Only a positional twin may be recognised by content;
 *  a history item under a runtime id IS that occurrence, and a live item
 *  under a different runtime id is another one (#519). */
export function isPositionalHistoryId(id: string): boolean {
  return !id || /^item-\d+$/.test(id);
}

/** The WHOLE observable content of a completed item — input AND outcome —
 *  as it reads in both its live and history forms (the transient ids differ:
 *  live msg_…/call_…, history item-N). Used to recognise a buffered live
 *  completion in the history just replayed (#519). The outcome is part of
 *  it on purpose: equality of the command alone is not proof of the same
 *  occurrence — a NEW `date` after the snapshot aliased the old one and the
 *  relay deduped its result away. Built from the RAW item fields — cwd,
 *  the exit code itself, a digest of the full output/patch/payload — never
 *  from the display form toolOutcome() renders: that one clamps the middle
 *  of a long output and folds every non-zero exit into "isError", so two
 *  executions that differed only there read as one. Empty when the type
 *  carries nothing comparable — never matched on. */
export function itemSignature(item: Item): string {
  switch (itemType(item)) {
    case "agentMessage": return str(item.text).trim();
    case "userMessage": return userMessageText(item).trim();
    case "commandExecution": {
      const stdout = str(item.aggregatedOutput) || str(item.output) || str(item.stdout);
      const code = typeof item.exitCode === "number" ? item.exitCode : (typeof item.exit_code === "number" ? item.exit_code : null);
      return JSON.stringify({
        command: item.command ?? null, cwd: str(item.cwd) || null, status: str(item.status), exitCode: code,
        output: digest(stdout), stderr: digest(str(item.stderr)),
      });
    }
    case "fileChange": {
      if (item.changes === undefined && item.content === undefined) return "";
      return JSON.stringify({ changes: digest(canonicalJson(item.changes ?? item.content)), status: str(item.status), error: digest(canonicalJson(item.error ?? null)) });
    }
    case "mcpToolCall": {
      return JSON.stringify({
        server: item.server ?? null, tool: item.tool ?? item.name ?? null,
        input: digest(canonicalJson(item.arguments ?? item.input ?? null)), status: str(item.status),
        output: digest(canonicalJson(item.result ?? null)), error: digest(canonicalJson(item.error ?? null)),
      });
    }
    default: return "";
  }
}

/** sha256 of the FULL text — an equality key that keeps every byte in
 *  play without carrying a 48k output around in the signature. */
function digest(text: string): string {
  return text ? createHash("sha256").update(text).digest("hex") : "";
}

/** JSON with object keys sorted, so the same payload in either form
 *  (live or history) digests identically regardless of key order. */
function canonicalJson(v: unknown): string {
  if (v === null || v === undefined) return "";
  return JSON.stringify(v, (_k, val) => (val && typeof val === "object" && !Array.isArray(val))
    ? Object.fromEntries(Object.keys(val as Record<string, unknown>).sort().map((k) => [k, (val as Record<string, unknown>)[k]]))
    : val);
}

/** Text of a codex userMessage item — `text`, or the joined text parts of `content`. */
export function userMessageText(item: Item): string {
  const direct = str(item.text);
  if (direct) return direct;
  const content = item.content;
  if (Array.isArray(content)) return content.map((c) => (c && typeof c === "object" ? str((c as Item).text) : "")).filter(Boolean).join("\n");
  return "";
}

/** Output + failure status of a completed codex tool item, per item type. */
function toolOutcome(item?: Item): { result?: string; isError?: boolean } {
  if (!item) return {};
  const type = itemType(item);
  const clamp = (v: string) => (v.length > 48_000 ? `${v.slice(0, 24_000)}\n…[truncated]…\n${v.slice(-24_000)}` : v);
  if (type === "commandExecution") {
    const out = str(item.aggregatedOutput) || str(item.output) || str(item.stdout);
    const code = typeof item.exitCode === "number" ? item.exitCode : (typeof item.exit_code === "number" ? item.exit_code : undefined);
    const failed = (code !== undefined && code !== 0) || str(item.status) === "failed";
    const text = out || (code !== undefined ? `exit ${code}` : "");
    return { result: text ? clamp(text) : undefined, isError: failed || undefined };
  }
  if (type === "fileChange") {
    // Only a failure is worth a result line; a plain "completed" status is noise.
    const failed = str(item.status) === "failed" || !!item.error;
    const detail = failed ? (str(item.error) || str(item.status)) : "";
    return { result: detail ? clamp(detail) : undefined, isError: failed || undefined };
  }
  if (type === "mcpToolCall") {
    const err = item.error;
    const res = item.result;
    const text = err !== undefined && err !== null ? (typeof err === "string" ? err : JSON.stringify(err)) : (res !== undefined && res !== null ? (typeof res === "string" ? res : JSON.stringify(res)) : "");
    return { result: text ? clamp(text) : undefined, isError: err !== undefined && err !== null ? true : (str(item.status) === "failed" || undefined) };
  }
  return {};
}
