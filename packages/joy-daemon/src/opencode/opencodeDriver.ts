// The opencode RuntimeDriver (Wave C2): one POST /prompt per attempt with
// a message id that is the SAME across resends (idempotent server-side, so
// an `unknown` reconciled as absent is safe to send again), a session-wide
// interrupt, and admission (`session.next.prompt.admitted`, or the HTTP
// ack) as the delivery proof. delivery:'steer' is the server default: idle
// → starts a turn; busy → the message joins the RUNNING turn between tool
// calls (verified live 2026-08-03), so a steered prompt's turn id is the
// running one and every command riding that turn ends with it.
//
// Capability facts the coordinator relies on:
//   - steer + concurrentSubmit: the coordinator submits the next queued
//     command while a turn runs (the server queues/steers natively);
//   - the interrupt is SESSION-wide: a cancel of an older command while a
//     newer one is running would stop the newer work, so the driver refuses
//     it (`failed`) and the coordinator surfaces the cancel as unresolved
//     instead of pretending (Astra on af76c787, #77);
//   - a transport failure is `unknown`; reconcile reads the session's
//     messages: our id present → accepted, absent → absent (resend, same id).
import type { RuntimeDriver, DriverCapabilities, CommandView, AttemptRef, SubmitResult, InterruptResult, ReconcileOutcome, Observation, HandledCommand } from "../domain/coordinator";

export interface OpencodePromptClient {
  prompt(sessionID: string, text: string, opts?: { id?: string; delivery?: "steer" | "queue" }): Promise<{ messageID: string; admittedSeq: number }>;
  interrupt(sessionID: string): Promise<void>;
  messages(sessionID: string): Promise<Array<Record<string, unknown>>>;
}
export interface OpencodeRuntimePort {
  readonly sessionId: string;
  client(): OpencodePromptClient | null;
  ocSessionId(): string | null;
  /** The joy turn the normalizer currently has open (a steer joins it). */
  currentTurn(): string | null;
  /** The message id most recently admitted — the only prompt a session-wide
   *  interrupt can honestly be said to stop. */
  lastAdmitted(): string | null;
  /** Text to prepend to the NEXT prompt (the first-prompt preamble), if any. */
  takePreamble(): string;
  /** The interrupt landed: close the running turn as cancelled. */
  turnInterrupted(): void;
  handleCommand(text: string, opts: { source: string; mirrorToRelay: boolean; seq?: number | null }): HandledCommand | null;
  mirrorAccepted(cmd: CommandView): void;
}

export const OPENCODE_CAPABILITIES: DriverCapabilities = {
  steer: true, targetedInterrupt: false, ambiguousSubmit: true, terminalDraft: false, echo: "admission", concurrentSubmit: true,
};

/** The message id a command is sent under — stable across attempts. */
export function opencodeMessageId(cmd: { id: string; sessionId: string }): string {
  return `msg_joy${cmd.sessionId}c${cmd.id}`.replace(/[^A-Za-z0-9_]/g, "");
}

export class OpencodeDriver implements RuntimeDriver {
  readonly sessionId: string;
  readonly generation: number;
  readonly capabilities = OPENCODE_CAPABILITIES;
  #port: OpencodeRuntimePort;
  #sinks = new Set<(o: Observation) => void>();

  constructor(port: OpencodeRuntimePort, generation: number) {
    this.sessionId = port.sessionId;
    this.generation = generation;
    this.#port = port;
  }

  emit(o: Observation): void { for (const s of [...this.#sinks]) s(o); }
  observe(sink: (o: Observation) => void): () => void {
    this.#sinks.add(sink);
    return () => { this.#sinks.delete(sink); };
  }
  runtimeRef(cmd: CommandView): string { return opencodeMessageId(cmd); }
  handleCommand(text: string, opts: { source: string; mirrorToRelay: boolean; seq?: number | null }): HandledCommand | null { return this.#port.handleCommand(text, opts); }
  accepted(cmd: CommandView): void { this.#port.mirrorAccepted(cmd); }

  async submit(cmd: CommandView, attempt: AttemptRef): Promise<SubmitResult> {
    const client = this.#port.client();
    const sid = this.#port.ocSessionId();
    if (!client || !sid) return { kind: "rejected", permanent: false, busy: true, detail: "opencode server not connected" };
    const preamble = this.#port.takePreamble();
    try {
      const r = await client.prompt(sid, preamble + cmd.text, { id: attempt.runtimeRef, delivery: "steer" });
      if (!r.messageID) return { kind: "unknown", detail: "no messageID in the prompt reply" };
      // The HTTP ack is admission evidence too: a prompt whose SSE confirm a
      // dropped stream never delivers is still proven here (#77).
      this.emit({ kind: "echo", runtimeRef: r.messageID, runtimeTurnId: this.#port.currentTurn() ?? r.messageID, receiptKind: "opencode_msg" });
      return { kind: "accepted", runtimeTurnId: this.#port.currentTurn() ?? r.messageID };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // The server ANSWERED and refused: terminal for this prompt (#79).
      if (/→ \d{3}:/.test(msg)) return { kind: "rejected", permanent: true, detail: msg.slice(0, 200) };
      return { kind: "unknown", detail: msg.slice(0, 200) };
    }
  }
  steer(cmd: CommandView, attempt: AttemptRef): Promise<SubmitResult> { return this.submit(cmd, attempt); }

  async interrupt(target: { attempt: AttemptRef | null }): Promise<InterruptResult> {
    const client = this.#port.client();
    const sid = this.#port.ocSessionId();
    if (!client || !sid) return { kind: "noop" };
    if (target.attempt) {
      const last = this.#port.lastAdmitted();
      if (last && last !== target.attempt.runtimeRef) return { kind: "failed", error: `a newer prompt (${last}) was admitted since — a session-wide interrupt would stop it` };
    }
    try { await client.interrupt(sid); }
    catch (e) { return { kind: "failed", error: `interrupt failed: ${e instanceof Error ? e.message : e}` }; }
    this.#port.turnInterrupted();
    return { kind: "sent" };
  }

  async reconcile(pending: AttemptRef[]): Promise<ReconcileOutcome[]> {
    const client = this.#port.client();
    const sid = this.#port.ocSessionId();
    if (!client || !sid) return pending.map((p) => ({ attemptId: p.attemptId, outcome: "unknown" as const }));
    const ids = new Set((await client.messages(sid)).filter((m) => String(m.type ?? "") === "user").map((m) => String(m.id ?? "")));
    return pending.map((p) => ids.has(p.runtimeRef)
      ? { attemptId: p.attemptId, outcome: "accepted" as const, runtimeTurnId: p.runtimeRef }
      : { attemptId: p.attemptId, outcome: "absent" as const });
  }
}
