import { test, expect, describe } from "vitest";
import { tmuxQuoteArg, tmuxCommand } from "./serialize";

// Codex's must-test corpus (xhigh design review) + the expected handling of each.
// The intent: a safe bareword passes through; anything the lexer would split or
// expand is single-quoted; raw newline/CR/NUL are rejected (not encoded).

describe("tmuxQuoteArg — barewords pass through", () => {
  test("window target", () => expect(tmuxQuoteArg("joy:j-abc123")).toBe("joy:j-abc123"));
  test("pane id", () => expect(tmuxQuoteArg("%5")).toBe("%5"));
  test("flags", () => { expect(tmuxQuoteArg("-l")).toBe("-l"); expect(tmuxQuoteArg("--")).toBe("--"); });
  test("named keys", () => { for (const k of ["C-c", "C-u", "Escape", "BTab", "Enter", "1"]) expect(tmuxQuoteArg(k)).toBe(k); });
  test("format-free value with =,./", () => expect(tmuxQuoteArg("window-size=manual/path.x")).toBe("window-size=manual/path.x"));
});

describe("tmuxQuoteArg — lexer metacharacters get single-quoted", () => {
  test("empty string → ''", () => expect(tmuxQuoteArg("")).toBe("''"));
  test("spaces", () => expect(tmuxQuoteArg("hello world")).toBe("'hello world'"));
  test("single quote → '\\'' escape", () => expect(tmuxQuoteArg("a'b")).toBe("'a'\\''b'"));
  test("semicolon stays ONE arg", () => expect(tmuxQuoteArg("semi;colon")).toBe("'semi;colon'"));
  test("hash is not a comment", () => expect(tmuxQuoteArg("hash#literal")).toBe("'hash#literal'"));
  test("no shell expansion: $HOME / backtick / ~user", () => {
    expect(tmuxQuoteArg("$HOME")).toBe("'$HOME'");
    expect(tmuxQuoteArg("`uname`")).toBe("'`uname`'");
    expect(tmuxQuoteArg("~user")).toBe("'~user'");
  });
  test("tmux format text #{pane_pid} is quoted (still expands when the command treats it as a format)", () => {
    expect(tmuxQuoteArg("#{pane_pid}")).toBe("'#{pane_pid}'");
    expect(tmuxQuoteArg("#{pane_current_path}")).toBe("'#{pane_current_path}'");
  });
  test("backslash / braces / tab / unicode round-trip inside quotes", () => {
    expect(tmuxQuoteArg("a\\b")).toBe("'a\\b'");
    expect(tmuxQuoteArg("{x}")).toBe("'{x}'");
    expect(tmuxQuoteArg("tab\tchar")).toBe("'tab\tchar'");
    expect(tmuxQuoteArg("héllo 🌍")).toBe("'héllo 🌍'");
  });
  test("double quote is quoted (no escaping needed inside single quotes)", () => {
    expect(tmuxQuoteArg('say "hi"')).toBe("'say \"hi\"'");
  });
});

describe("tmuxQuoteArg — rejects un-representable control chars", () => {
  test("embedded newline throws", () => expect(() => tmuxQuoteArg("line1\nline2")).toThrow(/newline|NUL/));
  test("carriage return throws", () => expect(() => tmuxQuoteArg("a\rb")).toThrow(/newline|NUL/));
  test("NUL throws", () => expect(() => tmuxQuoteArg("a\0b")).toThrow(/newline|NUL/));
});

describe("tmuxCommand — joins argv into one line", () => {
  test("capture-pane target", () => {
    expect(tmuxCommand(["capture-pane", "-p", "-t", "joy:j-abc"])).toBe("capture-pane -p -t joy:j-abc");
  });
  test("send-keys literal with -- guard before user text", () => {
    expect(tmuxCommand(["send-keys", "-l", "-t", "joy:w", "--", "git commit -m 'wip'"]))
      .toBe("send-keys -l -t joy:w -- 'git commit -m '\\''wip'\\'''");
  });
  test("display-message format stays one quoted arg", () => {
    expect(tmuxCommand(["display-message", "-t", "joy:w", "-p", "#{pane_pid}"]))
      .toBe("display-message -t joy:w -p '#{pane_pid}'");
  });
  test("a real claude launch line survives as one positional after --", () => {
    const cmd = "JOY_SESSION_ID='abc' claude --append-system-prompt 'Use <options>.' --settings '/p/s.json' || claude";
    const line = tmuxCommand(["send-keys", "-l", "-t", "joy:w", "--", cmd]);
    // round-trips: starts with the fixed prefix, the whole cmd is one single-quoted blob
    expect(line.startsWith("send-keys -l -t joy:w -- '")).toBe(true);
    expect(line.endsWith("'")).toBe(true);
    // every embedded single quote is escaped
    expect(line).toContain("'\\''abc'\\''");
  });
  test("a positional arg starting with - is still protected by a leading -- from the caller", () => {
    // tmuxCommand quotes; the -- (caller-inserted) is what stops option parsing.
    expect(tmuxCommand(["send-keys", "-l", "-t", "w", "--", "-l"])).toBe("send-keys -l -t w -- -l");
  });
});
