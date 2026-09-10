// CLI sequences: the multi-step contracts the matrix (one verb per cell)
// cannot state — what happens to queued rows across a turn's end, an
// interrupt, a kill, a daemon restart; that a queued ask is answered by its
// OWN turn; that an approval answered from the CLI lets the turn continue;
// that `joy new --headless -m` creates, lists and delivers. Same harness as
// cli.matrix.test.ts: the real daemon path over a scripted runtime.
import { test, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.JOY_HOME_DIR = mkdtempSync(join(tmpdir(), "joy-cli-seq-"));
delete process.env.JOY_SESSION_ID;

const cli = await import("./cli");
const { FakeAgent, bootDaemon, pointCliAt, runCli, newId, settle, unwrapJoyMessage } = await import("./cli.matrix.fakeAgent");
import type { Daemon } from "./cli.matrix.fakeAgent";
const { closeAllLedgers } = await import("./domain/ledger");
const { resetCoordinators } = await import("./domain/coordinator");
const { loadWindowRecord } = await import("./domain/windowRecord");

let daemon: Daemon;
beforeAll(async () => {
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  daemon = await bootDaemon();
});
afterEach(() => { daemon.registry.reset(); pointCliAt(daemon.port, daemon.token); delete process.env.JOY_SESSION_ID; });
afterAll(async () => {
  await daemon.close();
  resetCoordinators(); closeAllLedgers();
  vi.restoreAllMocks();
  rmSync(process.env.JOY_HOME_DIR!, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fresh = () => daemon.registry.add(new FakeAgent(newId(), "/tmp/seq"));
const delivered = (agent: InstanceType<typeof FakeAgent>) => agent.submitted.map(unwrapJoyMessage);

test("queued rows are delivered one at a time, in order, each after the previous turn ends", async () => {
  const a = fresh();
  a.enqueue("A"); await settle();
  expect(await runCli(cli.cmdSend, a.id, "B")).toMatchObject({ exit: 0 });
  expect(await runCli(cli.cmdSend, a.id, "C")).toMatchObject({ exit: 0 });
  await settle();
  expect(delivered(a)).toEqual(["A"]);
  expect(a.pending()).toBe(2);
  a.endTurn("completed"); await settle(); await sleep(30);
  expect(delivered(a)).toEqual(["A", "B"]);          // B only — C waits for B's turn
  expect(a.pending()).toBe(1);
  a.endTurn("completed"); await settle(); await sleep(30);
  expect(delivered(a)).toEqual(["A", "B", "C"]);
  expect(a.pending()).toBe(0);
  a.endTurn("completed"); await settle();
  expect((await runCli(cli.cmdCheck, a.id)).exit).toBe(0);
});

test("a queued ask is answered by its OWN turn — the tail of the turn ahead of it is not its reply (#498)", async () => {
  const a = fresh();
  a.enqueue("A"); await settle();
  a.script = "reply";
  const ask = runCli(cli.cmdAsk, a.id, "--timeout", "5", "B");
  await sleep(300);
  a.say("A's late tail");
  a.endTurn("completed");
  const r = await ask;
  expect(r).toMatchObject({ exit: 0 });
  expect(r.out).toBe("re: B");
  expect(r.out).not.toContain("A's late tail");
});

test("abort interrupts the running turn and the queued row runs next", async () => {
  const a = fresh();
  a.enqueue("A"); await settle();
  await runCli(cli.cmdSend, a.id, "B"); await settle();
  expect(delivered(a)).toEqual(["A"]);
  expect(await runCli(cli.cmdAbort, a.id)).toMatchObject({ exit: 0 });
  await settle(); await sleep(50);
  expect(a.driver.interrupts.length).toBe(1);
  expect(delivered(a)).toEqual(["A", "B"]);          // B was not lost to the interrupt
  expect((await runCli(cli.cmdCheck, a.id)).exit).toBe(3);
});

test("kill drops the queue with the session: no row survives, nothing is delivered later", async () => {
  const a = fresh();
  a.enqueue("A"); await settle();
  await runCli(cli.cmdSend, a.id, "B"); await settle();
  expect(await runCli(cli.cmdKill, a.id)).toMatchObject({ exit: 0 });
  await settle();
  expect(a.ledger.listPending(a.id)).toEqual([]);
  expect(delivered(a)).toEqual(["A"]);
  expect((await runCli(cli.cmdQueue, a.id)).exit).toBe(1);   // gone
});

test("a paused queue holds its row until `joy queue <s> resume` — then it is dispatched", async () => {
  const a = fresh();
  a.pause();
  expect(await runCli(cli.cmdSend, a.id, "stuck")).toMatchObject({ exit: 0 });
  await settle(); await sleep(50);
  expect(delivered(a)).toEqual([]);
  const q = await runCli(cli.cmdQueue, a.id);
  expect(q.out).toContain("stuck");
  expect(q.out).toContain("(queue paused)");
  expect(await runCli(cli.cmdQueue, a.id, "resume")).toMatchObject({ exit: 0 });
  await settle(); await sleep(50);
  expect(delivered(a)).toEqual(["stuck"]);
  expect((await runCli(cli.cmdCheck, a.id)).exit).toBe(3);
});

test("approval from the CLI: ask reports needs input, approve lets the turn continue, the queued ask then runs and wait --turn returns its reply", async () => {
  const a = fresh();
  a.enqueue("A"); await settle();
  a.holdApproval("git push --force");
  const asked = await runCli(cli.cmdAsk, a.id, "--json", "--timeout", "4", "B");
  expect(asked.exit).toBe(6);
  const j = JSON.parse(asked.out);
  expect(j.state).toBe("needs_input");
  expect(j.approval).toMatchObject({ title: "git push --force" });
  const qid: string = j.turn;
  const approvals = await runCli(cli.cmdApprovals, a.id, "--json");
  expect(JSON.parse(approvals.out)).toHaveLength(1);
  expect(await runCli((r) => cli.cmdDecide(r, "allow"), a.id)).toMatchObject({ exit: 0 });
  expect(a.approvals).toEqual([]);
  expect((await runCli(cli.cmdCheck, a.id)).exit).toBe(3);   // A carries on
  a.script = "reply";
  a.endTurn("completed");                                     // A done → B runs and replies
  const w = await runCli(cli.cmdWaitIdle, a.id, "--turn", qid, "--timeout", "5", "--json");
  expect(w.exit).toBe(0);
  expect(JSON.parse(w.out).state).toBe("answered");
  expect(delivered(a)).toEqual(["A", "B"]);
});

test("deny ends the agent's turn: the session is idle afterwards", async () => {
  const a = fresh();
  a.enqueue("A"); await settle();
  a.holdApproval("rm -rf /");
  expect(await runCli((r) => cli.cmdDecide(r, "deny"), a.id)).toMatchObject({ exit: 0 });
  await sleep(80);
  expect((await runCli(cli.cmdCheck, a.id)).exit).toBe(0);
});

test("a daemon restart keeps the queued row: the replacement runtime receives it", async () => {
  const a = fresh();
  a.enqueue("A"); await settle();
  await runCli(cli.cmdSend, a.id, "B"); await settle();
  a.end("restart");                                           // the old runtime goes; queued rows stay
  daemon.registry.sessions.delete(a.id);
  const b = daemon.registry.add(new FakeAgent(a.id, "/tmp/seq"));   // same id, new generation
  await settle(); await sleep(50);
  expect(delivered(b)).toEqual(["B"]);
  expect((await runCli(cli.cmdCheck, a.id)).exit).toBe(3);
});

test("joy new --headless -m: creates in yolo, lists in `joy ls`, delivers the first message, marks the record headless", async () => {
  const dir = join(process.env.JOY_HOME_DIR!, "proj"); mkdirSync(dir, { recursive: true });
  const r = await runCli(cli.cmdNew, dir, "--headless", "--json", "-m", "hello there");
  expect(r.exit).toBe(0);
  const rec = JSON.parse(r.out.split("\n")[0]);
  expect(daemon.registry.created[0]).toMatchObject({ permissionMode: "bypassPermissions", forceNew: true }); // headless is stamped on the record after create, not passed in
  const ls = await runCli(cli.cmdList);
  expect(ls.out).toContain(rec.id);
  await settle(); await sleep(80);
  const agent = daemon.registry.get(rec.id)!;
  expect(delivered(agent)).toEqual(["hello there"]);
  expect(loadWindowRecord(rec.id)?.headless).toBe(true);
});

test("provenance: a CLI send is wrapped as from=cli with no reply-to; from a joy session it carries reply-to; --no-reply drops it", async () => {
  const a = fresh(); const sender = fresh();
  a.script = "reply";
  await runCli(cli.cmdSend, a.id, "one"); await settle();
  expect(a.submitted[0]).toMatch(/^<joy-message from="cli">\none\n<\/joy-message>$/);
  process.env.JOY_SESSION_ID = sender.id;
  a.endTurn("completed"); await sleep(60);
  await runCli(cli.cmdSend, a.id, "two"); await settle();
  expect(a.submitted[1]).toContain(`from="joy:${sender.id}"`);
  expect(a.submitted[1]).toContain(`reply-to="joy:${sender.id}"`);
  a.endTurn("completed"); await sleep(60);
  await runCli(cli.cmdSend, a.id, "--no-reply", "three"); await settle();
  expect(a.submitted[2]).toContain(`from="joy:${sender.id}"`);
  expect(a.submitted[2]).not.toContain("reply-to");
});

test("send --no-queue on a busy session is refused (exit 3) and leaves the queue untouched", async () => {
  const a = fresh();
  a.enqueue("A"); await settle();
  const r = await runCli(cli.cmdSend, a.id, "--no-queue", "B");
  expect(r.exit).toBe(3);
  expect(r.err).toContain("busy");
  expect(a.pending()).toBe(0);
});
