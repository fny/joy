import { describe, expect, it, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { clearLogTitleCache, readLogTitle } from "./logTitle";

const dir = mkdtempSync(join(tmpdir(), "joy-logtitle-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let n = 0;
function file(lines: unknown[]): string {
  const p = join(dir, `t${n++}.jsonl`);
  writeFileSync(p, lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n");
  return p;
}
const user = (text: string) => ({ type: "user", message: { role: "user", content: text } });
const assistant = (text: string) => ({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } });
const ai = (aiTitle: string) => ({ type: "ai-title", aiTitle, sessionId: "s" });
const filler = (i: number) => assistant(`line ${i} ` + "x".repeat(200));

beforeEach(() => clearLogTitleCache());

describe("readLogTitle", () => {
  it("the agent's <joy-title> outranks Claude's ai-title, whichever came last", () => {
    const p = file([user("hello"), ai("first ai"), assistant('ok <joy-title value="Relay cutover"/>'), ai("later ai")]);
    expect(readLogTitle(p)).toEqual({ title: "Relay cutover", source: "agent" });
  });

  it("without an agent tag, the LAST ai-title wins", () => {
    const p = file([user("hello"), ai("first"), assistant("work"), ai("second"), assistant("more")]);
    expect(readLogTitle(p)).toEqual({ title: "second", source: "ai" });
  });

  it("with no title at all, the first real prompt stands in — not a tool result or meta line", () => {
    const p = file([
      { type: "user", isMeta: true, message: { role: "user", content: "meta" } },
      user("<local-command-stdout>x</local-command-stdout>"),
      user("Fix the flaky   pairing\ntest please"),
      assistant("sure"),
    ]);
    expect(readLogTitle(p)).toEqual({ title: "Fix the flaky pairing test please", source: "prompt" });
  });

  it("a long prompt is clipped", () => {
    const p = file([user("a".repeat(200))]);
    const t = readLogTitle(p)!;
    expect(t.source).toBe("prompt");
    expect(t.title.length).toBeLessThanOrEqual(60);
    expect(t.title.endsWith("…")).toBe(true);
  });

  it("a title beyond the tail window is still found from the head, never by reading the whole file", () => {
    const lines: unknown[] = [user("start here"), ai("early title")];
    for (let i = 0; i < 300; i++) lines.push(filler(i)); // ~60KB of untitled body
    const p = file(lines);
    // Tail window too small to reach the head; head window big enough.
    expect(readLogTitle(p, { tailBytes: 1024, headBytes: 4096 })).toEqual({ title: "early title", source: "ai" });
    // Neither window reaches it: untitled rather than a full read.
    clearLogTitleCache();
    const q = file([...lines.slice(0, 1), ...lines.slice(2, 40), ai("buried"), ...lines.slice(40)]);
    expect(readLogTitle(q, { tailBytes: 1024, headBytes: 512 })).toEqual({ title: "start here", source: "prompt" });
  });

  it("a line cut by the tail boundary is not misread", () => {
    const lines: unknown[] = [user("p")];
    for (let i = 0; i < 50; i++) lines.push(filler(i));
    lines.push(ai("tail title"));
    const p = file(lines);
    for (const tailBytes of [100, 133, 250, 777, 2048]) {
      clearLogTitleCache();
      const t = readLogTitle(p, { tailBytes, headBytes: 64 });
      // Either the tail reached the title or it fell back cleanly.
      expect(t === null || t.title === "tail title" || t.title === "p").toBe(true);
    }
  });

  it("is cached by size and mtime, and re-read when the file changes", () => {
    const p = file([user("v1")]);
    expect(readLogTitle(p)?.title).toBe("v1");
    writeFileSync(p, JSON.stringify(ai("v2")) + "\n");
    utimesSync(p, new Date(Date.now() + 5000), new Date(Date.now() + 5000));
    expect(readLogTitle(p)?.title).toBe("v2");
  });

  it("a missing or empty file is untitled", () => {
    expect(readLogTitle(join(dir, "nope.jsonl"))).toBeNull();
    expect(readLogTitle(file([]))).toBeNull();
  });
});
