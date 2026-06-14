import { test, expect } from "vitest";
import { parse, canonicalize, toTmuxSegments, ParseError, TmuxKeyError } from "./keyTokens";

// ── parse / canonicalize (token round-trip) ──────────────────────────────────

test("caret + escape tokens canonicalize to named keys", () => {
  expect(canonicalize("Run and kill<\\r><^C>")).toBe("Run and kill<Enter><C-c>");
  expect(canonicalize("<^L>")).toBe("<C-l>");
  expect(canonicalize("<^[>")).toBe("<Escape>");
  expect(canonicalize("<^?>")).toBe("<Backspace>");
  expect(canonicalize("<^I>")).toBe("<Tab>");
  expect(canonicalize("<^J>")).toBe("<LineFeed>");
});

test("modifiers, aliases, and case-insensitivity", () => {
  expect(canonicalize("<C-U>")).toBe("<C-U>");          // Ctrl + literal U
  expect(canonicalize("<U>")).toBe("<Up>");             // single-letter alias
  expect(canonicalize("<C-Up>")).toBe("<C-Up>");
  expect(canonicalize("<C-S-Up>")).toBe("<C-S-Up>");
  expect(canonicalize("<Shift+Tab>")).toBe("<S-Tab>");
  expect(canonicalize("<Alt+x>")).toBe("<A-x>");
  expect(canonicalize("<enter><ESC><c-c>")).toBe("<Enter><Escape><C-c>");
  expect(canonicalize("<PgUp>")).toBe("<PageUp>");
});

test("text escapes and real newlines become Enter/Tab keys", () => {
  expect(canonicalize("a<\\r>b")).toBe("a<Enter>b");
  expect(canonicalize("one\ntwo")).toBe("one<Enter>two");
  expect(canonicalize("git status\\ny\\t")).toBe("git status<Enter>y<Tab>");
  expect(canonicalize("a\\\\b")).toBe("a\\b"); // \\ → literal backslash
});

test("unknown or unterminated tokens throw ParseError", () => {
  expect(() => parse("ab<C-c")).toThrow(ParseError);
  expect(() => parse("<Nope>")).toThrow(ParseError);
});

// ── toTmux (key tokens → tmux send-keys names) ───────────────────────────────

test("simple keys map to tmux names", () => {
  expect(toTmuxSegments("<C-c>")).toEqual([{ type: "keys", names: ["C-c"] }]);
  expect(toTmuxSegments("<Enter>")).toEqual([{ type: "keys", names: ["Enter"] }]);
  expect(toTmuxSegments("<A-x>")).toEqual([{ type: "keys", names: ["M-x"] }]);
  expect(toTmuxSegments("<Up>")).toEqual([{ type: "keys", names: ["Up"] }]);
});

test("named keys → canonical tmux names", () => {
  expect(toTmuxSegments("<PageUp>")).toEqual([{ type: "keys", names: ["PPage"] }]);
  expect(toTmuxSegments("<PageDown>")).toEqual([{ type: "keys", names: ["NPage"] }]);
  expect(toTmuxSegments("<Delete>")).toEqual([{ type: "keys", names: ["DC"] }]);
  expect(toTmuxSegments("<Insert>")).toEqual([{ type: "keys", names: ["IC"] }]);
  expect(toTmuxSegments("<Backspace>")).toEqual([{ type: "keys", names: ["BSpace"] }]);
  expect(toTmuxSegments("<F1>")).toEqual([{ type: "keys", names: ["F1"] }]);
});

test("modifier prefixes and Shift+Tab→BTab", () => {
  expect(toTmuxSegments("<S-Up>")).toEqual([{ type: "keys", names: ["S-Up"] }]);
  expect(toTmuxSegments("<C-S-Up>")).toEqual([{ type: "keys", names: ["C-S-Up"] }]);
  expect(toTmuxSegments("<Shift+Tab>")).toEqual([{ type: "keys", names: ["BTab"] }]);
  expect(toTmuxSegments("<C-U>")).toEqual([{ type: "keys", names: ["C-u"] }]); // ctrl-letter lowercased
});

test("consecutive keys coalesce; literals split them", () => {
  expect(toTmuxSegments("<C-x><C-c>")).toEqual([{ type: "keys", names: ["C-x", "C-c"] }]);
  expect(toTmuxSegments("Hi<Enter>")).toEqual([
    { type: "literal", text: "Hi" },
    { type: "keys", names: ["Enter"] },
  ]);
  expect(toTmuxSegments("a<Enter>b")).toEqual([
    { type: "literal", text: "a" },
    { type: "keys", names: ["Enter"] },
    { type: "literal", text: "b" },
  ]);
});

test("literal-character tokens", () => {
  expect(toTmuxSegments("<lt>")).toEqual([{ type: "literal", text: "<" }]);
  expect(toTmuxSegments("<gt>")).toEqual([{ type: "literal", text: ">" }]);
  expect(toTmuxSegments("<a>")).toEqual([{ type: "literal", text: "a" }]); // bare char → text
});

test("unsendable combos throw TmuxKeyError", () => {
  expect(() => toTmuxSegments("<S-a>")).toThrow(TmuxKeyError); // Shift on a literal char
});
