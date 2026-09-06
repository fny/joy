// #69 — a long-running `opencode serve` prints its listen line and keeps
// logging. The startup listener used to append every later chunk to the parse
// buffer and re-run the listen regex over it, so the daemon retained the
// server's entire log for the life of each session, unbounded.
//
// Dropping the listener is not the fix: nothing would read the pipe, it fills
// at ~64 KiB and the child blocks on write forever. The contract asserted
// here is both halves — the output is still DRAINED, and only a fixed tail is
// kept.
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnOpencodeServer } from "./opencodeClient";
import { BoundedTail } from "../domain/bounded";

let dir: string | null = null;
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = null; });

/** A stand-in `opencode` that announces a port and then floods stderr. */
function fakeServer(body: string): string {
  dir = mkdtempSync(join(tmpdir(), "joy-oc-spawn-"));
  const p = join(dir, "opencode");
  writeFileSync(p, `#!/bin/sh\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
}

describe("spawnOpencodeServer output after startup (#69)", () => {
  it("drains post-startup logging and retains only a bounded tail", async () => {
    // 400 KiB of stderr after the listen line — six times the pipe buffer, so
    // a child that is not being read would block here and never exit.
    const bin = fakeServer([
      'echo "opencode server listening on http://127.0.0.1:45999"',
      'line=$(awk \'BEGIN{ s=""; while (length(s) < 1023) s = s "x"; print s }\')',
      'i=0; while [ $i -lt 400 ]; do echo "$line" >&2; i=$((i+1)); done',
      'echo "goodbye" >&2',
    ].join("\n"));
    const { proc, port, serverLog } = spawnOpencodeServer(dir!, { bin });
    expect(await port).toBe(45999);
    const code = await new Promise<number>((r) => proc.on("exit", (c) => r(c ?? -1)));
    expect(code).toBe(0); // it drained: an unread pipe would have wedged it
    expect(serverLog.byteLength).toBeLessThanOrEqual(serverLog.maxBytes);
    expect(serverLog.droppedBytes).toBeGreaterThan(300 * 1024);
    expect(serverLog.text().endsWith("goodbye\n")).toBe(true);
  }, 30_000);

  it("does not re-run the listen parser on later output", async () => {
    // A second, WRONG listen line after startup must not move the port.
    const bin = fakeServer([
      'echo "opencode server listening on http://127.0.0.1:45001"',
      'sleep 0.2',
      'echo "opencode server listening on http://127.0.0.1:45002" >&2',
    ].join("\n"));
    const { proc, port, serverLog } = spawnOpencodeServer(dir!, { bin });
    expect(await port).toBe(45001);
    await new Promise<void>((r) => proc.on("exit", () => r()));
    expect(serverLog.text()).toContain("45002"); // drained into the tail, not parsed
  }, 30_000);
});

describe("BoundedTail", () => {
  it("keeps the last maxBytes and reports what fell out", () => {
    const t = new BoundedTail(8);
    t.push("abcdefgh");
    expect(t.text()).toBe("abcdefgh");
    expect(t.droppedBytes).toBe(0);
    t.push("ij");
    expect(t.text()).toBe("cdefghij");
    expect(t.droppedBytes).toBe(2);
  });

  it("never emits a replacement character for a trimmed lead byte", () => {
    const t = new BoundedTail(3);
    t.push(Buffer.from("aé", "utf8"));  // 3 bytes: 'a', C3, A9
    t.push(Buffer.from("é", "utf8"));   // 2 more — the window now starts mid-character
    expect(t.text()).toBe("é");
    expect(t.text()).not.toContain("�");
  });

  it("reassembles a character split across chunks", () => {
    const t = new BoundedTail(16);
    const e = Buffer.from("é", "utf8");
    t.push(e.subarray(0, 1));
    t.push(e.subarray(1));
    expect(t.text()).toBe("é");
  });
});
