// The inbound spool goes through writeFileAtomic (Wave B adoption): a failed
// save returns false AND leaves the previous spool intact, with no .tmp beside it.
import { test, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import { mkdtempSync, rmSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { saveCodexInbound, loadCodexInbound, clearCodexInbound, type CodexInboundItem } from "./codexInboundStore";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "codex-inbound-")); });
afterEach(() => { vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });

const item = (n: number): CodexInboundItem => ({ clientId: `c${n}`, text: `msg ${n}`, state: "queued", at: n, seq: n });

test("save/load round-trip; missing file loads as empty", () => {
  expect(loadCodexInbound("s1", dir)).toEqual([]);
  expect(saveCodexInbound("s1", [item(1), item(2)], dir)).toBe(true);
  expect(loadCodexInbound("s1", dir)).toEqual([item(1), item(2)]);
  clearCodexInbound("s1", dir);
  expect(loadCodexInbound("s1", dir)).toEqual([]);
});

test("a failed write returns false and the previously acknowledged spool survives", () => {
  expect(saveCodexInbound("s1", [item(1)], dir)).toBe(true);
  vi.spyOn(fs, "writeSync").mockImplementation(() => { throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" }); });
  const errs = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  expect(saveCodexInbound("s1", [item(1), item(2)], dir)).toBe(false);
  expect(errs).toHaveBeenCalled();
  vi.restoreAllMocks();
  expect(loadCodexInbound("s1", dir)).toEqual([item(1)]);
  expect(readdirSync(dir).filter((f) => f.startsWith(".") || f.endsWith(".tmp"))).toEqual([]);
});

test("the store creates its directory on first save", () => {
  const nested = join(dir, "a", "b");
  expect(existsSync(nested)).toBe(false);
  expect(saveCodexInbound("s2", [item(1)], nested)).toBe(true);
  expect(loadCodexInbound("s2", nested)).toEqual([item(1)]);
});
