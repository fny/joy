// pi's inbound queue lives in the ledger (C1) under the session coordinator
// (C2): a prompt is accepted before it is written to pi's stdin, the write is
// an attempt, pi's RPC `response` settles it (#456 — running until pi's
// agent_end completes it), and a restart re-sends whatever pi never
// confirmed — pi's own in-process queue dies with it (#454-adjacent). Same
// fake child as piSession.test.ts; isolated JOY_HOME_DIR.
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
    commands: any[] = [];
    pid = 3000 + H.procs.length;
    exitCode: number | null = null;
    signalCode: string | null = null;
    constructor() {
      super();
      let buf = "";
      this.stdin.on("data", (c: Buffer) => {
        buf += String(c);
        const lines = buf.split("\n"); buf = lines.pop() ?? "";
        for (const l of lines) if (l.trim()) this.commands.push(JSON.parse(l));
      });
    }
    kill() { this.exitCode = 143; this.emit("exit", null); this.stdout.end(); return true; }
  }
  return { ...orig, spawn: vi.fn(() => { const p = new FakeProc(); H.procs.push(p); return p; }) };
});

import { PiSession, type PiInit } from "./piSession";
import { ledgerFor, SessionEndedError } from "../domain/ledger";
import { queueFor } from "../domain/queueFacade";

let home: string;
beforeAll(() => { home = mkdtempSync(join(tmpdir(), "joy-pi-ledger-")); process.env.JOY_HOME_DIR = home; });
afterAll(() => { delete process.env.JOY_HOME_DIR; rmSync(home, { recursive: true, force: true }); });

const line = (o: unknown) => JSON.stringify(o) + "\n";
const relay = () => new Proxy({}, { get: (_t, k) => k === "send" ? (() => {}) : k === "relaySessionId" ? "relay-1" : k === "metadataSnapshot" ? null : (() => Promise.resolve(true)) });
function harness(id: string, init: Partial<PiInit> = {}) {
  const s = new PiSession({ id, cwd: home, status: "starting", startedAt: 0, ...init }, { relayClient: null, broadcast: () => {}, addChatMessage: () => {} });
  s.attachRelay(relay() as any);
  s.beginWatching();
  return { s, p: H.procs.at(-1)! };
}
const prompts = (p: any) => p.commands.filter((c: any) => c.type === "prompt" || c.type === "steer");

test("a prompt is a ledger command before it reaches stdin; pi's response settles it as delivered", async () => {
  H.procs.length = 0;
  const { s, p } = harness("pi-led-1");
  const m = queueFor(s).accept("hello pi", { mirrorToRelay: false });
  await vi.waitFor(() => expect(prompts(p)).toHaveLength(1));
  const ledger = ledgerFor();
  expect(ledger.getCommand(m.id)).toMatchObject({ state: "submitting", text: "hello pi" });
  expect(queueFor(s).itemState(m.id)).toBe("pending");
  const req = prompts(p)[0];
  p.stdout.write(line({ type: "response", id: req.id, command: "prompt", success: true }));
  await vi.waitFor(() => expect(queueFor(s).itemState(m.id)).toBe("delivered"));
  expect(ledger.getCommand(m.id)).toMatchObject({ state: "running" });
  p.stdout.write(line({ type: "agent_end" })); // pi's run settled: the command completes
  await vi.waitFor(() => expect(ledger.getCommand(m.id)).toMatchObject({ state: "completed", terminalReason: "completed" }));
  // A rejected one fails, durably.
  const bad = queueFor(s).accept("nope", { mirrorToRelay: false });
  await vi.waitFor(() => expect(prompts(p)).toHaveLength(2));
  p.stdout.write(line({ type: "response", id: prompts(p)[1].id, command: "prompt", success: false, error: "model refused" }));
  await vi.waitFor(() => expect(queueFor(s).itemState(bad.id)).toBe("failed"));
  s.end("killed");
  expect(() => queueFor(s).accept("late")).toThrow(SessionEndedError);
});

test("a restart re-sends what pi never confirmed, once, and drops nothing", async () => {
  H.procs.length = 0;
  const id = "pi-led-2";
  const gen1 = harness(id);
  const a = queueFor(gen1.s).accept("confirmed", { mirrorToRelay: false });
  const b = queueFor(gen1.s).accept("unconfirmed", { mirrorToRelay: false });
  // One submission awaits pi's answer at a time (R15): b goes out once a is answered.
  await vi.waitFor(() => expect(prompts(gen1.p)).toHaveLength(1));
  gen1.p.stdout.write(line({ type: "response", id: prompts(gen1.p)[0].id, command: "prompt", success: true }));
  await vi.waitFor(() => expect(queueFor(gen1.s).itemState(a.id)).toBe("delivered"));
  await vi.waitFor(() => expect(prompts(gen1.p)).toHaveLength(2));
  // The daemon restarts: the old process is gone with pi's queue; b never got a response.
  gen1.s.end("restart");
  const ledger = ledgerFor();
  expect(ledger.getCommand(b.id)?.state).toBe("unknown");
  const gen2 = harness(id, { piSessionId: "sess-1" });
  await vi.waitFor(() => expect(prompts(gen2.p)).toHaveLength(1));
  expect(prompts(gen2.p)[0].message).toBe("unconfirmed");   // b, not a
  expect(ledger.attemptsForCommand(b.id).map((x) => x.state)).toEqual(["superseded", "submitting"]); // reconciled absent: the old process never answered
  gen2.p.stdout.write(line({ type: "response", id: prompts(gen2.p)[0].id, command: "prompt", success: true }));
  await vi.waitFor(() => expect(queueFor(gen2.s).itemState(b.id)).toBe("delivered"));
  gen2.s.end("killed");
});

test("a prompt accepted before pi is up is sent once pi starts; a queued one can be plucked", async () => {
  H.procs.length = 0;
  const id = "pi-led-3";
  const s = new PiSession({ id, cwd: home, status: "starting", startedAt: 0 }, { relayClient: null, broadcast: () => {}, addChatMessage: () => {} });
  s.attachRelay(relay() as any);
  const early = queueFor(s).accept("before start", { mirrorToRelay: false });
  const plucked = queueFor(s).accept("never", { mirrorToRelay: false });
  expect(queueFor(s).state().pendingCount).toBe(2);
  expect(queueFor(s).cancel(plucked.id)).toBe(true);
  expect(queueFor(s).itemState(plucked.id)).toBe("cancelled");
  s.beginWatching();
  const p = H.procs.at(-1)!;
  await vi.waitFor(() => expect(prompts(p)).toHaveLength(1));
  expect(prompts(p)[0].message).toBe("before start");
  expect(queueFor(s).itemState(early.id)).toBe("pending");
  s.end("killed");
});
