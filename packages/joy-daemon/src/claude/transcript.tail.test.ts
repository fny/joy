// tailJsonl under the file events Claude Code (and the tools around it) can
// produce beyond a plain append: a read that lands mid-character (#38), an
// in-place truncate/rewrite (#487), and an atomic replace of the path (#488).
// Every case is driven through the real fs.watch + poll path — no mocks.
import { test, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { tailJsonl, type TranscriptTailer } from "./transcript";

const dirs: string[] = [];
const tailers: TranscriptTailer[] = [];
afterEach(() => {
  for (const t of tailers.splice(0)) t.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), "tail-test-"));
  dirs.push(d);
  return d;
}

function tail(path: string, sink: unknown[], startOffset = 0): TranscriptTailer {
  const t = tailJsonl(path, (e) => sink.push(e), () => true, startOffset, () => {});
  tailers.push(t);
  return t;
}

/** Poll until `cond()` holds or `ms` elapse (a watch event is asynchronous). */
async function until(cond: () => boolean, ms = 3500): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
}

const line = (o: Record<string, unknown>) => JSON.stringify(o) + "\n";

test("a read that ends inside a multi-byte character reassembles the line byte-exact and checkpoints on the byte offset (#38)", async () => {
  const dir = scratch();
  const p = join(dir, "t.jsonl");
  const full = Buffer.from(line({ type: "assistant", text: "日本語 — box ┌─┐" }));
  // Cut inside the 3-byte encoding of 日 (E6 97 A5): the first read sees a
  // dangling lead byte, the second read brings the continuation byte.
  const cut = Buffer.byteLength('{"type":"assistant","text":"') + 2;
  writeFileSync(p, full.subarray(0, cut));

  const got: Array<Record<string, unknown>> = [];
  const t = tail(p, got); // the initial read consumes the partial line synchronously
  appendFileSync(p, full.subarray(cut));
  await until(() => got.length === 1);

  expect(got).toHaveLength(1);
  expect(got[0].text).toBe("日本語 — box ┌─┐"); // no U+FFFD from decoding the halves separately
  expect(t.offset()).toBe(statSync(p).size); // not thrown off by 3-byte replacement chars
});

test("a truncated/rewritten transcript is re-read from its new start instead of waiting to outgrow the old offset (#487)", async () => {
  const dir = scratch();
  const p = join(dir, "t.jsonl");
  const filler = "x".repeat(900);
  writeFileSync(p, line({ n: 1, filler }) + line({ n: 2 }));
  const got: Array<Record<string, unknown>> = [];
  const t = tail(p, got);
  await until(() => got.length === 2);
  expect(t.offset()).toBe(statSync(p).size);

  // Rewrite in place: far smaller than the old offset, two complete entries.
  writeFileSync(p, line({ n: 3 }) + line({ n: 4 }));
  await until(() => got.length === 4);
  expect(got.map((e) => e.n)).toEqual([1, 2, 3, 4]);
  expect(t.offset()).toBe(statSync(p).size);
});

test("a checkpoint beyond the current end (file rewritten while the daemon was down) restarts from byte 0 (#487)", async () => {
  const dir = scratch();
  const p = join(dir, "t.jsonl");
  writeFileSync(p, line({ n: 1 }) + line({ n: 2 }));
  const got: Array<Record<string, unknown>> = [];
  const t = tail(p, got, 5000);
  await until(() => got.length === 2);
  expect(got.map((e) => e.n)).toEqual([1, 2]);
  expect(t.offset()).toBe(statSync(p).size);
});

test("an atomic replace of the path (write sibling + rename) reattaches to the new file and keeps tailing it (#488)", async () => {
  const dir = scratch();
  const p = join(dir, "t.jsonl");
  writeFileSync(p, line({ n: 1, filler: "y".repeat(300) }) + line({ n: 2 }));
  const got: Array<Record<string, unknown>> = [];
  const t = tail(p, got);
  await until(() => got.length === 2);

  // The replacement is SMALLER than the old offset, so a stale offset alone
  // can never "catch up" — only a reattach delivers what follows.
  const tmp = join(dir, "t.jsonl.tmp");
  writeFileSync(tmp, line({ n: 3 }));
  renameSync(tmp, p);
  await until(() => got.length === 3);
  expect(got.map((e) => e.n)).toEqual([1, 2, 3]);

  // The watcher must now be on the NEW inode: a plain append is delivered.
  appendFileSync(p, line({ n: 4 }));
  await until(() => got.length === 4);
  expect(got.map((e) => e.n)).toEqual([1, 2, 3, 4]);
  expect(t.offset()).toBe(statSync(p).size);
});
