// The pi RuntimeDriver (Wave C2): a prompt/steer over pi's RPC stdin, and
// pi's `response` row for that request id as the delivery proof (#456,
// #577). pi owns steer/follow-up queues natively, so the coordinator submits
// while a turn runs (busy → steer, idle → prompt); pi's `agent_end` is when
// every submission has settled — the terminal for everything executing.
// There is no history API: an attempt a dead process never answered is
// `absent` (re-sent, at least once — pi's in-process queue died with it).
import type { RuntimeDriver, DriverCapabilities, CommandView, AttemptRef, SubmitResult, InterruptResult, ReconcileOutcome, Observation, HandledCommand } from "../domain/coordinator";

export interface PiRuntimePort {
  readonly sessionId: string;
  /** True when the command reached pi's stdin. */
  send(cmd: Record<string, unknown>): boolean;
  alive(): boolean;
  thinking(): boolean;
  /** Surface a refused (or never delivered) prompt/steer to the user. */
  rejected(kind: "prompt" | "steer", text: string, error: string): void;
  handleCommand(text: string, opts: { source: string; mirrorToRelay: boolean; seq?: number | null }): HandledCommand | null;
  mirrorAccepted(cmd: CommandView): void;
}

export const PI_CAPABILITIES: DriverCapabilities = {
  steer: true, targetedInterrupt: false, ambiguousSubmit: false, terminalDraft: false, echo: "rpc_response", concurrentSubmit: true,
};
const RESPONSE_TIMEOUT_MS = 30_000;

export class PiDriver implements RuntimeDriver {
  readonly sessionId: string;
  readonly generation: number;
  readonly capabilities = PI_CAPABILITIES;
  #port: PiRuntimePort;
  #sinks = new Set<(o: Observation) => void>();
  /** Requests awaiting pi's `response`, by request id. */
  #pending = new Map<string, (r: { success: boolean; error?: string } | null) => void>();

  constructor(port: PiRuntimePort, generation: number) {
    this.sessionId = port.sessionId;
    this.generation = generation;
    this.#port = port;
  }

  emit(o: Observation): void { for (const s of [...this.#sinks]) s(o); }
  observe(sink: (o: Observation) => void): () => void {
    this.#sinks.add(sink);
    return () => { this.#sinks.delete(sink); };
  }
  handleCommand(text: string, opts: { source: string; mirrorToRelay: boolean; seq?: number | null }): HandledCommand | null { return this.#port.handleCommand(text, opts); }
  accepted(cmd: CommandView): void { this.#port.mirrorAccepted(cmd); }

  /** pi answered a request (`response` with our id). */
  response(id: string, success: boolean, error?: string): boolean {
    const settle = this.#pending.get(id);
    if (!settle) return false;
    this.#pending.delete(id);
    settle({ success, error });
    return true;
  }
  /** The process is gone: nothing pending will ever be answered. */
  processGone(): void {
    for (const settle of this.#pending.values()) settle(null);
    this.#pending.clear();
  }
  get pendingCount(): number { return this.#pending.size; }

  async submit(cmd: CommandView, attempt: AttemptRef): Promise<SubmitResult> {
    if (!this.#port.alive()) return { kind: "rejected", permanent: false, busy: true, detail: "pi is not running" };
    const kind: "prompt" | "steer" = this.#port.thinking() ? "steer" : "prompt";
    const id = attempt.runtimeRef;
    const answer = new Promise<{ success: boolean; error?: string } | null>((resolve) => { this.#pending.set(id, resolve); });
    if (!this.#port.send({ id, type: kind, message: cmd.text })) {
      this.#pending.delete(id);
      this.#port.rejected(kind, cmd.text, "pi stdin is not writable");
      return { kind: "rejected", permanent: true, detail: "pi stdin is not writable" };
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), RESPONSE_TIMEOUT_MS); timer.unref?.(); });
    const r = await Promise.race([answer, timeout]);
    if (timer) clearTimeout(timer);
    if (r === "timeout") { this.#pending.delete(id); return { kind: "unknown", detail: "pi did not answer the request" }; }
    if (r === null) return { kind: "unknown", detail: "pi exited before answering" };
    if (!r.success) {
      const error = r.error ?? "unknown error";
      this.#port.rejected(kind, cmd.text, error);
      return { kind: "rejected", permanent: true, detail: error.slice(0, 200) };
    }
    // pi took it: delivered (the response IS the echo).
    this.emit({ kind: "echo", runtimeRef: id });
    return { kind: "accepted" };
  }
  steer(cmd: CommandView, attempt: AttemptRef): Promise<SubmitResult> { return this.submit(cmd, attempt); }

  async interrupt(): Promise<InterruptResult> {
    if (!this.#port.alive()) return { kind: "noop" };
    if (!this.#port.send({ type: "abort" })) return { kind: "failed", error: "pi stdin is not writable" }; // nothing was interrupted (#8)
    return { kind: "sent" };
  }

  async reconcile(pending: AttemptRef[]): Promise<ReconcileOutcome[]> {
    return pending.map((p) => ({ attemptId: p.attemptId, outcome: "absent" as const }));
  }
}
