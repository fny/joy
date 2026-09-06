// #542 — handoff / handback deliver their note prompt durably (enqueue commits
// to the ledger or throws) and keep the job retryable when the commit keeps
// failing. Runs against a throwaway JOY_HOME_DIR so window records never
// touch live daemon state.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { LedgerWriteError, closeAllLedgers } from "./ledger";
import { SessionCoordinator, resetCoordinators } from "./coordinator";
import { fakeCoordinatedSession } from "./coordinator.fakeDriver";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let home: string;
const realHome = process.env.JOY_HOME_DIR;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "joy-handoff-")); process.env.JOY_HOME_DIR = home; closeAllLedgers(); resetCoordinators(); fakes.clear(); acceptSpy = null; });
afterEach(() => { vi.restoreAllMocks(); acceptSpy = null; closeAllLedgers(); resetCoordinators(); if (realHome === undefined) delete process.env.JOY_HOME_DIR; else process.env.JOY_HOME_DIR = realHome; rmSync(home, { recursive: true, force: true }); });

// Imported lazily so JOY_HOME_DIR is set before any path is resolved.
async function mods() {
  const handoff = await import("./handoff");
  const wr = await import("./windowRecord");
  const { ledgerFor } = await import("./ledger");
  // The job lives in the ledger now; read it back the way resumeHandoffJobs does.
  const loadJob = (id: string) => handoff.loadHandoffJob(id) ?? undefined;
  return { ...handoff, ...wr, loadJob, ledgerFor };
}

interface Fake {
  id: string; cwd: string; status: string; agentFlavor: string;
  model?: string; currentModel?: string; summary?: string; transcriptPath?: string;
  /** Every accept the coordinator was asked for (the durable enqueue). */
  enqueued: Array<{ text: string; opts: Record<string, unknown> }>;
  failFirst: number;
  handoff: unknown[];
  setHandoff(info: unknown): void;
  busy(): boolean;
}
const fakes = new Map<string, Fake>();
let acceptSpy: unknown = null;
/** A coordinator-driven fake session whose first `failFirst` accepts are
 *  refused the way a full disk refuses the ledger commit. */
function fake(id: string, failFirst = 0): Fake {
  const { s } = fakeCoordinatedSession(id, { agent: "claude", cwd: "/tmp/w" });
  const f = s as unknown as Fake;
  f.enqueued = []; f.failFirst = failFirst; f.handoff = [];
  f.setHandoff = (info: unknown) => { f.handoff.push(info); };
  fakes.set(id, f);
  if (!acceptSpy) {
    const real = SessionCoordinator.prototype.accept;
    acceptSpy = vi.spyOn(SessionCoordinator.prototype, "accept").mockImplementation(function (this: SessionCoordinator, input) {
      const target = fakes.get(input.sessionId);
      if (target) {
        target.enqueued.push({ text: input.text, opts: input as unknown as Record<string, unknown> });
        if (target.failFirst > 0) { target.failFirst--; throw new LedgerWriteError("accept", new Error("SQLITE_FULL: database or disk is full")); }
      }
      return real.call(this, input);
    });
  }
  return f;
}
const registryOf = (...ss: Fake[]) => ({
  get: (id: string) => ss.find((s) => s.id === id) as never,
  list: () => ss as never[],
  create: async () => { throw new Error("not used"); },
});

describe("runHandoffJob delivery (#542)", () => {
  it("a transient ledger commit failure is retried and the job then settles", async () => {
    const { runHandoffJob, loadJob, saveWindowRecord, ledgerFor } = await mods();
    const src = fake("aaaa1111"), dst = fake("bbbb2222", 1);
    saveWindowRecord(src.id, { launchCwd: src.cwd });
    const note = join(home, "note.md"); writeFileSync(note, "## Goal\nfinish\n");
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    // Resume at the "dst created, not delivered" phase so awaitNote is skipped.
    await runHandoffJob(registryOf(src, dst), src as never, { agent: "claude" }, note, { role: "source", path: note, target: { agent: "claude" }, dst: dst.id, at: 1 }, { enqueueRetryMs: [5] });
    expect(dst.enqueued).toHaveLength(2); // one failure, one success
    expect(dst.enqueued[1].text).toMatch(/picking up work/);
    expect(src.handoff.at(-1)).toMatchObject({ state: "handed_off", peer: dst.id });
    expect(loadJob(src.id)).toBeUndefined(); // settled → cleared
  });

  it("persistent spool failure: job is KEPT (retryable on restart), state reads failed, nothing cleared", async () => {
    const { runHandoffJob, loadJob, saveWindowRecord, ledgerFor } = await mods();
    const src = fake("aaaa1112"), dst = fake("bbbb2223", 99);
    saveWindowRecord(src.id, { launchCwd: src.cwd });
    const note = join(home, "note.md"); writeFileSync(note, "## Goal\nfinish\n");
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await runHandoffJob(registryOf(src, dst), src as never, { agent: "claude" }, note, { role: "source", path: note, target: { agent: "claude" }, dst: dst.id, at: 1 }, { enqueueRetryMs: [1, 1] });
    expect(dst.enqueued).toHaveLength(3); // initial + 2 retries
    const rec = loadJob(src.id);
    expect(rec).toMatchObject({ role: "source", dst: dst.id, path: note });
    expect(rec?.delivered).toBeUndefined(); // never advanced past delivery
    expect(src.handoff.at(-1)).toMatchObject({ state: "failed" });
    expect((src.handoff.at(-1) as { error: string }).error).toMatch(/retry on daemon restart/);
  });

  it("a non-durability failure still clears the job (unchanged behaviour)", async () => {
    const { runHandoffJob, loadJob, saveWindowRecord, ledgerFor } = await mods();
    const src = fake("aaaa1113");
    saveWindowRecord(src.id, { launchCwd: src.cwd });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    // dst named in the job but gone from the registry → "was created but is gone".
    await runHandoffJob(registryOf(src), src as never, { agent: "claude" }, join(home, "n.md"), { role: "source", path: join(home, "n.md"), target: { agent: "claude" }, dst: "cccc3333", at: 1 }, { enqueueRetryMs: [] });
    expect(loadJob(src.id)).toBeUndefined();
    expect(src.handoff.at(-1)).toMatchObject({ state: "failed" });
  });
});

describe("runHandbackJob delivery (#542)", () => {
  it("handback requires a durable spool and keeps the job when it never lands", async () => {
    const { runHandbackJob, loadJob, saveWindowRecord, ledgerFor } = await mods();
    const src = fake("aaaa1114", 99), tgt = fake("bbbb2224");
    saveWindowRecord(tgt.id, { launchCwd: tgt.cwd });
    mkdirSync(join(home, "sessions", tgt.id), { recursive: true });
    const note = join(home, "sessions", tgt.id, "handoff-back.md");
    writeFileSync(note, "## Goal\ndone\n");
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await runHandbackJob(registryOf(src, tgt), tgt as never, src.id, note, { enqueueRetryMs: [1] });
    expect(src.enqueued.length).toBeGreaterThanOrEqual(2);
    expect(loadJob(tgt.id)).toMatchObject({ role: "target", peer: src.id, path: note });
    expect(tgt.handoff.at(-1)).toMatchObject({ state: "failed" });
  }, 15_000); // awaitNote polls every 2s
});

// #542 residual (Astra): the job record's own write used to be fire-and-forget.
// A refused write must be reported as such — and never as a retry promise.
describe("handoff job persistence is confirmed before dispatch (#542 residual)", () => {
  const eacces = () => Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });

  it("source: the job record cannot be written → nothing dispatched, state says so, NO 'will retry on daemon restart'", async () => {
    const { runHandoffJob, loadJob, saveWindowRecord, ledgerFor } = await mods();
    const src = fake("aaaa1121"), dst = fake("bbbb2231");
    saveWindowRecord(src.id, { launchCwd: src.cwd });
    const note = join(home, "note.md"); writeFileSync(note, "## Goal\nfinish\n");
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    // The ledger refuses every commit from here on.
    const exec = ledgerFor().db.exec.bind(ledgerFor().db);
    vi.spyOn(ledgerFor().db, "exec").mockImplementation((sql: string) => { if (sql === "COMMIT") throw eacces(); return exec(sql); });
    await runHandoffJob(registryOf(src, dst), src as never, { agent: "claude" }, note, { role: "source", path: note, target: { agent: "claude" }, dst: dst.id, at: 1 }, { enqueueRetryMs: [1] });
    expect(dst.enqueued).toHaveLength(0); // the pickup prompt was never dispatched
    const last = src.handoff.at(-1) as { state: string; error: string };
    expect(last.state).toBe("failed");
    expect(last.error).toMatch(/could not persist the handoff job/);
    expect(last.error).not.toMatch(/will retry on daemon restart/);
    vi.restoreAllMocks();
    expect(loadJob(src.id)).toBeUndefined(); // nothing left behind to replay
  });

  it("source: durable enqueue exhausted AND the record is on disk → the retry promise is genuine", async () => {
    const { runHandoffJob, loadJob, saveWindowRecord, ledgerFor } = await mods();
    const src = fake("aaaa1122"), dst = fake("bbbb2232", 99);
    saveWindowRecord(src.id, { launchCwd: src.cwd });
    const note = join(home, "note.md"); writeFileSync(note, "## Goal\nfinish\n");
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await runHandoffJob(registryOf(src, dst), src as never, { agent: "claude" }, note, { role: "source", path: note, target: { agent: "claude" }, dst: dst.id, at: 1 }, { enqueueRetryMs: [1] });
    expect((src.handoff.at(-1) as { error: string }).error).toMatch(/will retry on daemon restart/);
    expect(loadJob(src.id)).toMatchObject({ dst: dst.id }); // and the job it promises IS there
  });

  it("handback: the job record cannot be written → fails before waiting for the note, no retry promise", async () => {
    const { runHandbackJob, loadJob, saveWindowRecord, ledgerFor } = await mods();
    const src = fake("aaaa1123"), tgt = fake("bbbb2233");
    saveWindowRecord(tgt.id, { launchCwd: tgt.cwd });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const exec = ledgerFor().db.exec.bind(ledgerFor().db);
    vi.spyOn(ledgerFor().db, "exec").mockImplementation((sql: string) => { if (sql === "COMMIT") throw eacces(); return exec(sql); });
    const started = Date.now();
    await runHandbackJob(registryOf(src, tgt), tgt as never, src.id, join(home, "never-written.md"), { enqueueRetryMs: [1] });
    expect(Date.now() - started).toBeLessThan(1500); // did not sit in awaitNote's 2s poll
    expect(src.enqueued).toHaveLength(0);
    const last = tgt.handoff.at(-1) as { state: string; error: string };
    expect(last.state).toBe("failed");
    expect(last.error).toMatch(/could not persist the handoff job/);
    expect(last.error).not.toMatch(/will retry on daemon restart/);
    vi.restoreAllMocks();
    expect(loadJob(tgt.id)).toBeUndefined();
  });
});
