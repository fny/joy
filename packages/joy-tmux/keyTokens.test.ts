import { test, expect } from "bun:test";
import { parseKeyScript, parseToken } from "./keyTokens";

test("the canonical example: git commit<Enter>oops<C-c>", () => {
  expect(parseKeyScript("git commit<Enter>oops<C-c>")).toEqual([
    { type: "text", text: "git commit" },
    { type: "key", key: "Enter" },
    { type: "text", text: "oops" },
    { type: "key", key: "C-c" },
  ]);
});

test("dialects: ctrl/control/^ all mean C-", () => {
  for (const tok of ["C-c", "c-C", "ctrl+c", "Ctrl-C", "CONTROL+c", "^c"]) {
    const parsed = parseToken(tok);
    expect(parsed && "key" in parsed ? parsed.key.toLowerCase() : null).toBe("c-c");
  }
});

test("dialects: alt/meta/option/m/a mean M-", () => {
  for (const tok of ["M-x", "alt+x", "meta-x", "option+x", "opt-x", "a-x"]) {
    expect(parseToken(tok)).toEqual({ key: "M-x" });
  }
});

test("cmd/command/super map to Meta (terminals have no Cmd)", () => {
  for (const tok of ["cmd+k", "command-k", "super+k", "win+k"]) {
    expect(parseToken(tok)).toEqual({ key: "M-k" });
  }
});

test("multi-modifier: ctrl+shift+a in either dialect", () => {
  expect(parseToken("ctrl+shift+a")).toEqual({ key: "C-S-a" });
  expect(parseToken("C-S-a")).toEqual({ key: "C-S-a" });
});

test("shift+tab becomes BTab", () => {
  expect(parseToken("shift+tab")).toEqual({ key: "BTab" });
  expect(parseToken("S-Tab")).toEqual({ key: "BTab" });
  expect(parseToken("btab")).toEqual({ key: "BTab" });
  expect(parseToken("C-S-Tab")).toEqual({ key: "C-BTab" });
});

test("named keys, case-insensitive, with aliases", () => {
  expect(parseToken("enter")).toEqual({ key: "Enter" });
  expect(parseToken("RETURN")).toEqual({ key: "Enter" });
  expect(parseToken("Esc")).toEqual({ key: "Escape" });
  expect(parseToken("backspace")).toEqual({ key: "BSpace" });
  expect(parseToken("Del")).toEqual({ key: "DC" });
  expect(parseToken("PgUp")).toEqual({ key: "PPage" });
  expect(parseToken("pagedown")).toEqual({ key: "NPage" });
  expect(parseToken("f5")).toEqual({ key: "F5" });
  expect(parseToken("F12")).toEqual({ key: "F12" });
  expect(parseToken("up")).toEqual({ key: "Up" });
});

test("modified named keys", () => {
  expect(parseToken("C-Enter")).toEqual({ key: "C-Enter" });
  expect(parseToken("alt+up")).toEqual({ key: "M-Up" });
});

test("punctuation keys with modifiers", () => {
  expect(parseToken("C--")).toEqual({ key: "C--" });
  expect(parseToken("C-+")).toEqual({ key: "C-+" });
});

test("unknown tokens pass through as literal text", () => {
  expect(parseKeyScript("use the <em> tag")).toEqual([
    { type: "text", text: "use the <em> tag" },
  ]);
  // bare single chars are NOT keys
  expect(parseKeyScript("type <a> here")).toEqual([
    { type: "text", text: "type <a> here" },
  ]);
});

test("<lt> produces a literal angle bracket", () => {
  expect(parseKeyScript("a <lt>b> c")).toEqual([
    { type: "text", text: "a <b> c" },
  ]);
});

test("newlines in text become Enter presses", () => {
  expect(parseKeyScript("line1\nline2")).toEqual([
    { type: "text", text: "line1" },
    { type: "key", key: "Enter" },
    { type: "text", text: "line2" },
  ]);
});

test("adjacent keys, no text between", () => {
  expect(parseKeyScript("<Up><Up><Enter>")).toEqual([
    { type: "key", key: "Up" },
    { type: "key", key: "Up" },
    { type: "key", key: "Enter" },
  ]);
});

test("empty script", () => {
  expect(parseKeyScript("")).toEqual([]);
});

test("escapes: \\n and \\r become Enter, \\t becomes Tab", () => {
  expect(parseKeyScript("git status\\ny\\t")).toEqual([
    { type: "text", text: "git status" },
    { type: "key", key: "Enter" },
    { type: "text", text: "y" },
    { type: "key", key: "Tab" },
  ]);
});

test("escapes: \\\\ is a literal backslash, and \\\\n escapes the newline", () => {
  // "a\\nb" (backslash-backslash-n) → literal "a\nb", NOT a newline
  expect(parseKeyScript("a\\\\nb")).toEqual([
    { type: "text", text: "a\\nb" },
  ]);
});

test("escapes: unknown escape keeps the backslash literal", () => {
  expect(parseKeyScript("a\\xb")).toEqual([
    { type: "text", text: "a\\xb" },
  ]);
});

test("escapes coexist with key tokens", () => {
  expect(parseKeyScript("echo hi\\n<C-c>")).toEqual([
    { type: "text", text: "echo hi" },
    { type: "key", key: "Enter" },
    { type: "key", key: "C-c" },
  ]);
});
