// #473: a failed prompt write must never produce a launch token that expands
// to an empty/partial system prompt. The token is returned only after the
// file reads back complete; an unwritable state dir falls back to tmpdir, and
// when nothing can hold the prompt the call throws instead of degrading.
import { test, expect, vi, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { optionsPromptArg, OPTIONS_SYSTEM_PROMPT } from "./optionsPrompt";

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "joy-optprompt-")); dirs.push(d); return d; };
afterEach(() => { vi.restoreAllMocks(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** The file the returned `"$(cat '…')"` token reads. */
function tokenPath(arg: string): string {
  const m = /^"\$\(cat '((?:[^']|'\\'')*)'\)"$/.exec(arg);
  if (!m) throw new Error(`unexpected token shape: ${arg}`);
  return m[1].replace(/'\\''/g, "'");
}

test("happy path: the token names a file holding the complete prompt", () => {
  const base = tmp();
  const arg = optionsPromptArg(base);
  const p = tokenPath(arg);
  expect(p).toBe(join(base, "options-system-prompt.txt"));
  expect(readFileSync(p, "utf8")).toBe(OPTIONS_SYSTEM_PROMPT);
});

test("an unwritable state dir falls back to a tmpdir file that holds the complete prompt (#473)", () => {
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  const root = tmp();
  const notADir = join(root, "file-not-dir");
  writeFileSync(notADir, "x"); // mkdir/open under a FILE fails with ENOTDIR
  const fallback = join(tmp(), "fallback");
  const arg = optionsPromptArg(notADir, fallback);
  const p = tokenPath(arg);
  expect(p).toBe(join(fallback, "options-system-prompt.txt"));
  expect(existsSync(p)).toBe(true);
  expect(readFileSync(p, "utf8")).toBe(OPTIONS_SYSTEM_PROMPT);
});

test("when no location can hold the prompt the call THROWS rather than returning an empty-expanding token (#473)", () => {
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  const root = tmp();
  const notADir = join(root, "f1"); writeFileSync(notADir, "x");
  const notADir2 = join(root, "f2"); writeFileSync(notADir2, "x");
  expect(() => optionsPromptArg(notADir, notADir2)).toThrow(/refusing to launch Claude/);
});
