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
 *  direct relay calls) so the mapping is pure and unit-testable. */
export type CodexEffect =
  | { kind: "wire"; record: WireRecord }
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
  // codex turn id → joy turn id (joy mints its own, as claude does).
  #turnIds = new Map<string, string>();
  // codex tool item id → joy turn id it belongs to (survives turn close, like
  // claude's #openTools, so tool-call-end resolves after turn-end).
  #openTools = new Map<string, string>();
  // The joy turn id of the turn currently in flight (for stamping receipts).
  #currentTurn: string | null = null;

  constructor(mintId: () => string = randomUUID) {
    this.#mintId = mintId;
  }

  /** joy turn id for a codex turn id, minting + remembering on first sight. */
  #joyTurn(codexTurnId: string): string {
    let id = this.#turnIds.get(codexTurnId);
    if (!id) { id = this.#mintId(); this.#turnIds.set(codexTurnId, id); }
    return id;
  }

  handle(n: CodexNotification): CodexEffect[] {
    const p = n.params ?? {};
    switch (n.method) {
      case "thread/started": return this.#threadStarted(p);
      case "thread/status/changed": return this.#status(p);
      case "turn/started": return this.#turnStarted(p);
      case "turn/completed":
      case "turn/aborted": return this.#turnEnded(n.method, p);
      case "item/started": return this.#itemStarted(p);
      case "item/completed": return this.#itemCompleted(p);
      case "thread/tokenUsage/updated": return this.#tokenUsage(p);
      default: return [];
    }
  }

  #threadStarted(p: Item): CodexEffect[] {
    const thread = (p.thread ?? {}) as Item;
    const model = str(thread.model);
    return model ? [{ kind: "model", code: model }] : [];
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
    const joyTurn = this.#joyTurn(codexTurnId);
    this.#currentTurn = joyTurn;
    return [{ kind: "wire", record: encodeTurnStart({ turn: joyTurn }) }];
  }

  #turnEnded(method: string, p: Item): CodexEffect[] {
    const turn = (p.turn ?? {}) as Item;
    const codexTurnId = str(turn.id);
    const joyTurn = codexTurnId ? this.#joyTurn(codexTurnId) : (this.#currentTurn ?? "");
    if (!joyTurn) return [];
    const codexStatus = str(turn.status);
    const status: "completed" | "failed" | "cancelled" =
      method === "turn/aborted" || codexStatus === "interrupted" ? "cancelled"
        : codexStatus === "failed" ? "failed"
          : "completed";
    this.#currentTurn = null;
    this.#turnIds.delete(codexTurnId);
    return [
      { kind: "wire", record: encodeTurnEnd(status, { turn: joyTurn }) },
      { kind: "thinking", value: false },
    ];
  }

  #itemStarted(p: Item): CodexEffect[] {
    const item = (p.item ?? {}) as Item;
    const joyTurn = this.#turnForItem(p);
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
    const joyTurn = this.#turnForItem(p);
    const id = str(item.id);
    switch (itemType(item)) {
      case "agentMessage": {
        const text = str(item.text).trim();
        if (!text) return [];
        const out: CodexEffect[] = [{ kind: "wire", record: encodeTextEvent(text, { turn: joyTurn }) }];
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
    return [{ kind: "wire", record: encodeToolCallStart({ call, name, input, turn: joyTurn }) }];
  }

  #toolEnd(call: string): CodexEffect[] {
    if (!call) return [];
    const turn = this.#openTools.get(call) ?? this.#currentTurn ?? "";
    this.#openTools.delete(call);
    return [{ kind: "wire", record: encodeToolCallEnd(call, { turn }) }];
  }

  #turnForItem(p: Item): string {
    const codexTurnId = str(p.turnId);
    return codexTurnId ? this.#joyTurn(codexTurnId) : (this.#currentTurn ?? "");
  }

  #tokenUsage(p: Item): CodexEffect[] {
    const usage = (p.tokenUsage ?? {}) as Item;
    const total = (usage.total ?? {}) as Item;
    const tokens = typeof total.totalTokens === "number" ? total.totalTokens : null;
    return tokens != null ? [{ kind: "context", tokens }] : [];
  }
}
