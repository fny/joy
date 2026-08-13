import { test, expect } from "vitest";
import { join } from "path";
import { homedir } from "os";
import { validatePath } from "./fileOps";

const CWD = "/tmp/proj";

test("validatePath: inside cwd ok, outside denied (jail unchanged)", () => {
  expect(validatePath("src/a.ts", CWD).valid).toBe(true);
  expect(validatePath("/etc/passwd", CWD).valid).toBe(false);
  expect(validatePath("../other", CWD).valid).toBe(false);
});

test("validatePath: extra root admits exactly that subtree", () => {
  const root = join(homedir(), ".joy", "sessions", "abc123");
  expect(validatePath(join(root, "media", "x.webp"), CWD, [root]).valid).toBe(true);
  expect(validatePath(root, CWD, [root]).valid).toBe(true);
  // A SIBLING session's dir is NOT admitted — the root is per-session.
  const other = join(homedir(), ".joy", "sessions", "zzz999", "media", "x.webp");
  expect(validatePath(other, CWD, [root]).valid).toBe(false);
  // Prefix trickery: root path as a string prefix of a different dir.
  expect(validatePath(root + "-evil/x", CWD, [root]).valid).toBe(false);
});

test("validatePath: leading ~ expands to home before the jail check", () => {
  const root = join(homedir(), ".joy", "sessions", "abc123");
  expect(validatePath("~/.joy/sessions/abc123/media/x.webp", CWD, [root]).valid).toBe(true);
  expect(validatePath("~/.ssh/id_ed25519", CWD, [root]).valid).toBe(false);
});

test("validatePath: traversal out of the extra root is denied", () => {
  const root = join(homedir(), ".joy", "sessions", "abc123");
  expect(validatePath(join(root, "..", "zzz999", "x.webp"), CWD, [root]).valid).toBe(false);
});
