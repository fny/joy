// Test support for the CLI state × action matrix (cli.matrix.test.ts) and
// the CLI sequences (cli.sequences.test.ts).
//
// The thing under test is the REAL path a `joy` verb takes: cli.ts → the
// daemon's HTTP transport → operations.ts → checkSession / queueFor → the
// coordinator and its ledger. Only the agent runtime is scripted: a
// FakeAgent is an AgentSession whose queue is the coordinator's (adopted
// with a FakeDriver), whose records live in the same in-memory relay log the
// transport streams, and which can be parked in every state the CLI can
// observe — running, queued behind, paused, holding an approval, waiting on
// a permission prompt, asking a question, detached, killed.
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import type { Server } from "node:http";
import { FakeDriver, CODEX_LIKE, settle, type SubmitCall } from "./domain/coordinator.fakeDriver";
import { coordinatorFor, type SessionCoordinator } from "./domain/coordinator";
import { ledgerFor, type Ledger } from "./domain/ledger";
import { queueFor } from "./domain/queueFacade";
import { RelaySession, encodeTurnStart, encodeTextEvent, encodeTurnEnd, forgetRecords } from "./relay/relay";
import type { AgentSession } from "./domain/agentSession";
import type { SessionRecord, SessionStatus } from "./claude/session";
import { startHttpServer } from "./transports/http";
import { joyStateDir } from "./paths";
import { saveWindowRecord } from "./domain/windowRecord";

export interface FakeApproval { requestId: string; kind: string; title: string; since: number }

/** Strip the daemon's provenance wrapper so a scripted reply can quote the
 *  text the caller actually sent. */
export function unwrapJoyMessage(text: string): string {
  return text.replace(/^<joy-message\b[^>]*>\s*/i, "").replace(/\s*<\/joy-message>\s*$/i, "").trim();
}

export class FakeAgent implements AgentSession {
  readonly agentFlavor = "codex" as const;
  readonly id: string;
  readonly cwd: string;
  status: SessionStatus = "active";
  endReason?: string;
  summary?: string;
  claudeSessionId?: string;
  readonly relayAttached = true;
  /** The permission mode `joy check` reports and exclusive sends gate on. */
  mode = "bypassPermissions";
  /** What the runtime does with a submitted command: `hold` keeps its turn
   *  running until `endTurn()`; `reply` answers "re: <text>" and ends it. */
  script: "hold" | "reply" = "hold";
  approvals: FakeApproval[] = [];
  waiting: { kind: string; tool?: string; since: number } | null = null;
  readonly driver: FakeDriver;
  readonly coordinator: SessionCoordinator;
  readonly ledger: Ledger;
  readonly relay: RelaySession;
  /** The runtime turn executing now (named T1, T2, …), or null when idle. */
  turn: string | null = null;
  /** Every text the runtime received, in delivery order. */
  readonly submitted: string[] = [];
  #turns = 0;
  #approvalSeq = 0;

  constructor(id: string, cwd: string) {
    this.id = id; this.cwd = cwd;
    this.ledger = ledgerFor();
    const generation = this.ledger.openGeneration(id, "codex");
    this.driver = new FakeDriver(id, generation, CODEX_LIKE);
    this.driver.onSubmit = (call) => this.#onSubmit(call);
    this.driver.onInterrupt = () => {
      if (!this.turn) return { kind: "noop" };
      this.approvals = []; this.waiting = null;
      this.endTurn("interrupted");
      return { kind: "sent" };
    };
    this.coordinator = coordinatorFor(this.ledger);
    this.coordinator.adopt(id, this.driver);
    this.driver.ready();
    this.relay = new RelaySession({ client: {} as never, relaySessionId: id, metadata: {} });
  }

  #onSubmit(call: SubmitCall): { kind: "accepted"; runtimeTurnId: string } {
    const turn = this.beginTurn();
    this.submitted.push(call.cmd.text);
    queueMicrotask(() => {
      this.driver.emit({ kind: "echo", runtimeRef: call.attempt.runtimeRef, runtimeTurnId: turn });
      this.driver.emit({ kind: "turn_started", runtimeTurnId: turn, runtimeRef: call.attempt.runtimeRef });
    });
    if (this.script === "reply") {
      setTimeout(() => {
        if (this.turn !== turn) return;
        this.say(`re: ${unwrapJoyMessage(call.cmd.text)}`);
        this.endTurn("completed");
      }, 30);
    }
    return { kind: "accepted", runtimeTurnId: turn };
  }

  /** Open a runtime turn (records only — attribution comes from the submit). */
  beginTurn(): string {
    const t = `T${++this.#turns}`;
    this.turn = t;
    this.relay.send(encodeTurnStart({ turn: t }));
    return t;
  }
  /** Assistant text on the current turn. */
  say(text: string): void { this.relay.send(encodeTextEvent(text, { turn: this.turn ?? "T0" })); }
  /** End the current turn with the runtime's verdict. */
  endTurn(status: "completed" | "failed" | "cancelled" | "interrupted" = "completed"): void {
    const t = this.turn;
    if (!t) return;
    this.turn = null;
    this.relay.send(encodeTurnEnd(status === "interrupted" ? "cancelled" : status, { turn: t }));
    this.driver.emit({ kind: "turn_ended", runtimeTurnId: t, status });
  }
  /** Hold a codex-style approval on the running turn. */
  holdApproval(title: string): FakeApproval {
    const a = { requestId: `apr-${++this.#approvalSeq}`, kind: "command", title, since: Date.now() };
    this.approvals.push(a);
    return a;
  }
  /** Ask the human a question with offered answers — as a finished reply,
   *  the way an agent's <joy-options> block lands (records only, no turn
   *  observation: the turn that asked is over). */
  askQuestion(question: string, options: string[]): void {
    const turn = `Q${++this.#turns}`;
    this.relay.send(encodeTurnStart({ turn }));
    this.relay.send(encodeTextEvent(`${question}\n<joy-options>\n${options.map((o) => `<joy-option>${o}</joy-option>`).join("\n")}\n</joy-options>`, { turn }));
    this.relay.send(encodeTurnEnd("completed", { turn }));
  }
  /** The dispatcher gave up on the pane: the queue holds until resumed. */
  pause(reason: "input_dirty" | "dispatch_timeout" | "dispatch_mismatch" | "dispatch_failed" = "dispatch_timeout"): void {
    this.driver.emit({ kind: "paused", reason });
  }
  /** Queue a text straight through the daemon's queue (no CLI). */
  enqueue(text: string): string { return queueFor(this).accept(text, { source: "rpc", visible: true }).id; }
  pending(): number { return this.coordinator.snapshot(this.id).pendingCount; }

  // ── AgentSession ──────────────────────────────────────────────────────────
  busy(): boolean { return this.coordinator.busy(this.id); }
  abort(): Promise<{ ok: boolean; error?: string }> { return this.coordinator.abortRunning(this.id); }
  detectPermissionMode(): string | null { return this.mode; }
  async setPermissionMode(target: string): Promise<{ ok: boolean; mode?: string; error?: string }> { this.mode = target; return { ok: true, mode: target }; }
  listApprovals(): FakeApproval[] { return this.approvals; }
  needsInput(): { kind: string; tool?: string; since: number } | null { return this.waiting; }
  answerApproval(params: Record<string, unknown> | undefined): { ok: boolean } {
    const id = String(params?.requestId ?? "");
    const i = this.approvals.findIndex((a) => a.requestId === id);
    if (i < 0) return { ok: false };
    this.approvals.splice(i, 1);
    if (params?.decision !== true) {
      // Denied: the agent stops what it was doing and ends its turn.
      setTimeout(() => { this.say("ok, not doing that"); this.endTurn("completed"); }, 20);
    }
    // Allowed: the agent carries on working (the turn stays running).
    return { ok: true };
  }
  toJSON(): SessionRecord {
    return {
      id: this.id, agent: "codex", cwd: this.cwd, status: this.status, tmux_window: `joy-${this.id}:agent`, flags: [],
      permission_mode: this.mode, ...(this.summary ? { summary: this.summary } : {}), last_active_at: Date.now(),
    } as unknown as SessionRecord;
  }
  end(reason: "killed" | "process_exited" | "restart"): boolean {
    if (this.status === "ended") return false;
    this.status = "ended"; this.endReason = reason;
    this.approvals = []; this.waiting = null; this.turn = null;
    this.coordinator.retire(this.id, reason);
    return true;
  }
  forceKill(): boolean {
    if (this.status !== "ended") return this.end("killed");
    this.endReason = "killed";
    this.coordinator.retire(this.id, "killed");
    return true;
  }
  async awaitArchive(): Promise<boolean> { return true; }
  attachRelay(): boolean { return true; }
  beginWatching(): void {}
  async sendRawKeys(): Promise<{ ok: boolean; segments: number }> { return { ok: true, segments: 0 }; }
  async pane(): Promise<{ ok: true; text: string }> { return { ok: true, text: "" }; }
  async resize(): Promise<{ ok: boolean }> { return { ok: true }; }
  transcript(): { lines: unknown[] } { return { lines: [] }; }
  onHookEvent(): { ok: boolean } { return { ok: true }; }
  markCompacting(): void {}
  /** Drop this agent's relay records (between tests). */
  dispose(): void { forgetRecords(this.id); }
}

export const newId = (): string => randomBytes(4).toString("hex");

/** The registry surface the CLI's verbs reach through operations.ts and the
 *  HTTP transport. `create` mints a FakeAgent so `joy new` is real end to end. */
export class FakeRegistry {
  readonly sessions = new Map<string, FakeAgent>();
  readonly startedAt = Date.now();
  readonly sseClientCount = 0;
  readonly relayClient = null;
  readonly created: Array<Record<string, unknown>> = [];
  #chat: Array<Record<string, unknown>> = [];
  #chatId = 0;
  add(agent: FakeAgent): FakeAgent { this.sessions.set(agent.id, agent); return agent; }
  get(id: string): FakeAgent | undefined {
    const s = this.sessions.get(id);
    return s && s.endReason !== "killed" ? s : undefined;
  }
  list(): FakeAgent[] { return [...this.sessions.values()].filter((s) => s.endReason !== "killed"); }
  get size(): number { return this.list().length; }
  chatHistory(): Array<Record<string, unknown>> { return this.#chat; }
  nextChatId(): string { return String(++this.#chatId); }
  addChatMessage(m: Record<string, unknown>): void { this.#chat.push(m); }
  subscribeSse(): () => void { return () => {}; }
  claudeInfo(): null { return null; }
  listRecords(): unknown[] { return []; }
  async create(opts: Record<string, unknown>): Promise<FakeAgent> {
    this.created.push(opts);
    const agent = new FakeAgent(newId(), String(opts.cwd ?? "/tmp"));
    agent.script = "reply";
    if (typeof opts.permissionMode === "string") agent.mode = opts.permissionMode;
    // The real create persists the launch record before returning; the
    // create op then patches it (headless, …) — a patch needs a record.
    saveWindowRecord(agent.id, { launchCwd: agent.cwd, agent: "codex" });
    return this.add(agent);
  }
  /** Forget every agent's records and retire them (between tests). */
  reset(): void {
    for (const s of this.sessions.values()) { if (s.status !== "ended") s.end("killed"); s.dispose(); }
    this.sessions.clear();
  }
}

export interface Daemon { registry: FakeRegistry; server: Server; port: number; token: string; close(): Promise<void> }

/** Serve the real HTTP transport over the fake registry on a random port and
 *  point daemon.json (in the isolated JOY_HOME_DIR) at it — the CLI finds
 *  its daemon exactly the way it does in production. */
export async function bootDaemon(): Promise<Daemon> {
  const registry = new FakeRegistry();
  const publicDir = mkdtempSync(join(tmpdir(), "joy-matrix-public-"));
  const token = "tok-matrix";
  let server!: Server;
  const port = await new Promise<number>((resolve) => {
    server = startHttpServer({ registry: registry as never, port: 0, publicDir, token, onListening: resolve });
  });
  pointCliAt(port, token);
  return {
    registry, server, port, token,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      rmSync(publicDir, { recursive: true, force: true });
    },
  };
}

/** Write the daemon.json the CLI reads on every call. A port nothing listens
 *  on (1) is how the matrix models "daemon down". */
export function pointCliAt(port: number, token = "tok-matrix"): void {
  mkdirSync(joyStateDir(), { recursive: true });
  writeFileSync(join(joyStateDir(), "daemon.json"), JSON.stringify({ token, pid: process.pid, port, startedAt: Date.now(), version: "matrix" }));
}

const ANSI = /\x1b\[[0-9;]*m/g;
export interface CliRun { exit: number; out: string; err: string }
/** Run one CLI verb with its argv, capturing what it printed. */
export async function runCli(fn: (rest: string[]) => Promise<number>, ...args: string[]): Promise<CliRun> {
  const out: string[] = []; const err: string[] = [];
  const log = console.log; const error = console.error;
  console.log = (...a: unknown[]) => { out.push(a.map(String).join(" ")); };
  console.error = (...a: unknown[]) => { err.push(a.map(String).join(" ")); };
  try {
    const exit = await fn([...args]);
    return { exit, out: out.join("\n").replace(ANSI, ""), err: err.join("\n").replace(ANSI, "") };
  } finally { console.log = log; console.error = error; }
}

export { settle };
