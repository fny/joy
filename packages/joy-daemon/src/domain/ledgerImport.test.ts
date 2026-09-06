// The one-time import of the legacy per-file stores (design §1.4 / §1.6 row
// 5): every store maps onto the ledger, the originals move to imported-v1/,
// and the whole thing is idempotent under a crash mid-import.
import { test, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger } from "./ledger";
import { importLegacyState, listLegacyFiles } from "./ledgerImport";

let dir: string;
const NOW = 1_700_000_000_000;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "ledger-import-")); });
afterEach(() => { vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });

const write = (name: string, doc: unknown) => writeFileSync(join(dir, name), JSON.stringify(doc));
const wire = (text: string) => ({ role: "session", content: { type: "output", data: { turn: "t", ev: { t: "text", text } } } });

function seedLegacyState() {
  write("queue-aaaa0001.json", [
    { id: "q1", text: "first", createdAt: 10, source: "relay", mirrorToRelay: false, seq: 5, visible: false },
    { id: "q2", text: "second", createdAt: 11, source: "rpc", mirrorToRelay: true, visible: true },
  ]);
  write("aaaa0001.receipts.json", {
    inbound: [{ seq: 4, uuid: "u-in", text: "hello", source: "relay", at: 1 }, null, { text: "no uuid" }],
    outbound: [{ uuid: "u-out", turn: "t1", at: 2 }, "junk"],
    received: [{ text: "recent send", at: NOW - 60_000 }, { text: "stale", at: NOW - 3_600_000 }],
  });
  write("v2-outbound.json", [
    { kind: "output", id: "e1", localId: "aaaa0001", v2SessionId: "v2a", turnId: "rt1", wire: wire("with flag"), runtimeEventId: "rec:e1", at: 3, sealed: true, key: "a2V5" },
    { kind: "output", id: "e2", localId: "aaaa0001", v2SessionId: "v2a", turnId: null, wire: wire("pre-flag"), runtimeEventId: "rec:e2", at: 4 },
    { kind: "output", id: "e3", v2SessionId: "v2b", turnId: null, wire: wire("no localId, record knows"), runtimeEventId: "rec:e3", at: 5 },
    { kind: "terminal", id: "t1", v2SessionId: "v2a", localId: "aaaa0001", turnId: "rt1", body: { type: "terminal", terminalState: "completed" }, at: 6 },
  ]);
  write("codex-inbound-bbbb0002.json", [
    { clientId: "codex-in:bbbb0002:9", text: "queued one", state: "queued", at: 7, seq: 9 },
    { clientId: "codex-in:bbbb0002:10", text: "sent, no echo", state: "sentUnknown", at: 8, seq: 10 },
    { clientId: "codex-in:bbbb0002:11", text: "", state: "delivered", at: 9, seq: 11 },
  ]);
  write("codex-checkpoint-bbbb0002.json", { threadId: "TH", deliveredThroughTurnId: "019f-turn-7", knownClientIds: ["codex-in:bbbb0002:1"], seqReceipts: [{ seq: 2, clientId: "codex-in:bbbb0002:2" }] });
  write("v2-spawns.json", { "cmd-1": "aaaa0001", "cmd-2": "cccc0003" });
  write("window-aaaa0001.json", { id: "aaaa0001", launchCwd: "/w", v2SessionId: "v2a", claudeSessionId: "sid", transcriptCheckpoint: { path: "/t.jsonl", offset: 123 }, handoffJob: { role: "source", path: "/n.md", target: { agent: "codex" }, at: 1 }, updatedAt: 1 });
  write("window-cccc0003.json", { id: "cccc0003", launchCwd: "/o", agent: "opencode", v2SessionId: "v2b", opencodeSessionId: "oc", opencodeDeliveredThrough: "msg_9", updatedAt: 1 });
}

function verify(l: Ledger) {
  // queue → commands in array order
  expect(l.listPending("aaaa0001").map((c) => [c.id, c.text, c.seq, c.origin, c.visible])).toEqual([["q1", "first", 5, "relay", false], ["q2", "second", null, "local", true]]);
  // receipts → retained receipts; the echo backstop → a delivered command with an awaiting attempt
  expect(l.hasReceipt("aaaa0001", "transcript_uuid", "u-in")).toBe(true);
  expect(l.hasReceipt("aaaa0001", "seq", "4")).toBe(true);
  expect(l.hasReceipt("aaaa0001", "transcript_uuid", "u-out")).toBe(true);
  expect(l.matchAttemptByRef("aaaa0001", "recent send")?.state).toBe("unknown");
  expect(l.matchAttemptByRef("aaaa0001", "stale")).toBeNull();
  // outbound → outbox rows in order, sealing classified, localId recovered from the record
  const rows = l.pendingOutbound("aaaa0001");
  expect(rows.map((r) => r.runtimeEventId)).toEqual(["rec:e1", "rec:e2", "term:rt1"]);
  expect(rows[0]).toMatchObject({ sealed: true, keyB64: "a2V5", relayTurnId: "rt1", v2SessionId: "v2a" });
  expect(rows[1]).toMatchObject({ sealed: true, keyB64: null }); // pre-flag entry on a sealing daemon
  expect(rows[2]).toMatchObject({ kind: "terminal", relayTurnId: "rt1", body: { terminalState: "completed" } });
  expect(l.pendingOutbound("cccc0003").map((r) => r.runtimeEventId)).toEqual(["rec:e3"]);
  expect(l.hasTerminalFor("rt1")).toBe(true);
  // codex inbound → commands (queued / unknown + attempt) and receipts
  expect(l.getCommand("codex-in:bbbb0002:9")).toMatchObject({ state: "queued", seq: 9 });
  expect(l.getCommand("codex-in:bbbb0002:10")).toMatchObject({ state: "unknown" });
  expect(l.attemptsForCommand("codex-in:bbbb0002:10").map((a) => [a.state, a.runtimeRef])).toEqual([["unknown", "codex-in:bbbb0002:10"]]);
  expect(l.getReceipt("bbbb0002", "seq", "11")?.commandId).toBe("codex-in:bbbb0002:11");
  // codex checkpoint → high-water + receipts
  expect(l.getCheckpoint("bbbb0002", "codex_turn")?.ref).toBe("019f-turn-7");
  expect(l.hasReceipt("bbbb0002", "codex_client", "codex-in:bbbb0002:1")).toBe(true);
  expect(l.getReceipt("bbbb0002", "seq", "2")?.commandId).toBe("codex-in:bbbb0002:2");
  expect(l.acceptCommand({ sessionId: "bbbb0002", text: "x", source: "relay", seq: 2, visible: false, mirrorToRelay: false })).toMatchObject({ deduped: "receipt", id: "codex-in:bbbb0002:2" });
  // spawn intents
  expect(l.lookupSpawnIntent("cmd-1")).toBe("aaaa0001");
  expect(l.lookupSpawnIntent("cmd-2")).toBe("cccc0003");
  // window-record execution fields
  expect(l.getCheckpoint("aaaa0001", "claude_transcript")).toMatchObject({ ref: "/t.jsonl", offset: 123 });
  expect(l.getCheckpoint("cccc0003", "opencode_msg")?.ref).toBe("msg_9");
  expect(l.getJob("aaaa0001")?.payload).toMatchObject({ role: "source", path: "/n.md" });
}

test("imports every legacy store, moves the originals to imported-v1/, strips the record fields, marks the import done", () => {
  seedLegacyState();
  const l = Ledger.open(dir, { now: () => NOW });
  const report = importLegacyState(l, dir, { sealsContent: true, now: () => NOW });
  expect(report.skipped).toBe(false);
  expect(report.failed).toEqual([]);
  expect(report.unmoved).toEqual([]);
  expect(report.files.length).toBe(8); // 6 store files + 2 window records
  verify(l);
  expect(listLegacyFiles(dir)).toEqual([]);
  expect(readdirSync(join(dir, "imported-v1")).sort()).toEqual(["aaaa0001.receipts.json", "codex-checkpoint-bbbb0002.json", "codex-inbound-bbbb0002.json", "queue-aaaa0001.json", "v2-outbound.json", "v2-spawns.json"]);
  const rec = JSON.parse(readFileSync(join(dir, "window-aaaa0001.json"), "utf8"));
  expect(rec.transcriptCheckpoint).toBeUndefined();
  expect(rec.handoffJob).toBeUndefined();
  expect(rec).toMatchObject({ launchCwd: "/w", v2SessionId: "v2a", claudeSessionId: "sid" }); // identity stays
  expect(l.getMeta("import_v1")).toBe("done");
  // Later boots skip the scan entirely.
  expect(importLegacyState(l, dir, { sealsContent: true }).skipped).toBe(true);
  l.close();
});

test("a crash mid-import (rename fails after the second file) re-imports with identical counts; every file ends up moved", () => {
  seedLegacyState();
  const l1 = Ledger.open(dir, { now: () => NOW });
  let renames = 0;
  const rename = fs.renameSync;
  vi.spyOn(fs, "renameSync").mockImplementation((a, b) => { if (++renames > 2) throw new Error("EIO"); return rename(a, b); });
  const first = importLegacyState(l1, dir, { sealsContent: true, now: () => NOW });
  expect(first.unmoved.length).toBeGreaterThan(0);
  expect(l1.getMeta("import_v1")).toBeNull();
  vi.restoreAllMocks();
  const rowCount = () => ({
    commands: l1.db.prepare("SELECT COUNT(*) AS n FROM commands").get(), attempts: l1.db.prepare("SELECT COUNT(*) AS n FROM attempts").get(),
    receipts: l1.db.prepare("SELECT COUNT(*) AS n FROM receipts").get(), outbox: l1.db.prepare("SELECT COUNT(*) AS n FROM outbox").get(),
  });
  const before = rowCount();
  // "crash": drop l1 without close(); the next daemon opens and imports again.
  const l2 = Ledger.open(dir, { now: () => NOW });
  const second = importLegacyState(l2, dir, { sealsContent: true, now: () => NOW });
  expect(second.failed).toEqual([]);
  expect(second.unmoved).toEqual([]);
  expect(rowCount()).toEqual(before); // zero effect on the rows already there
  verify(l2);
  expect(listLegacyFiles(dir)).toEqual([]);
  expect(l2.getMeta("import_v1")).toBe("done");
  l1.close(); l2.close();
});

test("a legacy outbound entry without the sealing flag stays plaintext on a daemon that never sealed", () => {
  write("v2-outbound.json", [{ kind: "output", id: "e", localId: "dddd0004", v2SessionId: "v2p", turnId: null, wire: wire("legacy plain"), runtimeEventId: "rec:legacy", at: 1 }]);
  const l = Ledger.open(dir);
  importLegacyState(l, dir, { sealsContent: false });
  expect(l.pendingOutbound("dddd0004")[0]).toMatchObject({ sealed: false, keyB64: null });
  l.close();
});

test("an unparseable legacy file is a FAILED import: left in place, reported with its session, not done; the rest still imports; a repair imports next boot", () => {
  writeFileSync(join(dir, "queue-eeee0005.json"), "{not json");
  write("queue-ffff0006.json", [{ id: "ok", text: "fine", createdAt: 1, source: "rpc", mirrorToRelay: true, visible: true }]);
  const l = Ledger.open(dir);
  const r = importLegacyState(l, dir, { sealsContent: false });
  expect(l.listPending("ffff0006").map((c) => c.id)).toEqual(["ok"]);
  expect(l.listPending("eeee0005")).toEqual([]);
  expect(r.failed).toEqual([{ file: "queue-eeee0005.json", error: expect.stringMatching(/^malformed: not JSON/), sessionId: "eeee0005" }]);
  expect(r.quarantine).toEqual(["eeee0005"]);
  expect(r.files).not.toContain("queue-eeee0005.json");
  expect(existsSync(join(dir, "queue-eeee0005.json"))).toBe(true);
  expect(existsSync(join(dir, "imported-v1", "queue-eeee0005.json"))).toBe(false);
  expect(l.getImportSource("queue-eeee0005.json")).toBeNull();
  expect(l.getMeta("import_v1")).toBeNull();
  // Repaired by hand: the next boot imports it and the import completes.
  write("queue-eeee0005.json", [{ id: "late", text: "repaired", createdAt: 1, source: "rpc", mirrorToRelay: true, visible: true }]);
  const r2 = importLegacyState(l, dir, { sealsContent: false });
  expect(r2.failed).toEqual([]);
  expect(r2.quarantine).toEqual([]);
  expect(l.listPending("eeee0005").map((c) => c.id)).toEqual(["late"]);
  expect(l.getMeta("import_v1")).toBe("done");
  l.close();
});

test("the review's truncated queue file and a transient read error are failed imports: kept, reported, not done — and a wrong-shape file too", () => {
  writeFileSync(join(dir, "queue-abcdef12.json"), '{"truncated":');
  write("queue-ffff0006.json", [{ id: "ok", text: "fine", createdAt: 1, source: "rpc", mirrorToRelay: true, visible: true }]);
  write("codex-inbound-cccc0003.json", { not: "an array" });
  const real = fs.readFileSync;
  vi.spyOn(fs, "readFileSync").mockImplementation(((p: unknown, ...rest: unknown[]) => {
    if (String(p).endsWith("queue-ffff0006.json")) throw Object.assign(new Error("EIO: i/o error, read"), { code: "EIO" });
    return (real as (...a: unknown[]) => unknown)(p, ...rest);
  }) as typeof fs.readFileSync);
  const l = Ledger.open(dir);
  const r = importLegacyState(l, dir, { sealsContent: false });
  vi.restoreAllMocks();
  expect(r.failed.map((f) => [f.file, f.sessionId])).toEqual([["codex-inbound-cccc0003.json", "cccc0003"], ["queue-abcdef12.json", "abcdef12"], ["queue-ffff0006.json", "ffff0006"]]);
  expect(r.failed[0].error).toMatch(/^malformed: a codex inbound file/);
  expect(r.failed[1].error).toMatch(/^malformed: not JSON/);
  expect(r.failed[2].error).toMatch(/EIO/);
  expect(r.quarantine).toEqual(["cccc0003", "abcdef12", "ffff0006"]);
  expect(l.listPending("abcdef12")).toEqual([]);
  expect(l.listPending("ffff0006")).toEqual([]);
  expect(listLegacyFiles(dir)).toEqual(["codex-inbound-cccc0003.json", "queue-abcdef12.json", "queue-ffff0006.json"]);
  expect(existsSync(join(dir, "imported-v1"))).toBe(false);
  expect(l.getMeta("import_v1")).toBeNull();
  // The transient one imports on the next boot; the others still wait for repair.
  const r2 = importLegacyState(l, dir, { sealsContent: false });
  expect(r2.failed.map((f) => f.file)).toEqual(["codex-inbound-cccc0003.json", "queue-abcdef12.json"]);
  expect(l.listPending("ffff0006").map((c) => c.id)).toEqual(["ok"]);
  expect(l.getMeta("import_v1")).toBeNull();
  l.close();
});

test("a repeated import of a file that could not be moved is a no-op (marker in the ledger, deterministic synthetic ids): one command, one attempt", () => {
  write("abcdef12.receipts.json", { received: [{ text: "same", at: NOW }] });
  const l = Ledger.open(dir, { now: () => NOW });
  vi.spyOn(fs, "renameSync").mockImplementation(() => { throw new Error("EACCES"); });
  const first = importLegacyState(l, dir, { sealsContent: false, now: () => NOW });
  expect(first.unmoved).toEqual(["abcdef12.receipts.json"]);
  expect([first.commands, first.attempts]).toEqual([1, 1]);
  const second = importLegacyState(l, dir, { sealsContent: false, now: () => NOW });
  expect(second.repeated).toEqual(["abcdef12.receipts.json"]);
  expect(second.files).toEqual([]);
  expect([second.commands, second.attempts]).toEqual([0, 0]);
  expect(l.listCommands("abcdef12")).toHaveLength(1);
  expect(l.attemptsAwaiting("abcdef12")).toHaveLength(1);
  expect(l.listCommands("abcdef12")[0].id).toMatch(/^import:abcdef12:received:[0-9a-f]{12}:0$/);
  expect(l.getImportSource("abcdef12.receipts.json")).toMatchObject({ contentHash: expect.stringMatching(/^[0-9a-f]{64}$/), importedAt: NOW });
  expect(l.getMeta("import_v1")).toBeNull(); // still unmoved: not done, but harmless
  vi.restoreAllMocks();
  // "Crash", reopen: the same no-op, and the move now completes.
  const l2 = Ledger.open(dir, { now: () => NOW });
  const third = importLegacyState(l2, dir, { sealsContent: false, now: () => NOW });
  expect(third.repeated).toEqual(["abcdef12.receipts.json"]);
  expect(l2.listCommands("abcdef12")).toHaveLength(1);
  expect(l2.attemptsAwaiting("abcdef12")).toHaveLength(1);
  expect(existsSync(join(dir, "imported-v1", "abcdef12.receipts.json"))).toBe(true);
  expect(l2.getMeta("import_v1")).toBe("done");
  l.close(); l2.close();
});

test("an imported codex checkpoint never moves the ledger's cursor backwards", () => {
  write("codex-checkpoint-abcdef12.json", { deliveredThroughTurnId: "old" });
  const l = Ledger.open(dir);
  vi.spyOn(fs, "renameSync").mockImplementation(() => { throw new Error("EACCES"); });
  importLegacyState(l, dir, { sealsContent: false });
  expect(l.getCheckpoint("abcdef12", "codex_turn")?.ref).toBe("old");
  l.setCheckpoint("abcdef12", "codex_turn", "new", 0); // the ledger advanced while the file stayed
  const again = importLegacyState(l, dir, { sealsContent: false });
  expect(again.repeated).toEqual(["codex-checkpoint-abcdef12.json"]);
  expect(l.getCheckpoint("abcdef12", "codex_turn")?.ref).toBe("new");
  // Even a CHANGED legacy file (no marker match, imported afresh) cannot rewind it.
  write("codex-checkpoint-abcdef12.json", { deliveredThroughTurnId: "older-still", knownClientIds: ["k1"] });
  const changed = importLegacyState(l, dir, { sealsContent: false });
  expect(changed.files).toEqual(["codex-checkpoint-abcdef12.json"]);
  expect(l.getCheckpoint("abcdef12", "codex_turn")?.ref).toBe("new");
  expect(l.hasReceipt("abcdef12", "codex_client", "k1")).toBe(true);
  l.close();
});

test("ENOSPC after seven bytes during the window-record strip leaves the record intact (atomic replacement); the strip completes next boot", () => {
  const file = join(dir, "window-abcdef12.json");
  const original = JSON.stringify({ launchCwd: "/repo", claudeSessionId: "live", transcriptCheckpoint: { path: "/t", offset: 10 } });
  writeFileSync(file, original);
  const real = fs.writeSync;
  vi.spyOn(fs, "writeSync").mockImplementation(((fd: number, buf: Uint8Array, off: number) => {
    (real as (fd: number, b: Uint8Array, o: number, l: number) => number)(fd, buf, off, 7);
    throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
  }) as unknown as typeof fs.writeSync);
  const l = Ledger.open(dir);
  const r = importLegacyState(l, dir, { sealsContent: false });
  vi.restoreAllMocks();
  expect(readFileSync(file, "utf8")).toBe(original);
  expect(r.unmoved).toEqual(["window-abcdef12.json"]);
  expect(r.failed).toEqual([]);
  expect(l.getCheckpoint("abcdef12", "claude_transcript")).toMatchObject({ ref: "/t", offset: 10 });
  expect(l.getMeta("import_v1")).toBeNull();
  expect(readdirSync(dir).filter((n) => n.startsWith(".window-"))).toEqual([]); // no temp left behind
  // Next boot: the strip lands; the (now newer) ledger checkpoint is not overwritten by the stale field.
  l.setCheckpoint("abcdef12", "claude_transcript", "/t", 99);
  const r2 = importLegacyState(l, dir, { sealsContent: false });
  expect(r2.unmoved).toEqual([]);
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ launchCwd: "/repo", claudeSessionId: "live" });
  expect(l.getCheckpoint("abcdef12", "claude_transcript")?.offset).toBe(99);
  expect(l.getMeta("import_v1")).toBe("done");
  l.close();
});

// ── review 7652e686: malformed ROWS / FIELDS fail the source like a malformed envelope ──

test("a queue file whose array holds a malformed entry is a FAILED import: nothing committed (not even the valid sibling), file kept, no marker, session quarantined, not done; a repair imports it", () => {
  write("queue-abcdef12.json", [{ id: "fine", text: "kept together", createdAt: 1, source: "rpc", mirrorToRelay: true, visible: true }, { id: "accepted", text: 77 }]);
  const l = Ledger.open(dir);
  const r = importLegacyState(l, dir, { sealsContent: false });
  expect(r.failed).toEqual([{ file: "queue-abcdef12.json", error: "malformed: queue item 1: text must be a non-empty string", sessionId: "abcdef12" }]);
  expect(r.quarantine).toEqual(["abcdef12"]);
  expect(r.files).toEqual([]);
  expect(l.listCommands("abcdef12")).toEqual([]);
  expect(l.getImportSource("queue-abcdef12.json")).toBeNull();
  expect(existsSync(join(dir, "queue-abcdef12.json"))).toBe(true);
  expect(existsSync(join(dir, "imported-v1"))).toBe(false);
  expect(l.getMeta("import_v1")).toBeNull();
  // Still failed next boot while the file is as it was.
  expect(importLegacyState(l, dir, { sealsContent: false }).quarantine).toEqual(["abcdef12"]);
  // Repaired by hand: both rows import in order, the file moves, the import completes.
  write("queue-abcdef12.json", [{ id: "fine", text: "kept together", createdAt: 1 }, { id: "accepted", text: "77" }]);
  const r2 = importLegacyState(l, dir, { sealsContent: false });
  expect(r2.failed).toEqual([]);
  expect(r2.quarantine).toEqual([]);
  expect(l.listPending("abcdef12").map((c) => [c.id, c.text])).toEqual([["fine", "kept together"], ["accepted", "77"]]);
  expect(existsSync(join(dir, "imported-v1", "queue-abcdef12.json"))).toBe(true);
  expect(l.getMeta("import_v1")).toBe("done");
  l.close();
});

test("every semantically required queue / codex-inbound field is checked: a prompt without text, a non-string clientId, a missing id, a non-numeric seq, a non-object entry", () => {
  const cases: Array<[string, string, unknown, string]> = [
    ["codex-inbound-aaaa0004.json", "aaaa0004", [{ clientId: "c", state: "queued" }], "malformed: codex inbound item 0: text must be a string"],
    ["codex-inbound-aaaa0005.json", "aaaa0005", [{ clientId: "ok", text: "fine", state: "queued" }, { clientId: 5, state: "delivered" }], "malformed: codex inbound item 1: clientId must be a non-empty string"],
    ["queue-aaaa0001.json", "aaaa0001", [{ text: "no id" }], "malformed: queue item 0: id must be a non-empty string"],
    ["queue-aaaa0002.json", "aaaa0002", [{ id: "x", text: "ok", seq: "5" }], "malformed: queue item 0: seq must be a number"],
    ["queue-aaaa0003.json", "aaaa0003", ["junk"], "malformed: queue item 0: not an object"],
  ];
  for (const [name, , doc] of cases) write(name, doc);
  const l = Ledger.open(dir);
  const r = importLegacyState(l, dir, { sealsContent: false });
  expect(r.failed).toEqual(cases.map(([file, sessionId, , error]) => ({ file, error, sessionId })));
  expect(r.quarantine).toEqual(cases.map(([, sessionId]) => sessionId));
  expect(l.db.prepare("SELECT COUNT(*) AS n FROM commands").get()).toEqual({ n: 0 }); // aaaa0005's valid first entry rolled back with its file
  expect(listLegacyFiles(dir)).toEqual(cases.map(([name]) => name));
  expect(l.getMeta("import_v1")).toBeNull();
  l.close();
});

test("a window record whose execution field is malformed (a string offset) is neither imported nor stripped; its session is quarantined until the record is repaired", () => {
  const file = join(dir, "window-abcdef12.json");
  const original = JSON.stringify({ launchCwd: "/repo", transcriptCheckpoint: { path: "/t", offset: "100" } });
  writeFileSync(file, original);
  const l = Ledger.open(dir);
  const r = importLegacyState(l, dir, { sealsContent: false });
  expect(r.failed).toEqual([{ file: "window-abcdef12.json", error: "malformed: transcriptCheckpoint: offset must be a non-negative number", sessionId: "abcdef12" }]);
  expect(r.quarantine).toEqual(["abcdef12"]);
  expect(r.files).toEqual([]);
  expect(readFileSync(file, "utf8")).toBe(original); // not stripped
  expect(l.getCheckpoint("abcdef12", "claude_transcript")).toBeNull();
  expect(l.getMeta("import_v1")).toBeNull();
  // Still quarantined next boot while the record is as it was.
  expect(importLegacyState(l, dir, { sealsContent: false }).quarantine).toEqual(["abcdef12"]);
  expect(readFileSync(file, "utf8")).toBe(original);
  // Repaired: the checkpoint lands, the field is stripped, the import completes.
  writeFileSync(file, JSON.stringify({ launchCwd: "/repo", transcriptCheckpoint: { path: "/t", offset: 100 } }));
  const r2 = importLegacyState(l, dir, { sealsContent: false });
  expect(r2.failed).toEqual([]);
  expect(l.getCheckpoint("abcdef12", "claude_transcript")).toMatchObject({ ref: "/t", offset: 100 });
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ launchCwd: "/repo" });
  expect(l.getMeta("import_v1")).toBe("done");
  l.close();
});

test("a malformed sibling field blocks the whole record (a valid checkpoint next to a handoffJob without a path); a null field is simply absent", () => {
  const file = join(dir, "window-abcdef12.json");
  const original = JSON.stringify({ launchCwd: "/repo", transcriptCheckpoint: { path: "/t", offset: 5 }, handoffJob: { role: "source" } });
  writeFileSync(file, original);
  write("window-abcdef13.json", { launchCwd: "/other", transcriptCheckpoint: null, opencodeDeliveredThrough: "msg_1" });
  const l = Ledger.open(dir);
  const r = importLegacyState(l, dir, { sealsContent: false });
  expect(r.failed).toEqual([{ file: "window-abcdef12.json", error: "malformed: handoffJob: path must be a non-empty string", sessionId: "abcdef12" }]);
  expect(r.quarantine).toEqual(["abcdef12"]);
  expect(readFileSync(file, "utf8")).toBe(original);
  expect(l.getCheckpoint("abcdef12", "claude_transcript")).toBeNull();
  expect(l.getJob("abcdef12")).toBeNull();
  expect(l.getCheckpoint("abcdef13", "opencode_msg")?.ref).toBe("msg_1");
  expect(JSON.parse(readFileSync(join(dir, "window-abcdef13.json"), "utf8"))).toEqual({ launchCwd: "/other" });
  expect(l.getMeta("import_v1")).toBeNull();
  l.close();
});

test("a legacy queue entry whose id another session already owns fails that file's import (quarantined, nothing committed) — the row is never re-homed", () => {
  write("queue-aaaa0001.json", [{ id: "same", text: "mine", createdAt: 1 }]);
  write("queue-bbbb0002.json", [{ id: "fresh", text: "ok", createdAt: 2 }, { id: "same", text: "stolen", createdAt: 3 }]);
  const l = Ledger.open(dir);
  const r = importLegacyState(l, dir, { sealsContent: false });
  expect(r.failed).toEqual([{ file: "queue-bbbb0002.json", error: expect.stringMatching(/^ledger accept failed: same: owned by session aaaa0001, not bbbb0002/), sessionId: "bbbb0002" }]);
  expect(r.quarantine).toEqual(["bbbb0002"]);
  expect(r.files).toEqual(["queue-aaaa0001.json"]);
  expect(l.getCommand("same")).toMatchObject({ sessionId: "aaaa0001", text: "mine" });
  expect(l.listCommands("bbbb0002")).toEqual([]); // "fresh" rolled back with its file
  expect(existsSync(join(dir, "queue-bbbb0002.json"))).toBe(true);
  expect(l.getMeta("import_v1")).toBeNull();
  l.close();
});

