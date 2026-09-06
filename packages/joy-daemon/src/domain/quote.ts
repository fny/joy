// Quoting for generated text — one helper per target language (review
// campaign 2026-09, Wave B: #470 #472 #500 #593).
//
// Every site that interpolated a path into a command line or a document did
// its own quoting, and each got a different case wrong: double quotes around
// the hook paths still let the shell expand `$` and backticks (#470); a
// hand-written `'${path}'` broke on an apostrophe in the state dir (#472); the
// launchd plist interpolated PATH with no XML escaping at all (#500). A value
// that goes into a shell word goes through shellQuote; one that goes into XML
// text goes through xmlEscape. Nothing else builds quoted text by hand.

/**
 * POSIX single-quoting: the result is exactly ONE shell word whose value is
 * `s`, byte for byte — no expansion of `$`, backticks, `\`, `~`, globs or
 * whitespace. An embedded apostrophe closes the quote, is emitted escaped
 * (`\'`), and reopens it. Also valid for tmux's command lexer, which accepts
 * the same `'\''` idiom.
 */
export function shellQuote(s: string): string {
  if (s === "") return "''";
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** Join argv into one command line, every element shell-quoted. */
export function shellJoin(argv: readonly string[]): string {
  return argv.map(shellQuote).join(" ");
}

const XML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&apos;",
};

/**
 * Escape `s` for use as XML character data or an attribute value (plist
 * `<string>` bodies). The five predefined entities cover everything XML
 * treats as markup; control characters other than tab/LF/CR are not legal
 * XML 1.0 at all and are dropped rather than emitted into an unparseable file.
 */
export function xmlEscape(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "").replace(/[&<>"']/g, (c) => XML_ESCAPES[c]);
}
