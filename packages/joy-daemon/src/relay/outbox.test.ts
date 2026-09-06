// OutboxSender: one loop per session in persisted order, retry by stable
// event id with backoff persisted in the row, drop on permanent refusal,
// park on unbound until a bind wakes the line, resume after a restart.
import { test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger, type OutboxRow } from "../domain/ledger";
import { OutboxSender, type PostResult } from "./outbox";

let dir: string;
let ledger: Ledger;
let now = 1_000_000;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "outbox-")); now = 1_000_000; ledger = Ledger.open(dir, { now: () => now }); });
afterEach(() => { ledger.close(); rmSync(dir, { recursive: true, force: true }); });

const row = (sessionId: string, id: string, extra: Partial<Parameters<Ledger["enqueueOutbound"]>[0][0]> = {}) =>
  ({ sessionId, kind: "output" as const, runtimeEventId: id, sealed: false, body: { id }, ...extra });
const tick = () => new Promise((r) => setTimeout(r, 0));
const until = async (f: () => boolean, ms = 2000) => { const end = Date.now() + ms; while (!f()) { if (Date.now() > end) throw new Error("timeout"); await tick(); } };

function sender(post: (row: OutboxRow) => Promise<PostResult>, opts: { ready?: () => boolean } = {}) {
  const sleeps: number[] = [];
  const s = new OutboxSender({
    ledger, post, ready: opts.ready ?? (() => true), now: () => now,
    sleep: async (ms) => { sleeps.push(ms); now += ms; await tick(); },
    baseBackoffMs: 100, maxBackoffMs: 800, idleMs: 50,
  });
  return { s, sleeps };
}

test("sends a session's rows in seq order, one at a time, and acks each", async () => {
  ledger.enqueueOutbound([row("A", "a1", { v2SessionId: "v2a" }), row("A", "a2", { v2SessionId: "v2a" }), row("B", "b1", { v2SessionId: "v2b" })]);
  const posted: string[] = [];
  let inFlight = 0, maxInFlight = 0;
  const { s } = sender(async (r) => { inFlight++; maxInFlight = Math.max(maxInFlight, inFlight); await tick(); inFlight--; posted.push(r.runtimeEventId); return { ok: true }; });
  s.start();
  await until(() => posted.length === 3);
  expect(posted.filter((p) => p.startsWith("a"))).toEqual(["a1", "a2"]);
  expect(ledger.sessionsWithOutbound()).toEqual([]);
  expect(maxInFlight).toBeLessThanOrEqual(2); // one per session, two sessions
  s.stop();
});

test("a transient failure retries the SAME event id after a persisted backoff; a restart resumes the schedule", async () => {
  ledger.enqueueOutbound([row("A", "a1", { v2SessionId: "v2a" })]);
  let fails = 2;
  const attempts: string[] = [];
  const { s, sleeps } = sender(async (r) => { attempts.push(r.runtimeEventId); if (fails-- > 0) return { ok: false, fate: "transient", error: "503" }; return { ok: true }; });
  s.start();
  await until(() => attempts.length === 3);
  expect(attempts).toEqual(["a1", "a1", "a1"]);
  expect(sleeps.slice(0, 2)).toEqual([100, 200]); // exponential, from the row's attempt count
  expect(ledger.getOutbound(1)?.ackedAt).toBe(now);
  s.stop();
  // Crash mid-backoff: the next daemon's sender waits out the persisted next_retry_at.
  ledger.enqueueOutbound([row("A", "a2", { v2SessionId: "v2a" })]);
  ledger.failOutbound(2, "503", now + 500);
  const later: string[] = [];
  const { s: s2, sleeps: sl2 } = sender(async (r) => { later.push(r.runtimeEventId); return { ok: true }; });
  s2.start();
  await until(() => later.length === 1);
  expect(sl2[0]).toBe(500);
  s2.stop();
});

test("a permanent refusal drops the row and the line moves on; the drop reason is recorded", async () => {
  ledger.enqueueOutbound([row("A", "bad", { v2SessionId: "v2a" }), row("A", "good", { v2SessionId: "v2a" })]);
  const posted: string[] = [];
  const { s } = sender(async (r) => { posted.push(r.runtimeEventId); return r.runtimeEventId === "bad" ? { ok: false, fate: "permanent", error: "409 turn_terminal" } : { ok: true }; });
  s.start();
  await until(() => posted.length === 2);
  expect(ledger.getOutbound(1)?.lastError).toBe("dropped: 409 turn_terminal");
  expect(ledger.nextOutbound("A")).toBeNull();
  s.stop();
});

test("an unbound head parks the line without spinning; bind + wake resumes it in order", async () => {
  ledger.enqueueOutbound([row("A", "first"), row("A", "second")]);
  const posted: string[] = [];
  const { s, sleeps } = sender(async (r) => { if (!r.v2SessionId) return { ok: false, fate: "unbound", error: "not bound" }; posted.push(r.runtimeEventId); return { ok: true }; });
  s.start();
  await until(() => !s.active("A"));
  expect(posted).toEqual([]);
  expect(sleeps).toEqual([]);
  expect(ledger.bindOutbound("A", "v2a", { sealed: false })).toBe(2);
  s.wake("A");
  await until(() => posted.length === 2);
  expect(posted).toEqual(["first", "second"]);
  s.stop();
});

test("no lease: the loop idles and sends once ready; a terminal row is sent after the session's earlier outputs", async () => {
  let ready = false;
  ledger.enqueueOutbound([row("A", "out", { v2SessionId: "v2a" }), { sessionId: "A", kind: "terminal", runtimeEventId: "term:t1", relayTurnId: "t1", v2SessionId: "v2a", sealed: false, body: { terminalState: "completed" } }]);
  const posted: string[] = [];
  const { s } = sender(async (r) => { posted.push(r.kind === "terminal" ? "terminal" : r.runtimeEventId); return { ok: true }; }, { ready: () => ready });
  s.start();
  await tick(); await tick();
  expect(posted).toEqual([]);
  ready = true;
  await until(() => posted.length === 2);
  expect(posted).toEqual(["out", "terminal"]);
  s.stop();
});

test("awaitSettled resolves on ack, on drop, and times out (false) while the row keeps retrying", async () => {
  ledger.enqueueOutbound([row("A", "slow", { v2SessionId: "v2a" })]);
  let ok = false;
  const { s } = sender(async () => (ok ? { ok: true } : { ok: false, fate: "transient", error: "503" }));
  s.start();
  expect(await s.awaitSettled(1, 20)).toBe(false);
  ok = true;
  expect(await s.awaitSettled(1, 2000)).toBe(true);
  expect(ledger.getOutbound(1)?.ackedAt).not.toBeNull();
  expect(await s.awaitSettled(1, 10)).toBe(true); // already settled
  s.stop();
});

test("a row enqueued while the loop is finishing is not stranded (wake after the last empty read)", async () => {
  ledger.enqueueOutbound([row("A", "a1", { v2SessionId: "v2a" })]);
  const posted: string[] = [];
  const { s } = sender(async (r) => {
    posted.push(r.runtimeEventId);
    if (r.runtimeEventId === "a1") { ledger.enqueueOutbound([row("A", "a2", { v2SessionId: "v2a" })]); s.wake("A"); }
    return { ok: true };
  });
  s.start();
  await until(() => posted.length === 2);
  expect(posted).toEqual(["a1", "a2"]);
  s.stop();
});
