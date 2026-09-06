import { test, expect, afterEach } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import { codexHome, codexSessionsDir, codexConfigPath } from "./codexHome";

const saved = process.env.CODEX_HOME;
afterEach(() => {
  if (saved === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = saved;
});

test("unset → ~/.codex", () => {
  delete process.env.CODEX_HOME;
  expect(codexHome()).toBe(join(homedir(), ".codex"));
  expect(codexSessionsDir()).toBe(join(homedir(), ".codex", "sessions"));
  expect(codexConfigPath()).toBe(join(homedir(), ".codex", "config.toml"));
});

test("set → that directory, for every derived path (#524 #541 #546)", () => {
  process.env.CODEX_HOME = "/custom-codex";
  expect(codexHome()).toBe("/custom-codex");
  expect(codexSessionsDir()).toBe("/custom-codex/sessions");
  expect(codexConfigPath()).toBe("/custom-codex/config.toml");
});

test("an empty or blank value is treated as unset, as codex itself does", () => {
  process.env.CODEX_HOME = "";
  expect(codexHome()).toBe(join(homedir(), ".codex"));
  process.env.CODEX_HOME = "   ";
  expect(codexHome()).toBe(join(homedir(), ".codex"));
});

test("an explicit fallback home is used only when CODEX_HOME is unset (command scans)", () => {
  delete process.env.CODEX_HOME;
  expect(codexHome("/scan/home")).toBe("/scan/home/.codex");
  process.env.CODEX_HOME = "/custom";
  expect(codexHome("/scan/home")).toBe("/custom");
});

test("resolves at call time, not import time", () => {
  process.env.CODEX_HOME = "/a";
  expect(codexHome()).toBe("/a");
  process.env.CODEX_HOME = "/b";
  expect(codexHome()).toBe("/b");
});
