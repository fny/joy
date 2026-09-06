// Pane-parser regressions from the 2026-09 review campaign (#478 #479 #480
// #485 #486). Fixtures follow LIVE captures taken 2026-09-06 from claude
// 2.1.2xx in a 110-col tmux pane:
//
//   ─────────────────────────────────────                 ← top rule (grey)
//   ❯ Try "npm test"                                     ← `❯` + nbsp + text
//   ─────────────────────────────────────                 ← bottom rule
//     ⏵⏵ auto mode on (shift+tab to cycle) · esc to interrupt · ← for agents
//
// The footer carries "esc to interrupt" as a `·`-separated segment while a turn
// runs and drops it when idle; the spinner (`✽ Vibing…`) sits ABOVE the box.
import { test, expect } from "vitest";
import {
  paneShowsReadyPrompt, paneInputText, paneInputLineSpan, paneShowsEmptyReadyPrompt,
  paneShowsGenerating, paneShowsWorking, parsePermissionModeFromPane, dialogFromPane,
} from "./session";

const RULE = "─".repeat(60);
const NBSP = " ";
const FOOTER_IDLE = "  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents";
const FOOTER_GENERATING = "  ⏵⏵ auto mode on (shift+tab to cycle) · esc to interrupt · ← for agents";
const FOOTER_PLAN = "  ⏸ plan mode on (shift+tab to cycle)";

// ── #485: a numbered draft inside the bordered box IS the live box ───────────

test("#485 numbered draft in the bordered box is the live input, not a selector row", () => {
  const pane = ["● ok", RULE, `❯${NBSP}1. Review the build`, RULE, FOOTER_IDLE].join("\n");
  expect(paneShowsReadyPrompt(pane)).toBe(true);
  expect(paneInputText(pane)).toBe("1. Review the build");
  expect(paneShowsEmptyReadyPrompt(pane)).toBe(false);
  expect(paneInputLineSpan(pane)).toBe(1);
  // The footer under that box is still the live status region.
  expect(paneShowsGenerating(pane)).toBe(false);
  expect(parsePermissionModeFromPane(pane)).toBe("auto");
});

test("#485 selector rows stay selectors: trust dialog (no bottom rule) and option runs", () => {
  const trust = ["Is this a project you trust?", RULE, " ❯ 1. Yes, I trust this folder", "   2. No, exit"].join("\n");
  expect(paneShowsReadyPrompt(trust)).toBe(false);
  expect(paneInputText(trust)).toBeNull();
  // A picker whose rows happen to sit between two rules: the count continues → selector.
  const boxedPicker = [RULE, " ❯ 1. Resume from summary", "   2. Resume full session", RULE].join("\n");
  expect(paneInputText(boxedPicker)).toBeNull();
  expect(dialogFromPane(boxedPicker)).not.toBeNull();
  // A multi-line numbered list between two rules is told apart by the prompt
  // COLUMN (#485 residual): Claude paints the input `❯` flush left, a picker
  // indents its selected row. Flush left → a numbered DRAFT (the gate clears
  // it and dispatches); indented → still a selector.
  const draft = [RULE, `❯${NBSP}1. first`, "  2. second", RULE, FOOTER_IDLE].join("\n");
  expect(paneShowsReadyPrompt(draft)).toBe(true);
  expect(paneInputText(draft)).toBe("1. first 2. second");
  expect(paneShowsEmptyReadyPrompt(draft)).toBe(false);
  expect(paneInputLineSpan(draft)).toBe(2);
  const indentedRun = [RULE, " ❯ 1. first", "   2. second", RULE, FOOTER_IDLE].join("\n");
  expect(paneInputText(indentedRun)).toBeNull();
  expect(paneShowsReadyPrompt(indentedRun)).toBe(false);
});

// ── #486: footer keywords inside a multi-line draft are draft text ───────────

test("#486 multi-line draft containing footer words is read in full (bottom rule delimits)", () => {
  const pane = [RULE, `❯${NBSP}`, "  Explain plan mode on this project", "  and bypass permissions on CI", RULE, FOOTER_IDLE].join("\n");
  expect(paneInputText(pane)).toBe("Explain plan mode on this project and bypass permissions on CI");
  expect(paneShowsEmptyReadyPrompt(pane)).toBe(false);
  expect(paneInputLineSpan(pane)).toBe(3);
});

test("#486 without a bottom rule the FOOTER SHAPE bounds the box, not bare mode words", () => {
  const truncated = [RULE, `❯${NBSP}first`, "  plan mode on is what I want to discuss", FOOTER_PLAN].join("\n");
  expect(paneInputText(truncated)).toBe("first plan mode on is what I want to discuss");
  expect(paneInputLineSpan(truncated)).toBe(2);
  // Empty box, footer directly under the rule: still empty (regression guard).
  const empty = [RULE, `❯${NBSP}`, RULE, FOOTER_IDLE].join("\n");
  expect(paneInputText(empty)).toBe("");
});

// ── #478: `Try "…"` — ghost placeholder vs a human draft ─────────────────────

test('#478 coloured capture: a typed `Try "npm test"` (default colour) is a DRAFT, a dim one is the placeholder', () => {
  const grey = "\x1b[38;5;246m";
  const draft = [`${grey}${RULE}`, `\x1b[39m❯${NBSP}Try "npm test"`, `${grey}${RULE}`, `\x1b[39m${FOOTER_IDLE}`].join("\n");
  expect(paneInputText(draft)).toBe('Try "npm test"');
  expect(paneShowsEmptyReadyPrompt(draft)).toBe(false);
  const ghost = [`${grey}${RULE}`, `\x1b[39m❯${NBSP}\x1b[2mTry "refactor <filepath>"\x1b[22m`, `${grey}${RULE}`, `\x1b[39m${FOOTER_IDLE}`].join("\n");
  expect(paneInputText(ghost)).toBe("");
  const greyGhost = [`${grey}${RULE}`, `\x1b[39m❯${NBSP}\x1b[38;5;242mTry "fix lint errors"\x1b[39m`, `${grey}${RULE}`].join("\n");
  expect(paneInputText(greyGhost)).toBe("");
  // Anything beyond a single quoted suggestion is never a placeholder, coloured or not.
  const longer = [`${grey}${RULE}`, `\x1b[39m❯${NBSP}\x1b[2mTry "npm test" then deploy`, `${grey}${RULE}`].join("\n");
  expect(paneInputText(longer)).toBe('Try "npm test" then deploy');
});

test("#478 plain capture keeps the legacy heuristic (a real ghost must still read empty)", () => {
  expect(paneInputText([RULE, '❯ Try "refactor <filepath>"', RULE].join("\n"))).toBe("");
  expect(paneInputText([RULE, `❯${NBSP}Try "npm test" and report`, RULE].join("\n"))).toBe('Try "npm test" and report');
});

// ── #479: "esc to interrupt" only counts where Claude paints it live ─────────

test("#479 a reply quoting the interrupt hint does not make an idle pane 'generating'", () => {
  const pane = ["● You can press Esc to interrupt a running command.", "", RULE, `❯${NBSP}`, RULE, FOOTER_IDLE].join("\n");
  expect(paneShowsGenerating(pane)).toBe(false);
  expect(paneShowsWorking(pane)).toBe(false);
  const parens = ["● Tip: the footer shows (esc to interrupt) while a turn runs", RULE, `❯${NBSP}`, RULE, FOOTER_IDLE].join("\n");
  expect(paneShowsGenerating(parens)).toBe(false);
});

test("#479 the live footer and the spinner line still read as generating", () => {
  const live = ["✽ Vibing…", "", RULE, `❯${NBSP}`, RULE, FOOTER_GENERATING].join("\n");
  expect(paneShowsGenerating(live)).toBe(true);
  expect(paneShowsGenerating("✻ Ruminating… (esc to interrupt)")).toBe(true);
  expect(paneShowsGenerating(["● reply", "✻ Pondering… (esc to interrupt)"].join("\n"))).toBe(true);
  // Narrow-pane footer truncation still falls through to the spinner shape.
  const narrow = ["✽ Zesting… (4m 17s · ↓ 13.9k tokens)", RULE, `❯${NBSP}`, RULE, "  ⏵⏵ auto mode on (shift+tab to cycle) · esc to…"].join("\n");
  expect(paneShowsGenerating(narrow)).toBe(true);
});

// ── #480: permission mode from the live footer, not from reply text ──────────

test("#480 mode words in conversation text never override the live footer", () => {
  const pane = ["● Earlier the footer said ⏵⏵ bypass permissions on, now it does not.", RULE, `❯${NBSP}`, RULE, FOOTER_PLAN].join("\n");
  expect(parsePermissionModeFromPane(pane)).toBe("plan");
  const dflt = ["● we were in ⏸ plan mode on before", RULE, `❯${NBSP}`, RULE, "  ? for shortcuts · ← for agents"].join("\n");
  expect(parsePermissionModeFromPane(dflt)).toBe("default");
  // Footer-only captures (no box painted yet) still resolve from the tail.
  expect(parsePermissionModeFromPane("  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents")).toBe("bypassPermissions");
});
