// #557 (failed receipt writes must stay retryable) and #559 (malformed rows
// must be skipped, not thrown, at load).
import { test, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initDeliveryState, loadReceipts, recordOutboundReceipt, recordInboundReceipt, flushReceipts, pendingReceiptSaves, receiptPath } from "./receipts";

let dir: string;
const RID = "rs-durable-0001";
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "receipts-durable-")); });
afterEach(() => { vi.restoreAllMocks(); flushReceipts(); rmSync(dir, { recursive: true, force: true }); });

const eio = () => Object.assign(new Error("EIO: i/o error"), { code: "EIO" });

// #557 — the reported sequence: a transient rename failure, then the SAME
// receipt is recorded again (forwardedUuids makes that an early return), then
// a flush. The receipt must be on disk afterwards.
test("a failed receipt write stays pending and lands on the next flush (#557)", () => {
  const state = initDeliveryState(RID, dir);
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  const rename = vi.spyOn(fs, "renameSync").mockImplementation(() => { throw eio(); });
  recordOutboundReceipt(state, RID, { uuid: "u-1", turn: "t1", at: 1 }, dir);
  expect(loadReceipts(RID, dir).outbound).toEqual([]); // not written
  expect(pendingReceiptSaves()).toBe(1);                // ...but not forgotten
  expect(stderr).toHaveBeenCalled();
  // Recording it again is the documented early return — must not matter.
  recordOutboundReceipt(state, RID, { uuid: "u-1", turn: "t1", at: 1 }, dir);
  expect(state.receipts.outbound).toHaveLength(1);
  rename.mockRestore();
  // Filesystem recovered: the retained dirty log is written by the flush.
  expect(flushReceipts()).toBe(0);
  expect(loadReceipts(RID, dir).outbound).toEqual([{ uuid: "u-1", turn: "t1", at: 1 }]);
  // A restart now knows the uuid and will not forward it again.
  expect(initDeliveryState(RID, dir).forwardedUuids.has("u-1")).toBe(true);
});

test("a failed flush keeps the entry pending (never removed before a successful replacement)", () => {
  const state = initDeliveryState(RID, dir);
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  const rename = vi.spyOn(fs, "renameSync").mockImplementation(() => { throw eio(); });
  recordInboundReceipt(state, RID, { uuid: "in-1", text: "hi", source: "relay", at: 5 }, dir);
  expect(flushReceipts()).toBe(1); // still dirty after a failed flush
  expect(flushReceipts()).toBe(1);
  rename.mockRestore();
  expect(flushReceipts()).toBe(0);
  expect(loadReceipts(RID, dir).inbound.map((r) => r.uuid)).toEqual(["in-1"]);
});

test("a failed write never leaves a torn receipts file behind", () => {
  const state = initDeliveryState(RID, dir);
  recordOutboundReceipt(state, RID, { uuid: "good", turn: "t", at: 1 }, dir);
  const before = readFileSync(receiptPath(RID, dir), "utf-8");
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  vi.spyOn(fs, "writeSync").mockImplementation(() => { throw eio(); });
  recordOutboundReceipt(state, RID, { uuid: "next", turn: "t", at: 2 }, dir);
  expect(readFileSync(receiptPath(RID, dir), "utf-8")).toBe(before);
});

// #559 — rows that parse as JSON but are not receipts.
test("malformed rows are skipped at load; the good rows and recovery survive (#559)", () => {
  writeFileSync(receiptPath(RID, dir), JSON.stringify({
    inbound: [null, 7, { text: "no uuid" }, { uuid: "in-ok", text: "x", source: "relay", at: 1 }],
    outbound: [null, { uuid: "good", turn: "t", at: 1 }, { turn: "no-uuid" }, "str"],
    received: [{ text: "hello", at: 5 }, { text: "no at" }, { at: 3 }, null],
  }));
  const log = loadReceipts(RID, dir);
  expect(log.inbound.map((r) => r.uuid)).toEqual(["in-ok"]);
  expect(log.outbound.map((r) => r.uuid)).toEqual(["good"]);
  expect(log.received).toEqual([{ text: "hello", at: 5 }]);
  // The reported crash site: initDeliveryState dereferenced the null row.
  const state = initDeliveryState(RID, dir);
  expect([...state.forwardedUuids].sort()).toEqual(["good", "in-ok"]);
});

test("a non-object document (array / scalar) loads as empty, not a throw", () => {
  writeFileSync(receiptPath(RID, dir), "[1,2,3]");
  expect(loadReceipts(RID, dir)).toEqual({ inbound: [], outbound: [], received: [] });
  writeFileSync(receiptPath(RID, dir), "null");
  expect(loadReceipts(RID, dir)).toEqual({ inbound: [], outbound: [], received: [] });
});
