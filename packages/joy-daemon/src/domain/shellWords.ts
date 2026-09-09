// Split a user-typed argument string into argv words the way a POSIX shell
// would, for harnesses the daemon spawns directly (pi, agy) rather than
// through a tmux shell line: single quotes are literal, double quotes honour
// backslash escapes, an unquoted backslash escapes the next character.
//
// Control characters are refused up front (an integrity check, as for the
// claude launch line: authenticated callers can already run anything, so
// this is not a security boundary).

export class ShellWordsError extends Error {}

export function splitShellWords(input: string): string[] {
  if (/[\x00-\x1f\x7f]/.test(input)) throw new ShellWordsError("control characters are not allowed in extra arguments");
  const out: string[] = [];
  let cur = "";
  let inWord = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (quote === "'") {
      if (c === "'") quote = null;
      else cur += c;
      continue;
    }
    if (quote === '"') {
      if (c === '"') { quote = null; continue; }
      if (c === "\\" && i + 1 < input.length && '"\\$`'.includes(input[i + 1])) { cur += input[++i]; continue; }
      cur += c;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; inWord = true; continue; }
    if (c === "\\" && i + 1 < input.length) { cur += input[++i]; inWord = true; continue; }
    if (c === " " || c === "\t") {
      if (inWord) { out.push(cur); cur = ""; inWord = false; }
      continue;
    }
    cur += c;
    inWord = true;
  }
  if (quote) throw new ShellWordsError(`unterminated ${quote === "'" ? "single" : "double"} quote in extra arguments`);
  if (inWord) out.push(cur);
  return out;
}
