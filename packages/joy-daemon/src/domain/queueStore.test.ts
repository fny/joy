// #555 — a failed queue update must not destroy previously acknowledged
// prompts. The spool holds every prompt the daemon already acked to the relay;
// the old truncating write replaced them with partial JSON on ENOSPC.
import { test, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import { mkdtempSync, rmSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { saveQueue, loadQueue, clearQueue, type PersistedQueueItem } from "./queueStore";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "queue-store-")); });
afterEach(() => { vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });

const item = (id: string, seq: number): PersistedQueueItem => ({ id, text: `prompt ${id}`, createdAt: seq, source: "relay", mirrorToRelay: false, seq, visible: false });
const enospc = () => Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });

test("save → load round-trips; empty save removes the spool", () => {
  expect(saveQueue("s1", [item("a", 1), item("b", 2)], dir)).toBe(true);
  expect(loadQueue("s1", dir).map((i) => i.id)).toEqual(["a", "b"]);
  expect(saveQueue("s1", [], dir)).toBe(true);
  expect(existsSync(join(dir, "queue-s1.json"))).toBe(false);
});

test("ENOSPC while adding a third prompt: returns false, the two acknowledged prompts are still on disk (#555)", () => {
  expect(saveQueue("s1", [item("a", 1), item("b", 2)], dir)).toBe(true);
  vi.spyOn(fs, "writeSync").mockImplementation(() => { throw enospc(); });
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  expect(saveQueue("s1", [item("a", 1), item("b", 2), item("c", 3)], dir)).toBe(false);
  // The message says the previous spool was verified intact.
  expect(String(stderr.mock.calls[0]?.[0])).toMatch(/previous spool intact/);
  vi.restoreAllMocks();
  // A restart would load exactly the acknowledged prompts, not [].
  expect(loadQueue("s1", dir).map((i) => i.id)).toEqual(["a", "b"]);
  expect(readdirSync(dir).filter((f) => f.startsWith("."))).toEqual([]); // no temp leftovers
});

test("rename failure is the same story: previous spool untouched", () => {
  saveQueue("s2", [item("a", 1)], dir);
  vi.spyOn(fs, "renameSync").mockImplementation(() => { throw enospc(); });
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  expect(saveQueue("s2", [item("a", 1), item("b", 2)], dir)).toBe(false);
  vi.restoreAllMocks();
  expect(loadQueue("s2", dir).map((i) => i.id)).toEqual(["a"]);
});

test("a missing base dir is created by the save", () => {
  const nested = join(dir, "no", "such", "dir");
  expect(saveQueue("s3", [item("a", 1)], nested)).toBe(true);
  expect(loadQueue("s3", nested)).toHaveLength(1);
  clearQueue("s3", nested);
  expect(loadQueue("s3", nested)).toEqual([]);
});
