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

test("a corrupt legacy file is skipped (left in place) and the rest still imports", () => {
  writeFileSync(join(dir, "queue-eeee0005.json"), "{not json");
  write("queue-ffff0006.json", [{ id: "ok", text: "fine", createdAt: 1, source: "rpc", mirrorToRelay: true, visible: true }]);
  const l = Ledger.open(dir);
  const r = importLegacyState(l, dir, { sealsContent: false });
  expect(l.listPending("ffff0006").map((c) => c.id)).toEqual(["ok"]);
  expect(l.listPending("eeee0005")).toEqual([]);
  // Unparseable = nothing to import; the file is still moved aside so it stops being scanned.
  expect(existsSync(join(dir, "imported-v1", "queue-eeee0005.json"))).toBe(true);
  expect(r.files).toContain("queue-eeee0005.json");
  l.close();
});
