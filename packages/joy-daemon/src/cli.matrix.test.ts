// The CLI state × action matrix: every cell of cli.matrix.oracle.ts, run
// against the real daemon path (cli.ts → HTTP transport → operations →
// coordinator/ledger) with a scripted agent runtime (cli.matrix.fakeAgent).
//
// Each cell: park a fresh session in the state, run the verb, then check
// (1) the exit code, (2) the daemon-side effect — did the text reach the
// runtime, sit in the queue, or get refused; was a turn interrupted; is the
// session gone; did the mode change — and (3) what `joy check` reports once
// things settle. A failing cell names its state and action.
import { test, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.JOY_HOME_DIR = mkdtempSync(join(tmpdir(), "joy-cli-matrix-"));
delete process.env.JOY_SESSION_ID;

const cli = await import("./cli");
const { FakeAgent, bootDaemon, pointCliAt, runCli, newId, settle } = await import("./cli.matrix.fakeAgent");
import type { Daemon } from "./cli.matrix.fakeAgent";
const { cells, STATES, ACTIONS } = await import("./cli.matrix.oracle");
const { closeAllLedgers } = await import("./domain/ledger");
const { resetCoordinators } = await import("./domain/coordinator");
import type { State, Action, Cell, Effect } from "./cli.matrix.oracle";
import type { FakeAgent as FakeAgentT } from "./cli.matrix.fakeAgent";

let daemon: Daemon;
const stderr: string[] = [];
beforeAll(async () => {
  vi.spyOn(process.stderr, "write").mockImplementation((c: unknown) => { stderr.push(String(c)); return true; });
  daemon = await bootDaemon();
});
afterEach(() => {
  daemon.registry.reset();
  pointCliAt(daemon.port, daemon.token); // undo daemon_down
});
afterAll(async () => {
  await daemon.close();
  resetCoordinators(); closeAllLedgers();
  vi.restoreAllMocks();
  rmSync(process.env.JOY_HOME_DIR!, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Park a fresh session in `state`. Returns the id the CLI addresses and the
 *  agent (null when there is none to script). */
async function enter(state: State): Promise<{ id: string; agent: FakeAgentT | null }> {
  if (state === "gone") return { id: "deadbeef", agent: null };
  const agent = daemon.registry.add(new FakeAgent(newId(), "/tmp/matrix"));
  switch (state) {
    case "ended": agent.end("process_exited"); break;
    case "idle": break;
    case "busy": agent.enqueue("work"); await settle(); break;
    case "busy_queued": agent.enqueue("work"); await settle(); agent.enqueue("later"); await settle(); break;
    case "paused": agent.pause(); agent.enqueue("stuck"); await settle(); break;
    case "approval": agent.enqueue("work"); await settle(); agent.holdApproval("rm -rf build"); break;
    case "permission": agent.enqueue("work"); await settle(); agent.waiting = { kind: "permission", tool: "Bash", since: Date.now() }; break;
    case "question": agent.askQuestion("Which one?", ["Alpha", "Beta"]); break;
    case "unscriptable": agent.mode = "default"; break;
    case "daemon_down": pointCliAt(1); break;
  }
  return { id: agent.id, agent };
}

/** For the verbs that wait on the runtime: let a running turn finish shortly
 *  and have the runtime answer whatever runs next. */
function arm(state: State, agent: FakeAgentT | null): void {
  if (!agent) return;
  if (state === "idle" || state === "question" || state === "unscriptable") agent.script = "reply";
  if (state === "busy" || state === "busy_queued") { agent.script = "reply"; setTimeout(() => agent.endTurn("completed"), 300); }
}

async function act(action: Action, state: State, id: string, agent: FakeAgentT | null) {
  switch (action) {
    case "check": return runCli(cli.cmdCheck, id);
    case "send": return runCli(cli.cmdSend, id, "2");
    case "send_no_queue": return runCli(cli.cmdSend, id, "--no-queue", "2");
    case "ask": arm(state, agent); return runCli(cli.cmdAsk, id, "--timeout", "4", "ping");
    case "wait": arm(state, agent); return runCli(cli.cmdWaitIdle, id, "--timeout", "4");
    case "abort": return runCli(cli.cmdAbort, id);
    case "approve": return runCli((r) => cli.cmdDecide(r, "allow"), id);
    case "deny": return runCli((r) => cli.cmdDecide(r, "deny"), id);
    case "queue": return runCli(cli.cmdQueue, id);
    case "resume": return runCli(cli.cmdQueue, id, "resume");
    case "kill": return runCli(cli.cmdKill, id);
    case "mode": return runCli(cli.cmdMode, id, "yolo");
    case "about": return runCli(cli.cmdAbout, id);
    case "ls": return runCli(cli.cmdList);
  }
}

interface Snapshot { submits: number; pending: number; interrupts: number; approvals: number }
const snap = (agent: FakeAgentT | null): Snapshot => agent
  ? { submits: agent.driver.submits.length, pending: agent.pending(), interrupts: agent.driver.interrupts.length, approvals: agent.approvals.length }
  : { submits: 0, pending: 0, interrupts: 0, approvals: 0 };

/** Assert the daemon-side effect the cell claims. */
function checkEffect(effect: Effect, action: Action, before: Snapshot, after: Snapshot, agent: FakeAgentT | null, id: string, run: { out: string }): void {
  const label = `effect ${effect}`;
  switch (effect) {
    case "none":
      expect({ label, submits: after.submits, pending: after.pending, interrupts: after.interrupts }).toEqual({ label, submits: before.submits, pending: before.pending, interrupts: before.interrupts });
      break;
    case "delivered":
      expect({ label, submits: after.submits }).toEqual({ label, submits: before.submits + 1 });
      if (action === "send" || action === "send_no_queue") expect(agent!.submitted[agent!.submitted.length - 1]).toContain("2");
      break;
    case "queued":
      expect({ label, submits: after.submits, pending: after.pending }).toEqual({ label, submits: before.submits, pending: before.pending + 1 });
      break;
    case "refused":
      expect({ label, submits: after.submits, pending: after.pending }).toEqual({ label, submits: before.submits, pending: before.pending });
      break;
    case "answered":
      if (action === "ask") expect(run.out).toContain("re: ping");
      else expect({ label, approvals: after.approvals }).toEqual({ label, approvals: before.approvals - 1 });
      break;
    case "interrupted":
      expect({ label, interrupts: after.interrupts }).toEqual({ label, interrupts: before.interrupts + 1 });
      break;
    case "killed":
      expect({ label, gone: daemon.registry.get(id) === undefined }).toEqual({ label, gone: true });
      break;
    case "mode_set":
      expect({ label, mode: agent!.mode }).toEqual({ label, mode: "yolo" });
      break;
  }
}

/** Assert what `joy check` (and `joy ls`) say afterwards. */
async function checkAfter(cell: Cell, id: string): Promise<void> {
  const ck = await runCli(cli.cmdCheck, id);
  if (cell.after === "gone") {
    expect({ after: "check exit", exit: ck.exit }).toEqual({ after: "check exit", exit: 1 });
    const ls = await runCli(cli.cmdList);
    expect(ls.out).not.toContain(id);
  } else {
    expect({ after: "check exit", exit: ck.exit }).toEqual({ after: "check exit", exit: cell.after });
  }
}

for (const { state, action, cell } of cells()) {
  test(`${state} × ${action} → exit ${cell.exit}, ${cell.effect}, then check ${cell.after}${cell.note ? ` — ${cell.note}` : ""}`, async () => {
    const { id, agent } = await enter(state);
    const before = snap(agent);
    const run = await act(action, state, id, agent);
    expect({ exit: run.exit, out: run.out, err: run.err }).toMatchObject({ exit: cell.exit });
    await settle();
    // A delivered row is submitted on the pump; give it a tick, then let the
    // reply-scripted runtimes finish what the verb set in motion.
    if (cell.effect === "delivered") await sleep(50);
    if (cell.effect === "answered" || action === "wait" || action === "deny") await sleep(120);
    const after = snap(agent);
    checkEffect(cell.effect, action, before, after, agent, id, run);
    if (state === "daemon_down") { expect(run.err).toMatch(/daemon not running|timed out/); return; }
    if (state === "ended" && action === "kill") await sleep(20);
    await checkAfter(cell, id);
    if (action === "queue" && before.pending > 0 && cell.exit === 0) expect(run.out).toMatch(/stuck|later/);
    if (action === "ls" && cell.after !== "gone") expect(run.out).toContain(id);
  }, 15_000);
}

test("the table is total: every state × every action has a cell", () => {
  expect(cells().length).toBe(STATES.length * ACTIONS.length);
});
