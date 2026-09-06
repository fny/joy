// The lane on the session coordinator (Wave C2, phase 3): a prompt offer is
// a command row carrying the relay turn; /start follows the driver's
// delivery echo (no busy() guess, no activity gate); the terminal fact is
// the command's terminal state and reason (#463 #584); a cancel offer is
// the row's durable cancel (retried until the runtime confirms; a re-offer
// is not new work); a restart mid-turn ends the turn interrupted{restart}
// (design table). A FakeDriver stands in for the adapter; the fake relay is
// the same scripted server the other lane tests use.
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import * as http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
process.env.JOY_HOME_DIR = mkdtempSync(joinPath(tmpdir(), "joy-lane-coord-test-"));
import { startNucleusLane, type NucleusLaneHandle } from "./nucleusLane";
import { ledgerFor, closeAllLedgers } from "../domain/ledger";
import { coordinatorFor, resetCoordinators } from "../domain/coordinator";
import { FakeDriver, settle } from "../domain/coordinator.fakeDriver";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const enc = (t: string) => JSON.stringify({ v: 1, t: "plain", text: t });
const spawnSpec = (cwd: string) => JSON.stringify({ v: 1, t: "spawn", cwd, agent: "codex" });
async function until(pred: () => boolean, ms = 8_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) { if (Date.now() > deadline) throw new Error("timeout waiting"); await sleep(50); }
}

function makeFakeRelay() {
  const calls: Array<{ method: string; path: string; body: any }> = [];
  const answers = new Map<string, { status: number; body: unknown }>();
  let workOffers: any[] = [];
  let controlOffers: any[] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      const path = req.url!.replace(/^\/joy\/v2/, "");
      const method = req.method!;
      // No keep-alive: a second lane over the same server must not inherit a
      // pooled socket the server already closed as idle (ECONNRESET).
      const send = (obj: unknown, status = 200) => { res.writeHead(status, { "content-type": "application/json", connection: "close" }); res.end(JSON.stringify(obj)); };
      const a = answers.get(`${method} ${path}`);
      if (a) { calls.push({ method, path, body }); return send(a.body, a.status); }
      if (path === "/daemon/leases") return send({ leaseId: "L1", leaseToken: "T1", epoch: 1 });
      if (/^\/daemon\/leases\/[^/]+$/.test(path) && method === "PUT") return send({ ok: true });
      if (path.endsWith("/claims/work")) { const o = workOffers; workOffers = []; return send({ offers: o }); }
      if (path.endsWith("/claims/control")) { const o = controlOffers; controlOffers = []; return send({ offers: o }); }
      if (path === "/sessions" && method === "GET") return send({ sessions: [] });
      calls.push({ method, path, body });
      send({ ok: true });
    });
  });
  return {
    server, calls, answers,
    listen: () => new Promise<string>((r) => server.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${(server.address() as any).port}`))),
    pushWork: (o: any) => workOffers.push(o),
    pushControl: (o: any) => controlOffers.push(o),
    facts: (turn: string) => calls.filter((c) => c.path === `/daemon/turns/${turn}/facts`).map((c) => c.body),
    terminal: (turn: string) => calls.find((c) => c.path === `/daemon/turns/${turn}/facts` && c.body.type === "terminal")?.body,
    /** Every terminal publication for the turn: a turn fact under the lane's
     *  own lease, or a reconcile carrying the recorded outcome (a previous
     *  daemon's / lease's turn, #74). */
    terminals: (turn: string) => calls.filter((c) => (c.path === `/daemon/turns/${turn}/facts` && c.body.type === "terminal") || (c.path === `/daemon/turns/${turn}/reconcile` && c.body.resolution === "terminal")).map((c) => c.body),
    count: (frag: string) => calls.filter((c) => c.path.includes(frag)).length,
  };
}

/** A coordinator-driven session: no queue surface of its own (no enqueue). */
function coordinatedSession(id: string) {
  const ledger = ledgerFor();
  const gen = ledger.openGeneration(id, "codex");
  const driver = new FakeDriver(id, gen);
  const coordinator = coordinatorFor(ledger);
  coordinator.adopt(id, driver);
  driver.ready();
  const s: any = {
    id, status: "active", cwd: "/tmp/x", claudeSessionId: undefined, agentFlavor: "codex",
    busy: () => coordinator.busy(id),
    abort: () => coordinator.abortRunning(id),
    end(reason: "killed" | "process_exited" | "restart") { s.status = "ended"; coordinator.retire(id, reason); return true; },
  };
  return { s, driver, coordinator, ledger };
}

let handle: NucleusLaneHandle | null = null;
let srv: http.Server | null = null;
beforeEach(() => { closeAllLedgers(); resetCoordinators(); });
afterEach(async () => { await handle?.stop(); handle = null; srv?.close(); srv = null; });

describe("nucleusLane on the coordinator", () => {
  it("prompt: accept(relayTurnId) → /start on the driver's echo → terminal from the runtime's turn-end (failed stays failed)", async () => {
    const relay = makeFakeRelay();
    const url = await relay.listen(); srv = relay.server;
    const { s, driver, ledger } = coordinatedSession("cs000001");
    const registry: any = { get: (i: string) => (i === "cs000001" ? s : undefined), list: () => [s], create: async () => s, chatHistory: () => [], listRecords: () => [], saveRecord: () => {} };
    handle = startNucleusLane({ registry, relayUrl: url, token: "tok", machineId: "m1", log: () => {} });
    relay.pushWork({ deliveryId: "d0", commandId: "spawnc", sessionId: "v2s1", kind: "spawn_session", ciphertext: spawnSpec("/tmp/x") });
    await until(() => relay.count("/bind") === 1);
    relay.pushWork({ deliveryId: "d1", commandId: "c1", sessionId: "v2s1", kind: "prompt", turnId: "t1", ciphertext: enc("do it") });
    await until(() => driver.submits.length === 1);
    const row = ledger.commandForRelayTurn("t1")!;
    expect(row).toMatchObject({ text: "do it", relayCommandId: "c1", state: "submitting", origin: "relay" });
    expect(relay.count("/turns/t1/submitted")).toBe(1);
    expect(relay.count("/turns/t1/start")).toBe(0); // no delivery proof yet: no start
    driver.lastSubmit.settle.resolve({ kind: "accepted", runtimeTurnId: "T1" });
    await settle();
    expect(relay.count("/turns/t1/start")).toBe(0); // accepted is not running
    driver.emit({ kind: "echo", runtimeRef: row.id, runtimeTurnId: "T1", receiptKind: "codex_client" });
    await until(() => relay.count("/turns/t1/start") === 1);
    driver.emit({ kind: "turn_ended", runtimeTurnId: "T1", status: "failed" });
    await until(() => !!relay.terminal("t1"), 10_000);
    expect(relay.terminal("t1")).toMatchObject({ terminalState: "failed", meta: { reason: "agent_reported_failed" } });
    expect(ledger.getCommand(row.id)?.state).toBe("failed");
    // A re-offer of the same turn is the same row — never a second submit.
    relay.pushWork({ deliveryId: "d1b", commandId: "c1", sessionId: "v2s1", kind: "prompt", turnId: "t1", ciphertext: enc("do it") });
    await sleep(1_500);
    expect(driver.submits).toHaveLength(1);
  }, 25_000);

  it("cancel: the row's durable cancel → the driver's interrupt (retried) → terminal cancelled; a re-offer is not new work", async () => {
    const relay = makeFakeRelay();
    const url = await relay.listen(); srv = relay.server;
    const { s, driver, ledger } = coordinatedSession("cs000002");
    driver.onInterrupt = () => ({ kind: "sent" });
    const registry: any = { get: (i: string) => (i === "cs000002" ? s : undefined), list: () => [s], create: async () => s, chatHistory: () => [], listRecords: () => [], saveRecord: () => {} };
    handle = startNucleusLane({ registry, relayUrl: url, token: "tok", machineId: "m2", log: () => {} });
    relay.pushWork({ deliveryId: "d0", commandId: "spawnc", sessionId: "v2s2", kind: "spawn_session", ciphertext: spawnSpec("/tmp/x") });
    await until(() => relay.count("/bind") === 1);
    relay.pushWork({ deliveryId: "d1", commandId: "c1", sessionId: "v2s2", kind: "prompt", turnId: "t2", ciphertext: enc("long job") });
    await until(() => driver.submits.length === 1);
    const row = ledger.commandForRelayTurn("t2")!;
    driver.lastSubmit.settle.resolve({ kind: "accepted", runtimeTurnId: "T2" });
    await settle();
    driver.emit({ kind: "echo", runtimeRef: row.id, runtimeTurnId: "T2" });
    await until(() => relay.count("/turns/t2/start") === 1);
    for (let i = 0; i < 3; i++) { relay.pushControl({ deliveryId: `dc${i}`, commandId: `cc${i}`, sessionId: "v2s2", targetTurnId: "t2" }); await sleep(600); }
    await until(() => driver.interrupts.length >= 1);
    expect(ledger.getCommand(row.id)?.state).toBe("cancelling");
    expect(driver.lastInterrupt.attempt?.runtimeTurnId).toBe("T2");
    driver.emit({ kind: "turn_ended", runtimeTurnId: "T2", status: "cancelled" });
    await until(() => !!relay.terminal("t2"), 10_000);
    expect(relay.terminal("t2")).toMatchObject({ terminalState: "cancelled" });
    expect(relay.count("/deliveries/dc0/received")).toBe(1);
    expect(relay.count("/deliveries/dc1/received")).toBe(1); // every offer is received…
    expect(driver.interrupts.length).toBeLessThanOrEqual(2); // …but the interrupt is not re-fired per re-offer
  }, 25_000);

  it("restart mid-turn: the command ends interrupted{restart} and so does the relay turn", async () => {
    const relay = makeFakeRelay();
    const url = await relay.listen(); srv = relay.server;
    const { s, driver, ledger } = coordinatedSession("cs000003");
    const registry: any = { get: (i: string) => (i === "cs000003" ? s : undefined), list: () => [s], create: async () => s, chatHistory: () => [], listRecords: () => [], saveRecord: () => {} };
    handle = startNucleusLane({ registry, relayUrl: url, token: "tok", machineId: "m3", log: () => {} });
    relay.pushWork({ deliveryId: "d0", commandId: "spawnc", sessionId: "v2s3", kind: "spawn_session", ciphertext: spawnSpec("/tmp/x") });
    await until(() => relay.count("/bind") === 1);
    relay.pushWork({ deliveryId: "d1", commandId: "c1", sessionId: "v2s3", kind: "prompt", turnId: "t3", ciphertext: enc("work") });
    await until(() => driver.submits.length === 1);
    const row = ledger.commandForRelayTurn("t3")!;
    driver.lastSubmit.settle.resolve({ kind: "accepted", runtimeTurnId: "T3" });
    await settle();
    driver.emit({ kind: "echo", runtimeRef: row.id, runtimeTurnId: "T3" });
    await until(() => relay.count("/turns/t3/start") === 1);
    s.end("restart");
    await until(() => !!relay.terminal("t3"), 10_000);
    expect(relay.terminal("t3")).toMatchObject({ terminalState: "interrupted", meta: { reason: "restart" } });
    expect(ledger.getCommand(row.id)).toMatchObject({ state: "interrupted", terminalReason: "restart" });
  }, 25_000);

  it("crash between /start and the terminal: a fresh lane over the same ledger re-drives the row once — no second /start, one terminal (R13)", async () => {
    const relay = makeFakeRelay();
    const url = await relay.listen(); srv = relay.server;
    const { s, driver, ledger } = coordinatedSession("cs000005");
    const registry: any = { get: (i: string) => (i === "cs000005" ? s : undefined), list: () => [s], create: async () => s, chatHistory: () => [], listRecords: () => [{ id: "cs000005", v2SessionId: "v2s5" }], saveRecord: () => {} };
    // Lane 1 runs the turn up to /start…
    let lane1: NucleusLaneHandle | null = startNucleusLane({ registry, relayUrl: url, token: "tok", machineId: "m5", log: () => {} });
    relay.pushWork({ deliveryId: "d0", commandId: "spawnc", sessionId: "v2s5", kind: "spawn_session", ciphertext: spawnSpec("/tmp/x") });
    await until(() => relay.count("/bind") === 1);
    relay.pushWork({ deliveryId: "d1", commandId: "c1", sessionId: "v2s5", kind: "prompt", turnId: "t6", ciphertext: enc("survive me") });
    await until(() => driver.submits.length === 1);
    const row = ledger.commandForRelayTurn("t6")!;
    driver.lastSubmit.settle.resolve({ kind: "accepted", runtimeTurnId: "T6" });
    await settle();
    driver.emit({ kind: "echo", runtimeRef: row.id, runtimeTurnId: "T6" });
    await until(() => relay.count("/turns/t6/start") === 1);
    expect(relay.terminal("t6")).toBeUndefined();
    // …and the daemon "crashes": the lane stops before any terminal is
    // written; the row is `running` in the ledger, nothing else survives.
    await lane1.stop(); lane1 = null;
    expect(ledger.hasOutboundEvent("term:t6")).toBe(false);
    // The runtime finishes while no lane is alive (or right after boot — the
    // observation lands on the command either way).
    driver.emit({ kind: "turn_ended", runtimeTurnId: "T6", status: "completed" });
    expect(ledger.getCommand(row.id)?.state).toBe("completed");
    expect(ledger.hasOutboundEvent("term:t6")).toBe(false);
    // Boot a fresh lane over the same ledger: the boot pass settles the row —
    // one terminal row, posted once — and never re-posts /start.
    handle = startNucleusLane({ registry, relayUrl: url, token: "tok", machineId: "m5", log: () => {} });
    await until(() => relay.terminals("t6").length > 0, 10_000);
    await sleep(1_500);
    // Published exactly once — as the recorded outcome (a fact under this
    // lane's lease, or a reconcile for the previous daemon's turn).
    expect(relay.terminals("t6")).toHaveLength(1);
    expect(relay.terminals("t6")[0]).toMatchObject({ terminalState: "completed" });
    expect(relay.count("/turns/t6/start")).toBe(1);
    expect(ledger.hasOutboundEvent("term:t6")).toBe(true);
    // A second boot over the same ledger changes nothing: the terminal row
    // is acked and its id (`term:<turn>`) is stable.
    await handle.stop();
    handle = startNucleusLane({ registry, relayUrl: url, token: "tok", machineId: "m5", log: () => {} });
    await sleep(1_500);
    expect(relay.terminals("t6")).toHaveLength(1);
    expect(relay.count("/turns/t6/start")).toBe(1);
  }, 30_000);

  it("crash between /start and the terminal, the turn still running at boot: the resumed loop waits for the runtime and posts once", async () => {
    const relay = makeFakeRelay();
    const url = await relay.listen(); srv = relay.server;
    const { s, driver, ledger } = coordinatedSession("cs000006");
    const registry: any = { get: (i: string) => (i === "cs000006" ? s : undefined), list: () => [s], create: async () => s, chatHistory: () => [], listRecords: () => [{ id: "cs000006", v2SessionId: "v2s6" }], saveRecord: () => {} };
    let lane1: NucleusLaneHandle | null = startNucleusLane({ registry, relayUrl: url, token: "tok", machineId: "m6", log: () => {} });
    relay.pushWork({ deliveryId: "d0", commandId: "spawnc", sessionId: "v2s6", kind: "spawn_session", ciphertext: spawnSpec("/tmp/x") });
    await until(() => relay.count("/bind") === 1);
    relay.pushWork({ deliveryId: "d1", commandId: "c1", sessionId: "v2s6", kind: "prompt", turnId: "t7", ciphertext: enc("long") });
    await until(() => driver.submits.length === 1);
    const row = ledger.commandForRelayTurn("t7")!;
    driver.lastSubmit.settle.resolve({ kind: "accepted", runtimeTurnId: "T7" });
    await settle();
    driver.emit({ kind: "echo", runtimeRef: row.id, runtimeTurnId: "T7" });
    await until(() => relay.count("/turns/t7/start") === 1);
    await lane1.stop(); lane1 = null;
    handle = startNucleusLane({ registry, relayUrl: url, token: "tok", machineId: "m6", log: () => {} });
    await sleep(1_500);
    expect(relay.count("/turns/t7/start")).toBe(1); // resumed as `running`: not re-started
    expect(relay.terminal("t7")).toBeUndefined();   // still running: nothing to publish yet
    driver.emit({ kind: "turn_ended", runtimeTurnId: "T7", status: "failed" });
    await until(() => relay.terminals("t7").length > 0, 10_000);
    await sleep(500);
    expect(relay.terminals("t7")).toHaveLength(1);
    expect(relay.terminals("t7")[0]).toMatchObject({ terminalState: "failed", meta: { reason: "agent_reported_failed" } });
  }, 30_000);

  it("boot: a relay turn the ledger still carries gets its loop back and its terminal row (R13)", async () => {
    const relay = makeFakeRelay();
    const url = await relay.listen(); srv = relay.server;
    const { s, driver, ledger, coordinator } = coordinatedSession("cs000004");
    // A previous daemon accepted the turn and its runtime is still running it.
    const c = coordinator.accept({ sessionId: "cs000004", text: "carried", source: "rpc", visible: false, mirrorToRelay: false, relayTurnId: "t4", relayCommandId: "c4" });
    await settle();
    driver.lastSubmit.settle.resolve({ kind: "accepted", runtimeTurnId: "T4" });
    await settle();
    driver.emit({ kind: "echo", runtimeRef: c.id, runtimeTurnId: "T4" });
    expect(ledger.getCommand(c.id)?.state).toBe("running");
    // …and one that ended while no lane was alive.
    const done = coordinator.accept({ sessionId: "cs000004", text: "ended", source: "rpc", visible: false, mirrorToRelay: false, relayTurnId: "t5", relayCommandId: "c5" });
    coordinator.cancel(done.id);
    expect(ledger.getCommand(done.id)?.state).toBe("cancelled");
    const registry: any = { get: (i: string) => (i === "cs000004" ? s : undefined), list: () => [s], create: async () => s, chatHistory: () => [], listRecords: () => [{ id: "cs000004", v2SessionId: "v2s4" }], saveRecord: () => {} };
    handle = startNucleusLane({ registry, relayUrl: url, token: "tok", machineId: "m4", log: () => {} });
    await until(() => !!relay.terminal("t5"), 10_000);
    expect(relay.terminal("t5")).toMatchObject({ terminalState: "cancelled" });
    // The row is running but NO /start was ever acknowledged (this fixture is
    // exactly "died between the driver's echo and the POST", Astra on
    // e8f8b2cc): the resumed loop posts it — once, under the stable event id.
    await until(() => relay.count("/turns/t4/start") === 1, 10_000);
    await sleep(500);
    expect(relay.count("/turns/t4/start")).toBe(1);
    expect(relay.calls.find((c) => c.path === "/daemon/turns/t4/start")?.body).toMatchObject({ runtimeEventId: "start:t4" });
    expect(ledger.hasReceipt("cs000004", "relay_start", "t4")).toBe(true);
    driver.emit({ kind: "turn_ended", runtimeTurnId: "T4", status: "completed" });
    await until(() => !!relay.terminal("t4"), 10_000);
    expect(relay.terminal("t4")).toMatchObject({ terminalState: "completed" });
  }, 25_000);

  // ── e8f8b2cc review residual: a REAL daemon replacement — fresh coordinator,
  // new generation, new driver over the same ledger — with the /start
  // acknowledgement as the durable fact, not the local running state.

  /** The daemon "restarts": the process-wide coordinator is forgotten, the
   *  session's next generation opens over the same ledger (running rows →
   *  unknown), and a NEW driver is adopted whose reconcile finds the turn
   *  still running (codex thread/read). */
  function replaceDaemon(id: string, runtimeTurnId: string) {
    resetCoordinators();
    const ledger = ledgerFor();
    const gen = ledger.openGeneration(id, "codex");
    const driver = new FakeDriver(id, gen);
    driver.onReconcile = (call) => call.pending.map((p) => ({ attemptId: p.attemptId, outcome: "running" as const, runtimeTurnId }));
    const coordinator = coordinatorFor(ledger);
    coordinator.adopt(id, driver);
    driver.ready();
    const s: any = {
      id, status: "active", cwd: "/tmp/x", claudeSessionId: undefined, agentFlavor: "codex",
      busy: () => coordinator.busy(id),
      abort: () => coordinator.abortRunning(id),
      end(reason: "killed" | "process_exited" | "restart") { s.status = "ended"; coordinator.retire(id, reason); return true; },
    };
    return { s, driver, coordinator, ledger, generation: gen };
  }

  it("driver replacement, crash after the echo but BEFORE /start: the new generation reconciles the turn running and the resumed loop posts /start exactly once, then one terminal", async () => {
    const relay = makeFakeRelay();
    const url = await relay.listen(); srv = relay.server;
    const first = coordinatedSession("cs000007");
    // Daemon 1: the prompt is delivered (echo → running) and the daemon dies
    // before POST /start — no lane ever ran for this turn.
    const c = first.coordinator.accept({ sessionId: "cs000007", text: "survive a real restart", source: "rpc", visible: false, mirrorToRelay: false, relayTurnId: "t8", relayCommandId: "c8" });
    await settle();
    first.driver.lastSubmit.settle.resolve({ kind: "accepted", runtimeTurnId: "T8" });
    await settle();
    first.driver.emit({ kind: "echo", runtimeRef: c.id, runtimeTurnId: "T8" });
    expect(first.ledger.getCommand(c.id)?.state).toBe("running");
    expect(first.ledger.hasReceipt("cs000007", "relay_start_intent", "t8")).toBe(false);
    expect(first.ledger.hasReceipt("cs000007", "relay_start", "t8")).toBe(false);
    // Daemon 2: a fresh coordinator + generation 2 + a new driver over the same ledger.
    const next = replaceDaemon("cs000007", "T8");
    expect(next.generation).toBe(first.driver.generation + 1);
    expect(next.coordinator).not.toBe(first.coordinator);
    await until(() => next.ledger.getCommand(c.id)?.state === "running");
    expect(next.ledger.latestAttempt(c.id)?.generation).toBe(first.driver.generation); // the SAME attempt: never resent
    const registry: any = { get: (i: string) => (i === "cs000007" ? next.s : undefined), list: () => [next.s], create: async () => next.s, chatHistory: () => [], listRecords: () => [{ id: "cs000007", v2SessionId: "v2s7" }], saveRecord: () => {} };
    handle = startNucleusLane({ registry, relayUrl: url, token: "tok", machineId: "m7", log: () => {} });
    await until(() => relay.count("/turns/t8/start") === 1, 10_000);
    await sleep(1_000);
    expect(relay.count("/turns/t8/start")).toBe(1); // exactly once
    expect(relay.calls.find((cl) => cl.path === "/daemon/turns/t8/start")?.body).toMatchObject({ runtimeEventId: "start:t8" });
    expect(next.ledger.hasReceipt("cs000007", "relay_start", "t8")).toBe(true);
    expect(relay.terminal("t8")).toBeUndefined();
    next.driver.emit({ kind: "turn_ended", runtimeTurnId: "T8", status: "completed" });
    await until(() => relay.terminals("t8").length > 0, 10_000);
    await sleep(500);
    expect(relay.terminals("t8")).toHaveLength(1);
    expect(relay.terminals("t8")[0]).toMatchObject({ terminalState: "completed" });
    expect(first.driver.submits).toHaveLength(1);
    expect(next.driver.submits).toHaveLength(0);
  }, 30_000);

  it("driver replacement, crash AFTER /start: the acknowledged start is never re-posted by the new generation's loop; one terminal", async () => {
    const relay = makeFakeRelay();
    const url = await relay.listen(); srv = relay.server;
    const first = coordinatedSession("cs000008");
    const registry1: any = { get: (i: string) => (i === "cs000008" ? first.s : undefined), list: () => [first.s], create: async () => first.s, chatHistory: () => [], listRecords: () => [{ id: "cs000008", v2SessionId: "v2s8" }], saveRecord: () => {} };
    let lane1: NucleusLaneHandle | null = startNucleusLane({ registry: registry1, relayUrl: url, token: "tok", machineId: "m8", log: () => {} });
    relay.pushWork({ deliveryId: "d0", commandId: "spawnc", sessionId: "v2s8", kind: "spawn_session", ciphertext: spawnSpec("/tmp/x") });
    await until(() => relay.count("/bind") === 1);
    relay.pushWork({ deliveryId: "d1", commandId: "c1", sessionId: "v2s8", kind: "prompt", turnId: "t9", ciphertext: enc("long one") });
    await until(() => first.driver.submits.length === 1);
    const row = first.ledger.commandForRelayTurn("t9")!;
    first.driver.lastSubmit.settle.resolve({ kind: "accepted", runtimeTurnId: "T9" });
    await settle();
    first.driver.emit({ kind: "echo", runtimeRef: row.id, runtimeTurnId: "T9" });
    await until(() => relay.count("/turns/t9/start") === 1);
    await until(() => first.ledger.hasReceipt("cs000008", "relay_start", "t9"));
    expect(first.ledger.hasReceipt("cs000008", "relay_start_intent", "t9")).toBe(true);
    // The daemon dies after the acknowledged /start.
    await lane1.stop(); lane1 = null;
    const next = replaceDaemon("cs000008", "T9");
    await until(() => next.ledger.getCommand(row.id)?.state === "running");
    const registry2: any = { get: (i: string) => (i === "cs000008" ? next.s : undefined), list: () => [next.s], create: async () => next.s, chatHistory: () => [], listRecords: () => [{ id: "cs000008", v2SessionId: "v2s8" }], saveRecord: () => {} };
    handle = startNucleusLane({ registry: registry2, relayUrl: url, token: "tok", machineId: "m8", log: () => {} });
    await sleep(1_500);
    expect(relay.count("/turns/t9/start")).toBe(1); // zero new /start: the ack is the durable fact
    expect(relay.terminal("t9")).toBeUndefined();
    next.driver.emit({ kind: "turn_ended", runtimeTurnId: "T9", status: "failed" });
    await until(() => relay.terminals("t9").length > 0, 10_000);
    await sleep(500);
    expect(relay.terminals("t9")).toHaveLength(1);
    expect(relay.terminals("t9")[0]).toMatchObject({ terminalState: "failed", meta: { reason: "agent_reported_failed" } });
    expect(relay.count("/turns/t9/start")).toBe(1);
  }, 30_000);
});
