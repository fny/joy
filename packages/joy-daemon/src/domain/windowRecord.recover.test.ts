// #563 — recovery must never bind a fresh Claude session to an unrelated old
// transcript. resolveRecoveredTranscript is the pure decision recover() uses.
import { test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveRecoveredTranscript } from "./windowRecord";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "recover-bind-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const OLD = "11111111-aaaa-4bbb-8ccc-000000000001";
const FRESH = "22222222-aaaa-4bbb-8ccc-000000000002";
const none = new Set<string>();

test("record with the pinned fresh id, transcript not written yet → pinned + pending, NOT the old project file (#563)", () => {
  writeFileSync(join(dir, `${OLD}.jsonl`), "{}\n"); // the unrelated older conversation
  const r = resolveRecoveredTranscript({ claudeSessionId: FRESH }, dir, none, () => join(dir, `${OLD}.jsonl`));
  expect(r).toEqual({ transcriptPath: join(dir, `${FRESH}.jsonl`), claudeSessionId: FRESH, pending: true });
});

test("record with the fresh id whose transcript now exists → bound, not pending", () => {
  writeFileSync(join(dir, `${FRESH}.jsonl`), "{}\n");
  const r = resolveRecoveredTranscript({ claudeSessionId: FRESH }, dir, none, () => null);
  expect(r).toEqual({ transcriptPath: join(dir, `${FRESH}.jsonl`), claudeSessionId: FRESH, pending: false });
});

test("record without any identity → unbound; the newest-mtime heuristic is never consulted", () => {
  let consulted = false;
  const r = resolveRecoveredTranscript({}, dir, none, () => { consulted = true; return join(dir, `${OLD}.jsonl`); });
  expect(r).toEqual({ pending: false });
  expect(consulted).toBe(false);
});

test("checkpoint path wins over the record id when it exists (what the last daemon actually tailed)", () => {
  const ck = join(dir, `${OLD}.jsonl`);
  writeFileSync(ck, "{}\n");
  const r = resolveRecoveredTranscript({ claudeSessionId: FRESH, transcriptCheckpoint: { path: ck, offset: 10 } }, dir, none, () => null);
  expect(r).toEqual({ transcriptPath: ck, claudeSessionId: OLD, pending: false });
  // A checkpoint whose file is gone falls back to the id.
  rmSync(ck);
  expect(resolveRecoveredTranscript({ claudeSessionId: FRESH, transcriptCheckpoint: { path: ck, offset: 10 } }, dir, none, () => null))
    .toEqual({ transcriptPath: join(dir, `${FRESH}.jsonl`), claudeSessionId: FRESH, pending: true });
});

test("a transcript another recovered session already tails is not bound twice", () => {
  const p = join(dir, `${FRESH}.jsonl`);
  writeFileSync(p, "{}\n");
  expect(resolveRecoveredTranscript({ claudeSessionId: FRESH }, dir, new Set([p]), () => null)).toEqual({ pending: false });
});

test("no record at all (pre-record window) → the newest unclaimed transcript, or unbound", () => {
  const old = join(dir, `${OLD}.jsonl`);
  writeFileSync(old, "{}\n");
  expect(resolveRecoveredTranscript(null, dir, none, () => old)).toEqual({ transcriptPath: old, claudeSessionId: OLD, pending: false });
  expect(resolveRecoveredTranscript(null, dir, new Set([old]), () => old)).toEqual({ pending: false });
  expect(resolveRecoveredTranscript(null, dir, none, () => null)).toEqual({ pending: false });
});
