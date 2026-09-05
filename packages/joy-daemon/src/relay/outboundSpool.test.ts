import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OutboundSpool, type SpooledOutput } from "./outboundSpool";

const wire = { role: "assistant", content: { type: "text", text: "hi" } } as unknown as SpooledOutput["wire"];
const out = (id: string, localId: string, v2: string | null): SpooledOutput => ({ kind: "output", id, localId, v2SessionId: v2, turnId: null, wire, runtimeEventId: `rec:${id}`, at: 1 });

describe("OutboundSpool", () => {
  it("persists synchronously and survives a reopen; ack removes", () => {
    const dir = mkdtempSync(join(tmpdir(), "spool-"));
    const path = join(dir, "v2-outbound.json");
    const a = new OutboundSpool(path);
    a.add(out("1", "loc1", "v2a"));
    a.add({ kind: "terminal", id: "t1", v2SessionId: "v2a", turnId: "turn1", body: { type: "terminal", terminalState: "completed" }, at: 1 });
    expect(existsSync(path)).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8"))).toHaveLength(2);
    const b = new OutboundSpool(path); // a new daemon generation
    expect(b.size).toBe(2);
    expect(b.hasTerminalFor("turn1")).toBe(true);
    b.remove("1"); b.remove("t1");
    expect(new OutboundSpool(path).size).toBe(0);
  });

  it("records spooled before bind get their relay id on bind, in order", () => {
    const dir = mkdtempSync(join(tmpdir(), "spool-"));
    const s = new OutboundSpool(join(dir, "s.json"));
    s.add(out("1", "loc1", null)); s.add(out("2", "loc2", null)); s.add(out("3", "loc1", null));
    expect(s.pendingOutputs("loc1")).toBe(2);
    const hits = s.bind("loc1", "v2x");
    expect(hits.map((h) => h.id)).toEqual(["1", "3"]);
    expect(hits.every((h) => h.v2SessionId === "v2x")).toBe(true);
    expect(s.bind("loc1", "v2x")).toEqual([]); // idempotent
    expect(s.all().find((e) => e.id === "2")!.kind === "output" && (s.all().find((e) => e.id === "2") as SpooledOutput).v2SessionId).toBeNull();
  });

  it("a corrupt file is an empty spool, not a crash", () => {
    const dir = mkdtempSync(join(tmpdir(), "spool-"));
    const path = join(dir, "bad.json");
    require("node:fs").writeFileSync(path, "{not json");
    expect(new OutboundSpool(path).size).toBe(0);
  });
});
