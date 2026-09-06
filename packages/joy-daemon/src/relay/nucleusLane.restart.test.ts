// Restart recovery against the REAL relay (HTTP + PGlite, joy-relay's test
// harness): the daemon's lease expires and is swept while a relay turn is
// mid-flight, the runtime survives, a new driver generation confirms it
// running, and a fresh lane boots over the same ledger. Astra's C9 review
// (abf32eb9) showed the boot pass interrupting the orphaned turn on the
// relay before the ledger was consulted: /start then 409'd and the lane
// cancelled a live agent — or, with a durable ack, left the relay idle while
// the agent kept working. Every case here asserts the opposite: the local
// command stays running, the relay adopts the turn under the new lease
// (cancellation preserved), at most one /start is posted, and exactly one
// terminal is published when the runtime ends.
import { test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { startRelay } from "../../../joy-relay/test/harness.mjs";
import { ledgerFor, closeAllLedgers } from "../domain/ledger";
import { coordinatorFor, resetCoordinators } from "../domain/coordinator";
import { FakeDriver, settle } from "../domain/coordinator.fakeDriver";
import { startNucleusLane, type NucleusLaneHandle } from "./nucleusLane";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean | Promise<boolean>, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await fn())) { if (Date.now() > end) throw new Error("timeout waiting"); await sleep(40); }
}

type Prior =
  | "dispatching"     // died after the runtime's echo, before POST /start
  | "running"         // /start applied on the relay, the ack receipt lost
  | "acknowledged"    // /start applied AND acknowledged (durable ack)
  | "cancelling"      // acknowledged, then the app requested a cancel before the crash
  | "closed_remotely"; // before /start; an intermediate generation already closed the turn `interrupted`

let dir = "";
let prevHome: string | undefined;
let relay: Awaited<ReturnType<typeof startRelay>> | null = null;
let lane: NucleusLaneHandle | null = null;
let restoreFetch: (() => void) | null = null;
let retire: (() => Promise<void>) | null = null;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lane-restart-"));
  prevHome = process.env.JOY_HOME_DIR;
  process.env.JOY_HOME_DIR = dir;
  resetCoordinators();
  closeAllLedgers();
});
afterEach(async () => {
  await lane?.stop(); lane = null;
  restoreFetch?.(); restoreFetch = null;
  await retire?.(); retire = null;
  resetCoordinators();
  closeAllLedgers();
  await relay?.close(); relay = null;
  if (prevHome === undefined) delete process.env.JOY_HOME_DIR; else process.env.JOY_HOME_DIR = prevHome;
  rmSync(dir, { recursive: true, force: true });
});

/** Count POST …/start requests the lane sends (the lane uses global fetch). */
function countStarts(): { starts: () => number } {
  const real = globalThis.fetch;
  let n = 0;
  globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if ((init?.method ?? "GET") === "POST" && /\/daemon\/turns\/[^/]+\/start$/.test(url)) n++;
    return real(input, init);
  }) as typeof fetch;
  restoreFetch = () => { globalThis.fetch = real; };
  return { starts: () => n };
}

async function scenario(prior: Prior) {
  relay = await startRelay();
  const r = relay;
  const id = "c9session";
  const machine = `c9-${prior}`;
  const ledger = ledgerFor();
  // Daemon generation 1 on the relay side (a fake daemon: lease, claim,
  // submitted, maybe /start) and on ours (a coordinator over the ledger,
  // whose driver confirms the delivery — the row is `running`).
  const d1 = r.makeDaemon(machine);
  await d1.acquire();
  const create = await r.call("POST", "/joy/v2/sessions", { body: { mode: "announce_existing", creationIntentId: randomUUID(), daemonId: machine, localSessionId: id, sessionKeyEnvelope: "v2:plaintext" } });
  expect(create.status).toBe(200);
  const sid = create.json.sessionId as string;
  const post = await r.post(sid, { clientIntentId: randomUUID(), ciphertext: JSON.stringify({ v: 1, t: "plain", text: "continue this turn" }) });
  expect(post.status).toBe(202);
  const offer = r.offerFor(await d1.claim("work"), sid);
  expect(offer).toBeTruthy();
  expect((await d1.received(offer.deliveryId)).status).toBe(200);
  expect((await d1.submitted(offer.turnId)).status).toBe(200);
  const turnId = offer.turnId as string;
  if (prior !== "dispatching" && prior !== "closed_remotely") {
    expect((await d1.start(turnId, { runtimeEventId: `start:${turnId}` })).status).toBe(200);
  }
  const first = new FakeDriver(id, ledger.openGeneration(id, "codex"));
  let c = coordinatorFor(ledger);
  c.adopt(id, first);
  first.ready();
  const row = c.accept({ sessionId: id, text: "continue this turn", source: "rpc", visible: false, mirrorToRelay: false, relayTurnId: turnId, relayCommandId: offer.commandId });
  await settle();
  first.lastSubmit.settle.resolve({ kind: "accepted", runtimeTurnId: "RuntimeTurn" });
  await settle();
  first.emit({ kind: "echo", runtimeRef: row.id, runtimeTurnId: "RuntimeTurn" });
  expect(c.state(row.id)).toBe("running");
  // The receipts the previous lane left: the /start intent always (it was
  // about to post, or did); the ack only when the answer was recorded.
  ledger.addReceipt(id, { kind: "relay_start_intent", ref: turnId, commandId: row.id });
  if (prior === "acknowledged" || prior === "cancelling") ledger.addReceipt(id, { kind: "relay_start", ref: turnId, commandId: row.id });
  if (prior === "cancelling") {
    const cxl = await r.call("POST", `/joy/v2/sessions/${sid}/turns/${turnId}/cancellations`, { body: {} });
    expect(cxl.status).toBe(200);
  }
  // The crash: the lease expires, the relay sweeps it — the turn is orphaned.
  await r.db.query("UPDATE daemon_leases SET expires_at = now() - interval '1 second' WHERE id = $1", [d1.leaseId]);
  await r.core.sweepExpiredLeases();
  expect((await r.call("GET", `/joy/v2/sessions/${sid}`)).json.execution.state).toBe("orphaned");
  if (prior === "closed_remotely") {
    // An intermediate daemon generation (an old build's orphan pass) closed
    // the turn `interrupted` on the relay; the runtime never noticed.
    const mid = r.makeDaemon(machine);
    await mid.acquire();
    const closed = await r.call("POST", `/joy/v2/daemon/turns/${turnId}/reconcile`, { body: { resolution: "terminal", terminalState: "interrupted", meta: { reason: "daemon_restart" } }, headers: mid.headers() });
    expect(closed.status).toBe(200);
    await r.db.query("UPDATE daemon_leases SET expires_at = now() - interval '1 second' WHERE id = $1", [mid.leaseId]);
    expect((await r.call("GET", `/joy/v2/sessions/${sid}`)).json.execution.state).toBe("idle");
  }
  // Daemon generation 2: a new driver generation over the same ledger whose
  // reconcile confirms the runtime is still executing the attempt.
  resetCoordinators();
  const next = new FakeDriver(id, ledger.openGeneration(id, "codex"));
  next.onReconcile = (call) => call.pending.map((a) => ({ attemptId: a.attemptId, outcome: "running" as const, runtimeTurnId: "RuntimeTurn" }));
  next.onInterrupt = () => ({ kind: "sent" });
  c = coordinatorFor(ledger);
  c.adopt(id, next);
  next.ready();
  await until(() => c.state(row.id) === "running");
  const s: any = { id, status: "active", cwd: dir, agentFlavor: "codex", busy: () => c.busy(id), abort: () => c.abortRunning(id), toJSON: () => ({ id, cwd: dir, status: "active", agent: "codex" }) };
  const registry: any = { get: (x: string) => (x === id ? s : undefined), list: () => [s], create: async () => s, chatHistory: () => [], listRecords: () => [{ id, v2SessionId: sid }], saveRecord: () => {} };
  retire = async () => { c.retire(id, "restart"); await settle(); };
  const logs: string[] = [];
  const { starts } = countStarts();
  const execution = async () => (await r.call("GET", `/joy/v2/sessions/${sid}`)).json.execution as { state: string; turnId: string | null; cancelRequested: boolean };
  const events = async (kind: string) => (await r.db.query("SELECT count(*)::int AS n FROM session_events WHERE session_id = $1 AND kind = $2", [sid, kind])).rows[0].n as number;
  const turnRow = async () => (await r.db.query("SELECT state, terminal_state, lease_epoch FROM turns WHERE id = $1", [turnId])).rows[0] as { state: string; terminal_state: string | null; lease_epoch: string | number };
  lane = startNucleusLane({ registry, relayUrl: r.base, token: "app-token", machineId: machine, log: (x: string) => logs.push(x) });
  return { id, sid, turnId, row, ledger, next, logs, starts, execution, events, turnRow, coordinator: () => c };
}

test.each(["dispatching", "running", "acknowledged"] as const)(
  "real relay, lease expired + swept, new driver generation confirms running, fresh lane (%s): the turn is adopted, the local command keeps running, one /start at most, one terminal when the runtime ends",
  async (prior) => {
    const t = await scenario(prior);
    // The boot pass never interrupts a turn the ledger still owns; the
    // resumed loop adopts it under the new lease instead.
    await until(async () => (await t.execution()).state === "running");
    expect(await t.execution()).toMatchObject({ state: "running", turnId: t.turnId, cancelRequested: false });
    expect(t.coordinator().state(t.row.id)).toBe("running");
    expect(t.logs.some((l) => /was orphaned → interrupted/.test(l))).toBe(false);
    expect(t.logs.some((l) => /adopted on the relay under this lease/.test(l))).toBe(true);
    await sleep(400);
    expect(t.coordinator().state(t.row.id)).toBe("running"); // nothing cancelled it
    expect(t.starts()).toBeLessThanOrEqual(1);
    if (prior === "acknowledged") expect(t.starts()).toBe(0); // the ack is the durable fact
    expect(await t.events("turn.started")).toBe(1); // adoption + a replayed /start are ONE start
    expect(t.ledger.hasReceipt(t.id, "relay_start", t.turnId)).toBe(true);
    // Fenced to the lane's lease (epoch 2), not the swept one.
    expect(String((await t.turnRow()).lease_epoch)).toBe("2");
    expect(await t.events("turn.terminal")).toBe(0);
    // The runtime ends → the command's terminal is the turn's, published once.
    t.next.emit({ kind: "turn_ended", runtimeTurnId: "RuntimeTurn", status: "completed" });
    await until(async () => (await t.execution()).state === "idle");
    await until(() => t.coordinator().state(t.row.id) === "completed");
    await sleep(300);
    expect(await t.events("turn.terminal")).toBe(1);
    expect(await t.turnRow()).toMatchObject({ state: "terminal", terminal_state: "completed" });
    expect(t.starts()).toBeLessThanOrEqual(1);
  }, 30_000);

test("real relay: a cancel the app requested before the crash survives the adoption — the resumed loop cancels locally and publishes one cancelled terminal", async () => {
  const t = await scenario("cancelling");
  await until(async () => (await t.execution()).state === "cancelling");
  expect(await t.execution()).toMatchObject({ state: "cancelling", turnId: t.turnId, cancelRequested: true });
  // The adoption carried the relay's cancel to the coordinator: the runtime is interrupted…
  await until(() => t.next.interrupts.length > 0);
  expect(t.starts()).toBe(0);
  // …and confirms it; the turn closes cancelled, once.
  t.next.emit({ kind: "turn_ended", runtimeTurnId: "RuntimeTurn", status: "cancelled" });
  await until(async () => (await t.execution()).state === "idle");
  await until(() => t.coordinator().state(t.row.id) === "cancelled");
  await sleep(300);
  expect(await t.events("turn.terminal")).toBe(1);
  expect(await t.turnRow()).toMatchObject({ state: "terminal", terminal_state: "cancelled" });
}, 30_000);

test("real relay: /start answers 409 turn_terminal for a turn the relay already closed (not cancelled) while the runtime confirms it running — the local command is NOT cancelled; its outcome posts as the terminal fact when it ends", async () => {
  const t = await scenario("closed_remotely");
  await until(() => t.logs.some((l) => /the relay already closed this turn interrupted/.test(l)));
  expect(t.coordinator().state(t.row.id)).toBe("running");
  await sleep(500);
  expect(t.coordinator().state(t.row.id)).toBe("running"); // no blind cancel on the recovery 409
  expect(t.logs.some((l) => /→ cancelled locally/.test(l))).toBe(false);
  expect(t.next.interrupts).toHaveLength(0);
  expect(await t.execution()).toMatchObject({ state: "idle" });
  // The runtime ends: the local outcome is reported through the terminal
  // fact (the relay's first terminal stands; the fact is acknowledged as a replay).
  t.next.emit({ kind: "turn_ended", runtimeTurnId: "RuntimeTurn", status: "completed" });
  await until(() => t.coordinator().state(t.row.id) === "completed");
  await until(() => t.ledger.hasOutboundEvent(`term:${t.turnId}`));
  await until(() => t.logs.some((l) => /\] completed$/.test(l)));
  await sleep(300);
  expect(await t.events("turn.terminal")).toBe(1);
  expect(await t.turnRow()).toMatchObject({ state: "terminal", terminal_state: "interrupted" });
  expect(t.starts()).toBeLessThanOrEqual(1);
}, 30_000);
