import { test, expect } from "bun:test";
import { paneShowsReadyPrompt } from "./session";

test("ready: bare input prompt", () => {
  expect(paneShowsReadyPrompt("────\n❯\n────\n  ⏵⏵ bypass permissions on")).toBe(true);
});

test("ready: ghost-text suggestion", () => {
  expect(paneShowsReadyPrompt('────\n❯ Try "refactor <filepath>"\n────')).toBe(true);
});

test("not ready: folder trust selector dialog", () => {
  const pane = [
    "Quick safety check: Is this a project you created or one you trust?",
    " ❯ 1. Yes, I trust this folder",
    "   2. No, exit",
    "Enter to confirm · Esc to cancel",
  ].join("\n");
  expect(paneShowsReadyPrompt(pane)).toBe(false);
});

test("not ready: bash prompt before claude starts", () => {
  expect(paneShowsReadyPrompt("claude@host:/tmp/proj$ claude --dangerously-skip-permissions\n")).toBe(false);
});

test("ready: user message echoed at prompt", () => {
  expect(paneShowsReadyPrompt("● Hi! What can I help with?\n\n❯ hello there\n")).toBe(true);
});
