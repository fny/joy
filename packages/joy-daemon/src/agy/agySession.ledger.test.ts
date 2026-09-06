// agy's queue lives in the ledger (C1, #49) under the session coordinator
// (C2): prompts are accepted before they are queued, a spawn is an attempt,
// the prompt on stdin is the delivery (running), the run's settlement is the
// terminal, and a restart's replacement takes the queue instead of losing
// it. Same fake child as agySession.test.ts; isolated JOY_HOME_DIR.
import { test, expect, vi, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const H = vi.hoisted(() => ({ procs: [] as any[] }));

vi.mock("node:child_process", async (importOriginal) => {
  const orig = await importOriginal<typeof import("node:child_process")>();
  const { EventEmitter } = await import("node:events");
  const { PassThrough } = await import("node:stream");
  class FakeProc extends EventEmitter {
    stdout = new PassThrough();
    stderr = new PassThrough();
    stdin = new PassThrough();
    stdinText = "";
    pid = 5000 + H.procs.length;
    exitCode: number | null = null;
    signalCode: string | null = null;
    constructor() { super(); this.stdin.on("data", (c: Buffer) => { this.stdinText += String(c); }); }
    kill() { this.exitCode = 143; this.emit("exit", null); this.stdout.end(); return true; }
  }
  return { ...orig, spawn: vi.fn(() => { const p = new FakeProc(); H.procs.push(p); return p; }) };
});

import { AgySession } from "./agySession";
import { ledgerFor } from "../domain/ledger";
import { queueFor } from "../domain/queueFacade";

let home: string;
beforeAll(() => { home = mkdtempSync(join(tmpdir(), "joy-agy-ledger-")); process.env.JOY_HOME_DIR = home; });
afterAll(() => { delete process.env.JOY_HOME_DIR; rmSync(home, { recursive: true, force: true }); });

const line = (o: unknown) => JSON.stringify(o) + "\n";
const result = () => line({ event: "result", result: { status: "SUCCESS" } });
const relay = () => new Proxy({}, { get: (_t, k) => k === "send" ? (() => {}) : k === "relaySessionId" ? "relay-1" : k === "metadataSnapshot" ? null : (() => Promise.resolve(true)) });
function harness(id: string) {
  const s = new AgySession({ id, cwd: home, status: "starting", startedAt: 0, conversationId: "conv-1" }, { relayClient: null, broadcast: () => {}, addChatMessage: () => {} });
  s.attachRelay(relay() as any);
  s.beginWatching();
  return s;
}

test("queued prompts are ledger rows; the one in flight is delivered once it is on stdin; a restart reloads the rest (#49)", async () => {
  H.procs.length = 0;
  const id = "agy-led-1";
  const s = harness(id);
  const q = queueFor(s);
  const a = q.accept("first", { mirrorToRelay: false, visible: true });
  const b = q.accept("second", { mirrorToRelay: false, visible: true });
  const c = q.accept("third", { mirrorToRelay: false, visible: true });
  await vi.waitFor(() => expect(H.procs).toHaveLength(1));
  const ledger = ledgerFor();
  await vi.waitFor(() => expect(ledger.getCommand(a.id)).toMatchObject({ state: "running" })); // on the harness's stdin: delivered, its result pending
  expect(q.itemState(a.id)).toBe("delivered");
  expect(ledger.listPending(id, ["queued"]).map((r) => r.text)).toEqual(["second", "third"]);
  expect(q.reorder(c.id, 0)).toBe(true);
  expect(ledger.listPending(id, ["queued"]).map((r) => r.text)).toEqual(["third", "second"]);
  expect(q.edit(b.id, "second, edited")).toBe(true);
  expect(ledger.getCommand(b.id)?.text).toBe("second, edited");
  // Restart mid-turn: the old process dies with turn one (its command is
  // interrupted: the turn was live in a runtime torn down on purpose); the
  // queue carries over.
  s.end("restart");
  expect(ledger.getCommand(a.id)).toMatchObject({ state: "interrupted", terminalReason: "restart" });
  expect(ledger.listPending(id).map((r) => r.text)).toEqual(["third", "second, edited"]);
  const s2 = harness(id);
  await vi.waitFor(() => expect(H.procs).toHaveLength(2)); // "third" went straight in flight
  await vi.waitFor(() => expect(queueFor(s2).state().running?.text).toBe("third"));
  expect(queueFor(s2).state().queue.map((x) => x.text)).toEqual(["second, edited"]);
  expect(H.procs[1].stdinText).toContain("third");
  s2.end("killed");
  expect(ledger.listPending(id)).toEqual([]); // a kill interrupts what is left
  expect(queueFor(s2).itemState(b.id)).toBe("cancelled");
});

test("a spawn failure fails the row durably; cancelQueued cancels the ledger row", async () => {
  H.procs.length = 0;
  const id = "agy-led-2";
  const s = harness(id);
  const q = queueFor(s);
  const a = q.accept("boom", { mirrorToRelay: false });
  const b = q.accept("later", { mirrorToRelay: false });
  await vi.waitFor(() => expect(H.procs).toHaveLength(1));
  expect(q.cancel(b.id)).toBe(true);
  expect(ledgerFor().getCommand(b.id)?.state).toBe("cancelled");
  const p = H.procs[0];
  p.stdout.write(result());
  p.stdout.end();
  p.exitCode = 0; p.emit("exit", 0);
  await vi.waitFor(() => expect(q.state().running).toBeNull());
  expect(q.itemState(a.id)).toBe("delivered");
  expect(ledgerFor().getCommand(a.id)).toMatchObject({ state: "completed", terminalReason: "completed" });
  expect(H.procs).toHaveLength(1); // the cancelled one never spawned
  s.end("killed");
});
