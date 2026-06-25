// Quote argv into a tmux CONTROL-MODE command line.
//
// Control mode reads ONE command line per command and re-lexes it with tmux's own
// parser (spaces split args; single/double quotes + backslash group; `;` separates
// commands; `#{...}` is format text; a leading `-` is an option). We single-quote
// every arg that isn't a safe bareword — single quotes protect spaces, `;`, `#`,
// `$`, backticks, `~`, `{`/`}`, and backslashes from the lexer (verified against
// tmux's parser, incl. an empirical control-mode round-trip).
//
// Two rules the QUOTING alone does NOT cover, handled by the caller (TmuxDriver):
//  - Quoting does not stop OPTION parsing, so a literal `--` must precede any
//    user-controlled POSITIONAL arg (e.g. `send-keys -l -t <win> -- <text>`).
//  - A raw newline/CR/NUL can't sit on a command line (a newline ends the command),
//    so they're REJECTED here. Callers collapse prose newlines to spaces or send a
//    named `Enter` key instead.

const SAFE_BAREWORD = /^[A-Za-z0-9_:.,%@/=+-]+$/;

/** Quote one argument for tmux's control-mode lexer. Throws on newline/CR/NUL. */
export function tmuxQuoteArg(s: string): string {
  if (/[\n\r\0]/.test(s)) {
    throw new Error("tmux arg contains a newline or NUL — not representable on a control-mode command line");
  }
  if (SAFE_BAREWORD.test(s)) return s; // bareword: identifiers, window targets, flags, format-free values
  return `'${s.replace(/'/g, "'\\''")}'`; // single-quote, escaping embedded quotes as '\''
}

/** Join argv into a single control-mode command line, each arg quoted as needed. */
export function tmuxCommand(args: string[]): string {
  return args.map(tmuxQuoteArg).join(" ");
}
