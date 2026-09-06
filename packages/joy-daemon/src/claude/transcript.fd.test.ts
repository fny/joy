// #489: a transcript read whose readSync throws must not leak the descriptor.
// A directory reproduces it without mocking: statSync reports a non-zero size,
// openSync(dir, "r") succeeds on Linux, and readSync fails with EISDIR.
import { test, expect, vi, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readdirSync, statSync, watch } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { tailJsonl } from "./transcript";

const openFds = () => readdirSync("/proc/self/fd").length;
afterEach(() => vi.restoreAllMocks());

test("repeated failing reads leave no descriptors open after close() (#489)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tail-fd-"));
  vi.spyOn(process.stderr, "write").mockImplementation(() => true); // the tailer logs each read failure
  try {
    // Make sure the directory has a non-zero size so the read is attempted.
    for (let i = 0; i < 20; i++) writeFileSync(join(dir, `entry-${i}`), "");
    expect(statSync(dir).size).toBeGreaterThan(0);
    // libuv opens ONE shared inotify descriptor on the first fs.watch of the
    // process and keeps it; take the baseline after that one-off.
    watch(dir, () => {}).close();
    await new Promise((r) => setTimeout(r, 10));

    const before = openFds();
    const reads: unknown[] = [];
    const tailers = Array.from({ length: 6 }, () => tailJsonl(dir, (e) => reads.push(e), () => true, 0, () => {}));
    await new Promise((r) => setTimeout(r, 50));
    for (const t of tailers) t.close();
    await new Promise((r) => setTimeout(r, 20));

    expect(reads).toEqual([]);
    expect(openFds()).toBe(before);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
