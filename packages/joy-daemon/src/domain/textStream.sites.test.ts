// The chunk-safe decoding family at its sites (#540 #548): a real child
// process and a real file, each splitting a multibyte character exactly where
// the old per-chunk decoding turned it into replacement characters.
import { test, expect, describe } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runTool } from "./fileOps";
import { readLastLogMessages } from "./operations";

describe("fileOps.runTool (#540)", () => {
  test("a euro sign split across two stdout chunks — and two stderr chunks — decodes whole", async () => {
    // The child writes E2 82, waits so the pipe delivers it as its own chunk,
    // then AC 0A. Both streams.
    const script = `
      const a = Buffer.from([0xe2, 0x82]), b = Buffer.from([0xac, 0x0a]);
      process.stdout.write(Buffer.concat([Buffer.from("out:"), a]));
      process.stderr.write(Buffer.concat([Buffer.from("err:"), a]));
      setTimeout(() => { process.stdout.write(b); process.stderr.write(b); }, 80);
    `;
    const r = await runTool(process.execPath, ["-e", script]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("out:€\n");
    expect(r.stderr).toBe("err:€\n");
  });
});

describe("operations.readLastLogMessages (#548)", () => {
  test("a character straddling the backward-read chunk boundary is intact in the returned text", () => {
    const dir = mkdtempSync(join(tmpdir(), "log-read-"));
    try {
      const file = join(dir, "t.jsonl");
      const line = (role: string, text: string) => JSON.stringify({ type: role, message: { content: text }, timestamp: "2026-09-06T00:00:00Z" });
      // Build the file so that a small chunk size lands a boundary INSIDE the €
      // of the last assistant message. Pad so total length is controllable.
      const tail = line("assistant", "abc€def");
      const head = line("user", "hello") + "\n";
      const CHUNK = 16;
      // Find the byte offset of € (E2 82 AC) inside the tail, from the END.
      const tailBytes = Buffer.from(tail, "utf8");
      const euroAt = tailBytes.indexOf(Buffer.from("€", "utf8"));
      const bytesAfterEuroLead = tailBytes.length - euroAt - 1; // bytes after E2
      // Pad head so the first chunk (CHUNK bytes from EOF) ends one byte into €.
      // Backward reads start at EOF: chunk 1 = last CHUNK bytes. We want E2 to
      // be the first byte of chunk 2, i.e. CHUNK == bytesAfterEuroLead + 1 (the
      // trailing "\n"). Adjust by rewriting the tail padding instead.
      const pad = "x".repeat(Math.max(0, CHUNK - 1 - bytesAfterEuroLead));
      const tailPadded = line("assistant", "abc€def" + pad);
      const tb = Buffer.from(tailPadded, "utf8");
      const lead = tb.indexOf(Buffer.from("€", "utf8"));
      const afterLead = tb.length - lead - 1 + 1; // + "\n"
      expect(afterLead).toBeGreaterThan(0);
      writeFileSync(file, head + tailPadded + "\n");
      // Use the chunk size that puts a boundary right after the lead byte.
      const msgs = readLastLogMessages(file, 2, afterLead);
      expect(msgs.map((m) => m.text)).toEqual(["hello", "abc€def" + pad]);
      // And every other small chunk size too — no boundary may corrupt it.
      for (let c = 3; c < 40; c++) {
        expect(readLastLogMessages(file, 1, c)[0]?.text).toBe("abc€def" + pad);
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
