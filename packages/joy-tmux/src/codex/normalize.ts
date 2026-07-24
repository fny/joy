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

import { randomUUID } from "crypto";
import {
  encodeTurnStart,
  encodeTextEvent,
  encodeToolCallStart,
  encodeToolCallEnd,
  encodeTurnEnd,
  type WireRecord,
} from "../relay/relay";

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
  | { kind: "confirmDispatch"; clientId: string }
  | { kind: "model"; code: string }
  | { kind: "context"; tokens: number };

// Tool-name parity with happy-app's codex renderers (CodexDiffView /
// CodexPatchView) and the claude wire vocabulary.
const TOOL_BASH = "CodexBash";
const TOOL_PATCH = "CodexPatch";
const TOOL_MCP = "McpTool";

type Item = Record<string, unknown>;

function itemType(item: Item): string { return typeof item.type === "string" ? item.type : ""; }
function str(v: unknown): string { return typeof v === "string" ? v : ""; }

export class CodexNormalizer {
  #mintId: () => string;
  // codex tool item id → codex turn id it belongs to (survives turn close, like
  // claude's #openTools, so tool-call-end resolves after turn-end). Also the
  // set used to close any still-open tools when a turn terminates (so app tool
  // cards can't spin forever — gpt-5.6-sol review #10).
  #openTools = new Map<string, string>();
  // The codex turn id currently in flight.
  #currentTurn: string | null = null;
  // The root thread id — the namespace for deterministic event ids. Captured
  // from the first notification carrying one (or set explicitly).
  #threadId = "";

  // The joy wire `turn` field IS the codex turn id (a stable UUIDv7). Using it
  // directly — rather than minting a random id per turn — makes turn identity
  // survive restarts, keeps reconciliation dedupe possible, and makes the
  // session's synthesized cancellation id match (gpt-5.6-sol review #6).
  constructor(mintId: () => string = randomUUID) {
    this.#mintId = mintId;
  }

  setThreadId(id: string): void { if (id) this.#threadId = id; }

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
      case "error": return this.#error(p);
      default: return [];
    }
  }

  #settings(p: Item): CodexEffect[] {
    // The authoritative configured model for the thread (there is no
    // `thread.model` on thread/started — review #4).
    const s = (p.threadSettings ?? {}) as Item;
    const model = str(s.model);
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
    for (const [call, turnId] of this.#openTools) {
      if (turnId === codexTurnId) out.push(this.#wire(encodeToolCallEnd(call, { turn: codexTurnId }), `turn:${codexTurnId}:item:${call}:tool-end`));
    }
    for (const call of [...this.#openTools.keys()]) if (this.#openTools.get(call) === codexTurnId) this.#openTools.delete(call);
    this.#currentTurn = null;
    out.push(this.#wire(encodeTurnEnd(status, { turn: codexTurnId }), `turn:${codexTurnId}:complete`));
    out.push({ kind: "thinking", value: false });
    return out;
  }

  #itemStarted(p: Item): CodexEffect[] {
    const item = (p.item ?? {}) as Item;
    const joyTurn = this.#turnFor(p);
    switch (itemType(item)) {
      case "userMessage": {
        // The echo of a dispatched message — confirms delivery by clientId,
        // does NOT re-emit as a wire record (the app already has the row).
        const clientId = str(item.clientId);
        return clientId ? [{ kind: "confirmDispatch", clientId }] : [];
      }
      case "commandExecution":
        return this.#toolStart(item, joyTurn, TOOL_BASH, { command: str(item.command), cwd: str(item.cwd) });
      case "fileChange":
        return this.#toolStart(item, joyTurn, TOOL_PATCH, { changes: item.changes ?? item.content ?? null });
      case "mcpToolCall":
        return this.#toolStart(item, joyTurn, TOOL_MCP, { server: item.server ?? null, tool: item.tool ?? item.name ?? null, arguments: item.arguments ?? null });
      default:
        return [];
    }
  }

  #itemCompleted(p: Item): CodexEffect[] {
    const item = (p.item ?? {}) as Item;
    const joyTurn = this.#turnFor(p);
    const id = str(item.id);
    switch (itemType(item)) {
      case "agentMessage": {
        const text = str(item.text).trim();
        if (!text) return [];
        const out: CodexEffect[] = [this.#wire(encodeTextEvent(text, { turn: joyTurn }), `turn:${joyTurn}:item:${id}:text`)];
        // Receipt on the group terminator so replay dedupes on the item id.
        if (id) out.push({ kind: "receipt", uuid: id, turn: joyTurn });
        return out;
      }
      case "commandExecution":
      case "fileChange":
      case "mcpToolCall":
        return this.#toolEnd(id);
      default:
        return [];
    }
  }

  #toolStart(item: Item, joyTurn: string, name: string, input: unknown): CodexEffect[] {
    const call = str(item.id) || this.#mintId();
    this.#openTools.set(call, joyTurn);
    return [this.#wire(encodeToolCallStart({ call, name, input, turn: joyTurn }), `turn:${joyTurn}:item:${call}:tool-start`)];
  }

  #toolEnd(call: string): CodexEffect[] {
    if (!call) return [];
    const turn = this.#openTools.get(call) ?? this.#currentTurn ?? "";
    this.#openTools.delete(call);
    return [this.#wire(encodeToolCallEnd(call, { turn }), `turn:${turn}:item:${call}:tool-end`)];
  }

  #turnFor(p: Item): string {
    return str(p.turnId) || (this.#currentTurn ?? "");
  }

  #tokenUsage(p: Item): CodexEffect[] {
    // `total` is CUMULATIVE billing usage (incl. output) — not current context
    // size. `last.inputTokens` is the closest analog to claude's context gauge
    // (gpt-5.6-sol review #10).
    const usage = (p.tokenUsage ?? {}) as Item;
    const last = (usage.last ?? {}) as Item;
    const tokens = typeof last.inputTokens === "number" ? last.inputTokens
      : (typeof (usage.total as Item)?.totalTokens === "number" ? (usage.total as Item).totalTokens as number : null);
    return tokens != null ? [{ kind: "context", tokens }] : [];
  }
}
