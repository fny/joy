import { test, expect } from "vitest";
import { ControlParser, type ControlEvent } from "./controlClient";

// Feed a parser a list of lines, collect all emitted events.
function run(lines: string[]): ControlEvent[] {
  const p = new ControlParser();
  const evs: ControlEvent[] = [];
  for (const l of lines) evs.push(...p.feed(l));
  return evs;
}

test("a %begin/%end block emits one block-end with the joined content", () => {
  const evs = run([
    "%begin 1782337899 42 0",
    "line one",
    "line two",
    "%end 1782337899 42 0",
  ]);
  expect(evs).toEqual([{ type: "block-end", ok: true, out: "line one\nline two" }]);
});

test("%error closes the block with ok:false", () => {
  const evs = run([
    "%begin 1 7 0",
    "no such window",
    "%error 1 7 0",
  ]);
  expect(evs).toEqual([{ type: "block-end", ok: false, out: "no such window" }]);
});

test("a %end with a DIFFERENT command-number inside a block is CONTENT, not a terminator", () => {
  // Pane content can contain lines that look like control terminators — they must
  // only close the block when the command-number matches the open %begin.
  const evs = run([
    "%begin 1 100 0",
    "❯ here is some output",
    "%end 1 999 0",       // wrong number → ordinary content
    "%error 1 998 0",     // wrong number → ordinary content
    "more output",
    "%end 1 100 0",       // matching number → closes
  ]);
  expect(evs).toEqual([{
    type: "block-end", ok: true,
    out: "❯ here is some output\n%end 1 999 0\n%error 1 998 0\nmore output",
  }]);
});

test("%output emits an invalidation event with the pane id", () => {
  expect(run(["%output %5 some escaped bytes here"])).toEqual([{ type: "output", paneId: "%5" }]);
});

test("%output is ignored INSIDE a block (treated as content)", () => {
  // Per the man page %output never occurs inside an output block; if such a line
  // appears it's pane content, not a notification.
  const evs = run([
    "%begin 1 3 0",
    "%output %1 looks-like-a-notification",
    "%end 1 3 0",
  ]);
  expect(evs).toEqual([{ type: "block-end", ok: true, out: "%output %1 looks-like-a-notification" }]);
});

test("%exit emits exit; %session-changed / %window-* are ignored", () => {
  expect(run([
    "%session-changed $17 mysession",
    "%window-add @3",
    "%layout-change @1 …",
    "%exit",
  ])).toEqual([{ type: "exit" }]);
});

test("the initial attach block + a command response are two separate block-ends", () => {
  // On attach tmux sends one unsolicited empty block, then %session-changed, then
  // the command's block. The parser emits a block-end for each; the CLIENT decides
  // the first (empty, nothing pending) means 'ready'.
  const evs = run([
    "%begin 1 1 0",
    "%end 1 1 0",                 // implicit attach block (empty)
    "%session-changed $1 s",
    "%begin 1 2 1",
    "ZZMARKERZZ",
    "%end 1 2 1",                 // command response
  ]);
  expect(evs).toEqual([
    { type: "block-end", ok: true, out: "" },
    { type: "block-end", ok: true, out: "ZZMARKERZZ" },
  ]);
});

test("empty block → block-end with empty string", () => {
  expect(run(["%begin 9 5 0", "%end 9 5 0"])).toEqual([{ type: "block-end", ok: true, out: "" }]);
});
