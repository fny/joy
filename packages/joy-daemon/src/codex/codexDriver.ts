// The codex RuntimeDriver (Wave C2): the coordinator's view of a codex
// app-server thread. It submits ONE turn/start per attempt, interrupts by
// turn id, reports what the app-server says as observations, and answers
// "what became of this attempt" from thread/read after a restart. It owns
// no queue, no outcome cache and no dispatch policy — those live in
// domain/coordinator.ts; CodexSession keeps the client, the normalizer, the
// approvals, the attach TUI and the card.
//
// Capability facts the coordinator relies on:
//   - ambiguousSubmit: a turn/start that times out or loses its socket MAY
//     have landed — the result is `unknown`, reconciled from thread/read
//     (the clientUserMessageId is correlation, not idempotency);
//   - targetedInterrupt: turnInterrupt(turnId) — an attempt whose turn id
//     is not known yet cannot be interrupted (`noop`); its echo names the
//     turn and the coordinator interrupts it then (the tombstone rule);
//   - echo "clientId": the userMessage item carrying our clientUserMessageId
//     proves delivery; a turn/started alone never does (#32).
import type { RuntimeDriver, DriverCapabilities, CommandView, AttemptRef, SubmitResult, InterruptResult, ReconcileOutcome, Observation, HandledCommand } from "../domain/coordinator";
import { JsonRpcResponseError } from "./appServerClient";

/** What the driver needs from the session: the live client + thread, and
 *  the per-turn settings. Everything is read at call time — a client that
 *  died between two calls is simply absent. */
export interface CodexRuntimePort {
  readonly sessionId: string;
  threadId(): string | null;
  client(): CodexTurnClient | null;
  permissionMode(): string;
  /** Reasoning effort to apply on the NEXT accepted turn/start, if any;
   *  `effortApplied()` clears it (codex persists it thread-side). */
  pendingEffort(): string | undefined;
  effortApplied(): void;
  /** The turn codex reports active (turn/started … turn/completed), for an
   *  untargeted interrupt (abort of a foreign turn). */
  activeTurnId(): string | null;
  /** True when this generation REJOINED a live app-server: an attempt not
   *  yet visible in thread/read may still be in flight (hold it, at most
   *  once) rather than dead with the old server (resend, at least once). */
  rejoined(): boolean;
  /** Joy-owned slash commands the session executes itself. */
  handleCommand(text: string, opts: { source: string; mirrorToRelay: boolean; seq?: number | null }): HandledCommand | null;
  /** Mirror a freshly accepted command's user row to the relay. */
  mirrorAccepted(cmd: CommandView): void;
  log(line: string): void;
}
export interface CodexTurnClient {
  turnStart(threadId: string, text: string, opts: { clientUserMessageId?: string; permissionMode?: string; effort?: string }): Promise<{ turnId: string }>;
  turnInterrupt(threadId: string, turnId: string): Promise<unknown>;
  threadRead(threadId: string): Promise<Record<string, unknown>>;
}

export const CODEX_CAPABILITIES: DriverCapabilities = {
  steer: false, targetedInterrupt: true, ambiguousSubmit: true, terminalDraft: false, echo: "clientId", concurrentSubmit: false,
};

export class CodexDriver implements RuntimeDriver {
  readonly sessionId: string;
  readonly generation: number;
  readonly capabilities = CODEX_CAPABILITIES;
  #port: CodexRuntimePort;
  #sinks = new Set<(o: Observation) => void>();

  constructor(port: CodexRuntimePort, generation: number) {
    this.sessionId = port.sessionId;
    this.generation = generation;
    this.#port = port;
  }

  /** The session feeds what the app-server said (live or replayed). */
  emit(o: Observation): void { for (const s of [...this.#sinks]) s(o); }
  observe(sink: (o: Observation) => void): () => void {
    this.#sinks.add(sink);
    return () => { this.#sinks.delete(sink); };
  }

  handleCommand(text: string, opts: { source: string; mirrorToRelay: boolean; seq?: number | null }): HandledCommand | null {
    return this.#port.handleCommand(text, opts);
  }
  accepted(cmd: CommandView): void { this.#port.mirrorAccepted(cmd); }

  async submit(cmd: CommandView, attempt: AttemptRef, _signal?: AbortSignal): Promise<SubmitResult> {
    const client = this.#port.client();
    const threadId = this.#port.threadId();
    if (!client || !threadId) return { kind: "rejected", permanent: false, busy: true, detail: "app-server not connected" };
    try {
      const { turnId } = await client.turnStart(threadId, cmd.text, {
        clientUserMessageId: attempt.runtimeRef,
        permissionMode: this.#port.permissionMode(),
        effort: this.#port.pendingEffort(),
      });
      this.#port.effortApplied();
      return { kind: "accepted", runtimeTurnId: turnId };
    } catch (e) {
      if (e instanceof JsonRpcResponseError) {
        // An EXPLICIT refusal. A busy/already-active one is retried once the
        // runtime is idle and never counts; any other one is a transient
        // rejection the coordinator's budget turns permanent (Astra, #66).
        const busy = /busy|already|in progress|active/i.test(String(e.message ?? ""));
        return { kind: "rejected", permanent: false, busy, detail: `${e.code}: ${String(e.message ?? "").slice(0, 120)}` };
      }
      // AMBIGUOUS (timeout / socket loss): it MIGHT have landed.
      return { kind: "unknown", detail: String(e).slice(0, 200) };
    }
  }

  async interrupt(target: { attempt: AttemptRef | null }): Promise<InterruptResult> {
    const client = this.#port.client();
    const threadId = this.#port.threadId();
    const turnId = target.attempt ? target.attempt.runtimeTurnId : this.#port.activeTurnId();
    if (!client || !threadId || !turnId) return { kind: "noop" };
    try { await client.turnInterrupt(threadId, turnId); return { kind: "sent" }; }
    catch (e) { return { kind: "failed", error: `interrupt failed: ${e instanceof Error ? e.message : e}` }; }
  }

  /** thread/read: an attempt whose clientUserMessageId sits in a turn's
   *  items landed — running if that turn is still in progress on a rejoined
   *  server, accepted for a terminal turn (its replayed echo / turn-end
   *  settle it). A turn still "inProgress" on a FRESH spawn died with the
   *  old server (#625): one holding nothing but our prompt is absent (the
   *  prompt is re-sent, at-least-once); one that visibly ran is reported
   *  ended `interrupted` right here — the coordinator ends the row on that
   *  evidence, named by the ref since the attempt has no turn id yet — so
   *  the prompt is never run twice and never waits for a terminal the dead
   *  server cannot send. One not in history is dead with the old server
   *  (absent → resend) or, on a rejoin, possibly still in flight (unknown →
   *  held). */
  async reconcile(pending: AttemptRef[]): Promise<ReconcileOutcome[]> {
    const client = this.#port.client();
    const threadId = this.#port.threadId();
    if (!client || !threadId) return pending.map((p) => ({ attemptId: p.attemptId, outcome: "unknown" as const }));
    const res = await client.threadRead(threadId);
    const thread = (res.thread ?? res) as Record<string, unknown>;
    const turns = Array.isArray(thread.turns) ? thread.turns as Array<Record<string, unknown>> : [];
    const byRef = new Map<string, { turnId: string; inProgress: boolean; ran: boolean }>();
    for (const turn of turns) {
      const tid = String(turn.id ?? "");
      const items = Array.isArray(turn.items) ? turn.items as Array<Record<string, unknown>> : [];
      const inProgress = String(turn.status ?? "") === "inProgress";
      const ran = items.some((item) => String(item.type ?? "") !== "userMessage"); // any output at all: the agent took the prompt
      for (const item of items) {
        if (String(item.type ?? "") !== "userMessage") continue;
        const ref = String(item.clientId ?? item.clientUserMessageId ?? "");
        if (ref) byRef.set(ref, { turnId: tid, inProgress, ran });
      }
    }
    const rejoined = this.#port.rejoined();
    return pending.map((p) => {
      const hit = byRef.get(p.runtimeRef);
      if (!hit) return { attemptId: p.attemptId, outcome: rejoined ? "unknown" as const : "absent" as const };
      if (!hit.inProgress) return { attemptId: p.attemptId, outcome: "accepted" as const, runtimeTurnId: hit.turnId };
      if (rejoined) return { attemptId: p.attemptId, outcome: "running" as const, runtimeTurnId: hit.turnId };
      // Dead with the old server (#625): nothing but our prompt → re-send;
      // any output → it ran, so end it interrupted rather than run it twice.
      if (!hit.ran) return { attemptId: p.attemptId, outcome: "absent" as const };
      this.emit({ kind: "turn_ended", runtimeTurnId: hit.turnId, runtimeRef: p.runtimeRef, status: "interrupted", detail: "app-server died mid-turn" });
      return { attemptId: p.attemptId, outcome: "accepted" as const, runtimeTurnId: hit.turnId };
    });
  }
}

/** codex turn.status → the coordinator's terminal vocabulary. */
export function codexTurnStatus(codexStatus: string): "completed" | "failed" | "cancelled" {
  return codexStatus === "interrupted" || codexStatus === "cancelled" ? "cancelled" : codexStatus === "failed" ? "failed" : "completed";
}
