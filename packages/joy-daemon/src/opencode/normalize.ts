// Normalize opencode SSE events into joy wire records (same claude-shaped
// sequence the other adapters emit: turn-start / tool-call-start /
// tool-call-end / text / turn-end). Design: docs/plans/opencode-adapter-design.md.
//
// Identity model (verified live, 2026-08-01): opencode part ids are STABLE and
// identical between live events and GET /message history (textID "text-0",
// callID "bash_0", assistantMessageID msg_…), so deterministic localIds need no
// ordinal machinery — `oc:<session>:<assistantMsg>:<partId>` is the same on
// both paths and the relay append layer dedupes replays.
//
// Turn model: a JOY turn = one admitted user prompt → session idle. opencode
// "steps" are individual LLM calls (a tool turn has several); we do NOT map
// steps to turns. turn id = the admitted user messageID (stable, ours when we
// supply it). turn-end is emitted by the SESSION (wait() resolution / idle),
// not the normalizer — the event stream has no reliable single terminal event.
//
// Whole-block text policy (design decision #2): emit on text.ended, ignore
// deltas. reasoning.* parts map to nothing (design: never chat text).

import {
  encodeTurnStart,
  encodeTextEvent,
  encodeToolCallStart,
  encodeToolCallEnd,
  type WireRecord,
} from "../relay/relay";
import type { OpencodeEvent } from "./opencodeClient";
import { parseJoyTags } from "../domain/agentTagsPrompt";

export type OpencodeEffect =
  | { kind: "wire"; record: WireRecord; localId: string }
  | { kind: "thinking"; value: boolean }
  | { kind: "confirmPrompt"; messageID: string }
  | { kind: "model"; code: string }
  | { kind: "receipt"; uuid: string; turn: string }
  // Terminal step (finish !== 'tool-calls') / turn failure. /wait is 503
  // "not available yet" permanently on 1.18.10, and no session.idle flows on
  // /api/event — step finish reasons are the only live turn-end signal.
  | { kind: "turnDone"; finish: string }
  | { kind: "turnFailed"; message: string }
  // Context gauge: step.ended carries tokens {input, output, cache} for the
  // LLM call — input + cache.read is the occupied context (codex parity:
  // the last call's prompt size IS the context).
  | { kind: "context"; tokens: number }
  // Agent re-title via the <joy-title/> convention (instruction rides the
  // first-prompt preamble — config `instructions` is ignored by serve).
  | { kind: "title"; value: string }
  | { kind: "notify"; headline: string; detail: string | null };

const TOOL_NAME_PREFIX = "Opencode";

/** Pull a `<joy-title value="…"/>` out of assistant text: returns the title
 *  (last one wins) and the text with tag lines removed. */
export function extractJoyTitle(text: string): { title: string | null; text: string } {
  const r = parseJoyTags(text);
  return { title: r.title, text: r.text };
}

function str(v: unknown): string { return typeof v === "string" ? v : ""; }

export class OpencodeNormalizer {
  #sessionID: string;
  // Current joy turn = the last admitted user messageID.
  #turn: string | null = null;
  // Open tool calls: callID → localId core, so turn-end can close leftovers.
  #openTools = new Map<string, string>();
  // durable.seq dedupe: events at or below this were already handled (SSE
  // reconnects replay; history reconcile also feeds synthetic events).
  #lastSeq = 0;
  // Last user/assistant message id seen on the live stream — the session's
  // reconcile checkpoint advances to this when a turn completes.
  #lastMessageId: string | null = null;

  constructor(sessionID: string) { this.#sessionID = sessionID; }

  get currentTurn(): string | null { return this.#turn; }
  get lastMessageId(): string | null { return this.#lastMessageId; }
  /** Start a turn explicitly (reconcile replay / recovered state). */
  setTurn(t: string | null): void { this.#turn = t; }

  #lid(suffix: string): string { return `oc:${this.#sessionID}:${suffix}`; }
  #wire(record: WireRecord, suffix: string): OpencodeEffect {
    return { kind: "wire", record, localId: this.#lid(suffix) };
  }

  /** Close any tools still open (turn end / interrupt) — cards must not spin. */
  closeOpenTools(): OpencodeEffect[] {
    const out: OpencodeEffect[] = [];
    for (const [, core] of this.#openTools) {
      out.push(this.#wire(encodeToolCallEnd(core, { turn: this.#turn ?? "" }), `${core}:tool-end`));
    }
    this.#openTools.clear();
    return out;
  }

  handle(e: OpencodeEvent): OpencodeEffect[] {
    const d = e.data ?? {};
    // Only this session's events (the global stream carries every session).
    const sid = str(d.sessionID) || str(e.durable?.aggregateID);
    if (sid && sid !== this.#sessionID) return [];
    // durable.seq dedupe (monotonic per session). Events without seq pass.
    const seq = e.durable?.seq;
    if (typeof seq === "number") {
      if (seq <= this.#lastSeq) return [];
      this.#lastSeq = seq;
    }

    switch (e.type) {
      case "session.next.prompt.admitted": {
        // Our own prompt entering the turn pipeline: confirms delivery (spool
        // removal) and opens the joy turn.
        const messageID = str(d.messageID);
        if (!messageID) return [];
        this.#lastMessageId = messageID;
        // Steer-into-open-turn: an admission while a turn is running is the
        // steered message joining THAT turn (verified live 2026-08-03: the
        // assistant flow continues, no new turn) — confirm delivery but do
        // NOT open a second turn; the original turn's end closes everything.
        if (this.#turn) return [{ kind: "confirmPrompt", messageID }];
        this.#turn = messageID;
        return [
          { kind: "confirmPrompt", messageID },
          { kind: "thinking", value: true },
          this.#wire(encodeTurnStart({ turn: messageID }), `${messageID}:turn-start`),
        ];
      }
      case "session.next.step.started": {
        // A step is one LLM call, not a joy turn — but it carries the
        // authoritative model, worth mirroring.
        const amid = str(d.assistantMessageID);
        if (amid) this.#lastMessageId = amid;
        const model = (d.model as Record<string, unknown> | undefined);
        const code = model ? str(model.id) : "";
        return code ? [{ kind: "model", code }] : [];
      }
      case "session.next.text.ended": {
        const raw = str(d.text).trim();
        const { title, notifies, text } = parseJoyTags(raw);
        const out: OpencodeEffect[] = [];
        if (title) out.push({ kind: "title", value: title });
        for (const n of notifies) out.push({ kind: "notify", headline: n.headline, detail: n.detail });
        if (!text) return out;
        if (!this.#turn) { out.push(this.#orphanText(text, d)); return out; }
        const core = `${str(d.assistantMessageID)}:${str(d.textID)}`;
        out.push(this.#wire(encodeTextEvent(text, { turn: this.#turn }), `${core}:text`));
        return out;
      }
      case "session.next.tool.called": {
        const callID = str(d.callID);
        if (!callID || !this.#turn) return [];
        const core = `${str(d.assistantMessageID)}:${callID}`;
        this.#openTools.set(callID, core);
        const name = TOOL_NAME_PREFIX + (str(d.tool) || "Tool").replace(/^[a-z]/, (c) => c.toUpperCase());
        return [this.#wire(
          encodeToolCallStart({ call: core, name, input: d.input ?? null, turn: this.#turn }),
          `${core}:tool-start`,
        )];
      }
      case "session.next.tool.success":
      case "session.next.tool.error": {
        const callID = str(d.callID);
        const core = this.#openTools.get(callID) ?? `${str(d.assistantMessageID)}:${callID}`;
        this.#openTools.delete(callID);
        if (!callID || !this.#turn) return [];
        // Carry the output / error so the card is inspectable (#68).
        const isError = e.type === "session.next.tool.error";
        const raw = isError ? (d.error ?? d.output ?? d.title) : (d.output ?? d.result ?? d.title);
        const result = raw === undefined || raw === null ? undefined : (typeof raw === "string" ? raw : JSON.stringify(raw));
        const clamped = result && result.length > 48_000 ? `${result.slice(0, 24_000)}\n…[truncated]…\n${result.slice(-24_000)}` : result;
        return [this.#wire(encodeToolCallEnd(core, { turn: this.#turn, ...(clamped ? { result: clamped } : {}), ...(isError ? { isError: true } : {}) }), `${core}:tool-end`)];
      }
      case "session.next.step.ended": {
        // One step = one LLM call; finish 'tool-calls' means the turn
        // continues with another step. Anything else ('stop', 'length', …)
        // ends the joy turn. Every step refreshes the context gauge.
        const out: OpencodeEffect[] = [];
        const tokens = d.tokens as Record<string, unknown> | undefined;
        const input = Number(tokens?.input ?? NaN);
        const cacheRead = Number((tokens?.cache as Record<string, unknown> | undefined)?.read ?? 0);
        if (Number.isFinite(input) && input > 0) out.push({ kind: "context", tokens: input + cacheRead });
        const finish = str(d.finish);
        if (this.#turn && finish !== "tool-calls") out.push({ kind: "turnDone", finish });
        return out;
      }
      case "session.next.step.failed":
      case "session.error": {
        if (!this.#turn) return [];
        const err = d.error as Record<string, unknown> | undefined;
        const message = str(err?.message) || str(d.message) || e.type;
        return [{ kind: "turnFailed", message }];
      }
      // Whole-block policy: deltas and reasoning are deliberately silent.
      case "session.next.text.started":
      case "session.next.text.delta":
      case "session.next.reasoning.started":
      case "session.next.reasoning.delta":
      case "session.next.reasoning.ended":
      case "session.next.tool.input.started":
      case "session.next.tool.input.delta":
      case "session.next.tool.input.ended":
      case "session.next.prompted":
        return [];
      default:
        return [];
    }
  }

  /** Text arriving with no open turn (e.g. a TUI-driven or queued turn we
   *  didn't admit) — still surface it under a deterministic synthetic turn so
   *  nothing is silently lost. */
  #orphanText(text: string, d: Record<string, unknown>): OpencodeEffect {
    const amid = str(d.assistantMessageID) || "orphan";
    return this.#wire(encodeTextEvent(text, { turn: amid }), `${amid}:${str(d.textID)}:text`);
  }
}
