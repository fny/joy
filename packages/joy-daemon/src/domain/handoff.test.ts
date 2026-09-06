// #542 — handoff / handback deliver their note prompt with requireDurable and
// keep the job retryable when the spool cannot be persisted. Runs against a
// throwaway JOY_HOME_DIR so window records never touch live daemon state.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let home: string;
const realHome = process.env.JOY_HOME_DIR;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "joy-handoff-")); process.env.JOY_HOME_DIR = home; });
afterEach(() => { vi.restoreAllMocks(); if (realHome === undefined) delete process.env.JOY_HOME_DIR; else process.env.JOY_HOME_DIR = realHome; rmSync(home, { recursive: true, force: true }); });

// Imported lazily so JOY_HOME_DIR is set before any path is resolved.
async function mods() {
  const handoff = await import("./handoff");
  const wr = await import("./windowRecord");
  return { ...handoff, ...wr };
}

interface Fake {
  id: string; cwd: string; status: "active" | "ended"; agentFlavor: "claude" | "codex";
  model?: string; currentModel?: string; summary?: string; transcriptPath?: string;
  enqueued: Array<{ text: string; opts: Record<string, unknown> }>;
  failFirst: number;
  handoff: unknown[];
  enqueue(text: string, opts: Record<string, unknown>): { id: string; text: string; createdAt: number };
  setHandoff(info: unknown): void;
  busy(): boolean;
}
function fake(id: string, failFirst = 0): Fake {
  return {
    id, cwd: "/tmp/w", status: "active", agentFlavor: "claude", enqueued: [], failFirst, handoff: [],
    enqueue(text, opts) {
      this.enqueued.push({ text, opts });
      if (this.failFirst > 0 && opts.requireDurable) { this.failFirst--; throw new Error("queue spool write failed — message not durably staged"); }
      return { id: "q", text, createdAt: 1 };
    },
    setHandoff(info) { this.handoff.push(info); },
    busy: () => false,
  };
}
const registryOf = (...ss: Fake[]) => ({
  get: (id: string) => ss.find((s) => s.id === id) as never,
  list: () => ss as never[],
  create: async () => { throw new Error("not used"); },
});

describe("runHandoffJob delivery (#542)", () => {
  it("passes requireDurable; a transient spool failure is retried and the job then settles", async () => {
    const { runHandoffJob, loadWindowRecord, saveWindowRecord } = await mods();
    const src = fake("aaaa1111"), dst = fake("bbbb2222", 1);
    saveWindowRecord(src.id, { launchCwd: src.cwd });
    const note = join(home, "note.md"); writeFileSync(note, "## Goal\nfinish\n");
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    // Resume at the "dst created, not delivered" phase so awaitNote is skipped.
    await runHandoffJob(registryOf(src, dst), src as never, { agent: "claude" }, note, { role: "source", path: note, target: { agent: "claude" }, dst: dst.id, at: 1 }, { enqueueRetryMs: [5] });
    expect(dst.enqueued).toHaveLength(2); // one failure, one success
    expect(dst.enqueued.every((e) => e.opts.requireDurable === true)).toBe(true);
    expect(dst.enqueued[1].text).toMatch(/picking up work/);
    expect(src.handoff.at(-1)).toMatchObject({ state: "handed_off", peer: dst.id });
    expect(loadWindowRecord(src.id)?.handoffJob).toBeUndefined(); // settled → cleared
  });

  it("persistent spool failure: job is KEPT (retryable on restart), state reads failed, nothing cleared", async () => {
    const { runHandoffJob, loadWindowRecord, saveWindowRecord } = await mods();
    const src = fake("aaaa1112"), dst = fake("bbbb2223", 99);
    saveWindowRecord(src.id, { launchCwd: src.cwd });
    const note = join(home, "note.md"); writeFileSync(note, "## Goal\nfinish\n");
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await runHandoffJob(registryOf(src, dst), src as never, { agent: "claude" }, note, { role: "source", path: note, target: { agent: "claude" }, dst: dst.id, at: 1 }, { enqueueRetryMs: [1, 1] });
    expect(dst.enqueued).toHaveLength(3); // initial + 2 retries
    const rec = loadWindowRecord(src.id);
    expect(rec?.handoffJob).toMatchObject({ role: "source", dst: dst.id, path: note });
    expect(rec?.handoffJob?.delivered).toBeUndefined(); // never advanced past delivery
    expect(src.handoff.at(-1)).toMatchObject({ state: "failed" });
    expect((src.handoff.at(-1) as { error: string }).error).toMatch(/retry on daemon restart/);
  });

  it("a non-durability failure still clears the job (unchanged behaviour)", async () => {
    const { runHandoffJob, loadWindowRecord, saveWindowRecord } = await mods();
    const src = fake("aaaa1113");
    saveWindowRecord(src.id, { launchCwd: src.cwd });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    // dst named in the job but gone from the registry → "was created but is gone".
    await runHandoffJob(registryOf(src), src as never, { agent: "claude" }, join(home, "n.md"), { role: "source", path: join(home, "n.md"), target: { agent: "claude" }, dst: "cccc3333", at: 1 }, { enqueueRetryMs: [] });
    expect(loadWindowRecord(src.id)?.handoffJob).toBeUndefined();
    expect(src.handoff.at(-1)).toMatchObject({ state: "failed" });
  });
});

describe("runHandbackJob delivery (#542)", () => {
  it("handback requires a durable spool and keeps the job when it never lands", async () => {
    const { runHandbackJob, loadWindowRecord, saveWindowRecord } = await mods();
    const src = fake("aaaa1114", 99), tgt = fake("bbbb2224");
    saveWindowRecord(tgt.id, { launchCwd: tgt.cwd });
    mkdirSync(join(home, "sessions", tgt.id), { recursive: true });
    const note = join(home, "sessions", tgt.id, "handoff-back.md");
    writeFileSync(note, "## Goal\ndone\n");
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await runHandbackJob(registryOf(src, tgt), tgt as never, src.id, note, { enqueueRetryMs: [1] });
    expect(src.enqueued.length).toBeGreaterThanOrEqual(2);
    expect(src.enqueued.every((e) => e.opts.requireDurable === true)).toBe(true);
    expect(loadWindowRecord(tgt.id)?.handoffJob).toMatchObject({ role: "target", peer: src.id, path: note });
    expect(tgt.handoff.at(-1)).toMatchObject({ state: "failed" });
  }, 15_000); // awaitNote polls every 2s
});

// #542 residual (Astra): the job record's own write used to be fire-and-forget.
// A refused write must be reported as such — and never as a retry promise.
describe("handoff job persistence is confirmed before dispatch (#542 residual)", () => {
  const eacces = () => Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });

  it("source: the job record cannot be written → nothing dispatched, state says so, NO 'will retry on daemon restart'", async () => {
    const { runHandoffJob, loadWindowRecord, saveWindowRecord } = await mods();
    const src = fake("aaaa1121"), dst = fake("bbbb2231");
    saveWindowRecord(src.id, { launchCwd: src.cwd });
    const note = join(home, "note.md"); writeFileSync(note, "## Goal\nfinish\n");
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    // The state dir refuses every record write from here on (rename is the
    // step the atomic writer lands with).
    const fs = await import("node:fs");
    vi.spyOn(fs.default, "renameSync").mockImplementation(() => { throw eacces(); });
    await runHandoffJob(registryOf(src, dst), src as never, { agent: "claude" }, note, { role: "source", path: note, target: { agent: "claude" }, dst: dst.id, at: 1 }, { enqueueRetryMs: [1] });
    expect(dst.enqueued).toHaveLength(0); // the pickup prompt was never dispatched
    const last = src.handoff.at(-1) as { state: string; error: string };
    expect(last.state).toBe("failed");
    expect(last.error).toMatch(/could not persist the handoff job/);
    expect(last.error).not.toMatch(/will retry on daemon restart/);
    vi.restoreAllMocks();
    expect(loadWindowRecord(src.id)?.handoffJob).toBeUndefined(); // nothing left behind to replay
  });

  it("source: durable enqueue exhausted AND the record is on disk → the retry promise is genuine", async () => {
    const { runHandoffJob, loadWindowRecord, saveWindowRecord } = await mods();
    const src = fake("aaaa1122"), dst = fake("bbbb2232", 99);
    saveWindowRecord(src.id, { launchCwd: src.cwd });
    const note = join(home, "note.md"); writeFileSync(note, "## Goal\nfinish\n");
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await runHandoffJob(registryOf(src, dst), src as never, { agent: "claude" }, note, { role: "source", path: note, target: { agent: "claude" }, dst: dst.id, at: 1 }, { enqueueRetryMs: [1] });
    expect((src.handoff.at(-1) as { error: string }).error).toMatch(/will retry on daemon restart/);
    expect(loadWindowRecord(src.id)?.handoffJob).toMatchObject({ dst: dst.id }); // and the job it promises IS there
  });

  it("handback: the job record cannot be written → fails before waiting for the note, no retry promise", async () => {
    const { runHandbackJob, loadWindowRecord, saveWindowRecord } = await mods();
    const src = fake("aaaa1123"), tgt = fake("bbbb2233");
    saveWindowRecord(tgt.id, { launchCwd: tgt.cwd });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const fs = await import("node:fs");
    vi.spyOn(fs.default, "renameSync").mockImplementation(() => { throw eacces(); });
    const started = Date.now();
    await runHandbackJob(registryOf(src, tgt), tgt as never, src.id, join(home, "never-written.md"), { enqueueRetryMs: [1] });
    expect(Date.now() - started).toBeLessThan(1500); // did not sit in awaitNote's 2s poll
    expect(src.enqueued).toHaveLength(0);
    const last = tgt.handoff.at(-1) as { state: string; error: string };
    expect(last.state).toBe("failed");
    expect(last.error).toMatch(/could not persist the handoff job/);
    expect(last.error).not.toMatch(/will retry on daemon restart/);
    vi.restoreAllMocks();
    expect(loadWindowRecord(tgt.id)?.handoffJob).toBeUndefined();
  });
});
