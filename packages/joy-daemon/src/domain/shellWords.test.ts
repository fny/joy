import { describe, expect, it } from "vitest";
import { ShellWordsError, splitShellWords } from "./shellWords";

describe("splitShellWords", () => {
  it("splits on blanks and keeps quoted spans whole", () => {
    expect(splitShellWords("--thinking high  --name 'my session' --tools \"read,grep\"")).toEqual([
      "--thinking", "high", "--name", "my session", "--tools", "read,grep",
    ]);
  });
  it("single quotes are literal; double quotes honour escapes; a bare backslash escapes", () => {
    expect(splitShellWords(`'a\\b' "a\\"b" a\\ b`)).toEqual(["a\\b", 'a"b', "a b"]);
  });
  it("an empty quoted word survives; leading/trailing blanks do not", () => {
    expect(splitShellWords(`  --name ""  `)).toEqual(["--name", ""]);
    expect(splitShellWords("")).toEqual([]);
  });
  it("refuses control characters and unterminated quotes", () => {
    expect(() => splitShellWords("--x\n--y")).toThrow(ShellWordsError);
    expect(() => splitShellWords("'open")).toThrow(/unterminated single/);
    expect(() => splitShellWords('"open')).toThrow(/unterminated double/);
  });
});
