// Bracketed key-token language for raw tmux intervention.
//
// Input like `git commit<Enter>oops<C-c>` parses into literal-text and key
// tokens, then maps to the key NAMES `tmux send-keys` understands. We never
// emit raw bytes: tmux owns the name→byte translation against the pane's pty
// (Enter→\r, C-c→\x03, Up→\x1b[A, …), including application-cursor mode and
// terminal quirks. Our job is just to produce correct tmux key names.
//
// Token syntax inside <…>:
//   <Enter> <Esc> <Tab> <Space> <Up> <PgUp> <F5> <Delete> …  named keys (aliases ok)
//   <C-c> <Ctrl+c> <^c>                                       Ctrl chord
//   <M-x> <Alt+x> <Meta-x>                                    Alt/Meta chord
//   <C-S-Up> <Shift+Tab>                                      combined modifiers
//   <^C> <^I> <^[> <^?>                                       caret notation
//   <lt> <gt> <Dash>                                          literal < > -
// Bare text passes through verbatim. C-style escapes in a text run are honored:
//   \n \r → Enter, \t → Tab, \\ → a literal backslash; real newlines → Enter.
// Unknown tokens throw (ParseError) — this is a deliberate keyboard-intervention
// surface, not prose; send literal text through the pane's literal mode instead.

export type Modifier = "Ctrl" | "Shift" | "Alt";

export type Token =
  | { type: "text"; value: string }
  | { type: "key"; key: string; mods: Modifier[]; literal: boolean };

export class ParseError extends Error {}

// canonical -> aliases. `\r`/`\n` cover the two-char escapes inside <…> tokens.
const KEY_ALIASES: Record<string, string[]> = {
  Enter: ["Return", "\\r", "CR"],
  Escape: ["Esc"],
  Tab: ["T"],
  Space: ["Spc"],
  Backspace: ["BS", "BSpace"],
  LineFeed: ["LF", "\\n"],
  Up: ["U"],
  Down: ["D"],
  Left: ["L"],
  Right: ["R"],
  Home: [],
  End: [],
  PageUp: ["PgUp", "PPage", "Prior"],
  PageDown: ["PgDn", "PgDown", "NPage", "Next"],
  Insert: ["Ins", "IC"],
  Delete: ["Del", "DC"],
  F1: [], F2: [], F3: [], F4: [], F5: [], F6: [],
  F7: [], F8: [], F9: [], F10: [], F11: [], F12: [],
  LT: [], // literal "<"
  GT: [], // literal ">"
  Dash: [], // literal "-" (escapes the modifier separator)
};

const MOD_ALIASES: Record<Modifier, string[]> = {
  Ctrl: ["C", "Ctrl", "Control", "^"],
  Shift: ["S", "Shift"],
  // Terminals can't transmit Cmd/Super; map them to Meta so muscle-memory works.
  Alt: ["A", "Alt", "M", "Meta", "Opt", "Option", "Cmd", "Command", "Super", "Win"],
};

const CARET_CHORDS: Record<string, string> = {
  // caret -> named key: same byte, clearer intent + correct tmux encoding
  "^I": "Tab",
  "^M": "Enter",
  "^J": "LineFeed",
  "^[": "Escape",
  "^?": "Backspace",
  // signals / job control
  "^C": "C-c", "^D": "C-d", "^Z": "C-z", "^\\": "C-\\",
  // terminal / flow control
  "^L": "C-l", "^S": "C-s", "^Q": "C-q", "^G": "C-g",
  // readline / line editing
  "^A": "C-a", "^E": "C-e", "^U": "C-u", "^W": "C-w", "^K": "C-k", "^R": "C-r",
};

const ALIAS_TO_CANON = new Map<string, string>();
for (const [canon, aliases] of Object.entries(KEY_ALIASES)) {
  ALIAS_TO_CANON.set(canon.toLowerCase(), canon);
  for (const a of aliases) ALIAS_TO_CANON.set(a.toLowerCase(), canon);
}

const MOD_TO_CANON = new Map<string, Modifier>();
for (const [canon, aliases] of Object.entries(MOD_ALIASES) as [Modifier, string[]][]) {
  for (const a of aliases) MOD_TO_CANON.set(a.toLowerCase(), canon);
}

const DEFAULT_CHORDS = new Map<string, string>(
  Object.entries(CARET_CHORDS).map(([k, v]) => [k.toLowerCase(), v]),
);

const MOD_ORDER: Modifier[] = ["Ctrl", "Alt", "Shift"];
const sortMods = (m: Modifier[]): Modifier[] =>
  [...new Set(m)].sort((a, b) => MOD_ORDER.indexOf(a) - MOD_ORDER.indexOf(b));

const len = (s: string): number => [...s].length;

function resolveKey(raw: string): { key: string; literal: boolean } {
  if (len(raw) === 1) return { key: raw, literal: true };
  const canon = ALIAS_TO_CANON.get(raw.toLowerCase());
  if (canon) return { key: canon, literal: false };
  throw new ParseError(`Unknown key: "${raw}"`);
}

function parseChord(str: string): { key: string; mods: Modifier[]; literal: boolean } {
  const mods: Modifier[] = [];
  let rest = str.trim();
  for (;;) {
    const m = /^([A-Za-z^]+)\s*[-+]\s*/.exec(rest);
    if (!m) break;
    const mod = MOD_TO_CANON.get(m[1].toLowerCase());
    if (!mod) break;
    mods.push(mod);
    rest = rest.slice(m[0].length);
  }
  const { key, literal } = resolveKey(rest);
  return { key, mods: sortMods(mods), literal };
}

function resolveToken(inner: string, chords: Map<string, string>): Token {
  const low = inner.toLowerCase();

  const chord = chords.get(low);
  if (chord) return { type: "key", ...parseChord(chord) };

  // bare caret notation, e.g. <^x> → Ctrl+x (chords table covers the common ones)
  if (len(inner) === 2 && inner[0] === "^") {
    return { type: "key", key: inner[1].toLowerCase(), mods: ["Ctrl"], literal: true };
  }

  const canon = ALIAS_TO_CANON.get(low);
  if (canon) return { type: "key", key: canon, mods: [], literal: false };

  if (/[-+]/.test(inner)) return { type: "key", ...parseChord(inner) };

  if (len(inner) === 1) return { type: "key", key: inner, mods: [], literal: true };

  throw new ParseError(`Unrecognized token: "<${inner}>"`);
}

// Expand a literal text run: real newlines and C-style escapes become key
// tokens so multi-line / escaped input behaves like typing it.
//   \n \r and real CR/LF → Enter ;  \t → Tab ;  \\ → literal "\"
function expandText(value: string): Token[] {
  const out: Token[] = [];
  let buf = "";
  const flush = () => { if (buf) { out.push({ type: "text", value: buf }); buf = ""; } };
  const key = (k: string) => { flush(); out.push({ type: "key", key: k, mods: [], literal: false }); };
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c === "\\" && i + 1 < value.length) {
      const n = value[i + 1];
      if (n === "n" || n === "r") { key("Enter"); i++; continue; }
      if (n === "t") { key("Tab"); i++; continue; }
      if (n === "\\") { buf += "\\"; i++; continue; }
      buf += "\\"; continue; // unknown escape: keep the backslash, next char appends normally
    }
    if (c === "\n" || c === "\r") { key("Enter"); continue; }
    buf += c;
  }
  flush();
  return out;
}

export interface ParseOptions {
  chords?: Record<string, string>; // caret ("^X") or name -> chord string ("C-c", "Shift+Tab")
}

export function parse(input: string, options: ParseOptions = {}): Token[] {
  const chords = options.chords
    ? new Map([
        ...DEFAULT_CHORDS,
        ...Object.entries(options.chords).map(([k, v]) => [k.toLowerCase(), v] as const),
      ])
    : DEFAULT_CHORDS;

  const out: Token[] = [];
  let i = 0;
  let textStart = 0;
  const flush = (end: number): void => {
    if (end > textStart) out.push(...expandText(input.slice(textStart, end)));
  };

  while (i < input.length) {
    if (input[i] === "<") {
      const close = input.indexOf(">", i + 1);
      if (close === -1) throw new ParseError(`Unterminated "<" at index ${i}`);
      flush(i);
      out.push(resolveToken(input.slice(i + 1, close).trim(), chords));
      i = textStart = close + 1;
    } else {
      i++;
    }
  }
  flush(input.length);
  return out;
}

const MOD_SHORT: Record<Modifier, string> = { Ctrl: "C", Shift: "S", Alt: "A" };

export function serialize(tokens: Token[]): string {
  return tokens
    .map((t) =>
      t.type === "text"
        ? t.value
        : `<${[...t.mods.map((m) => MOD_SHORT[m]), t.key].join("-")}>`,
    )
    .join("");
}

export const canonicalize = (input: string, options?: ParseOptions): string =>
  serialize(parse(input, options));

// ── tmux key-name mapping (replaces the raw-byte encoder) ────────────────────
// A run of tmux key names is sent as `tmux send-keys <name> <name> …`; a
// literal run is sent with `tmux send-keys -l <text>`.

export class TmuxKeyError extends Error {}

export type TmuxSegment =
  | { type: "literal"; text: string }
  | { type: "keys"; names: string[] };

// canonical key → tmux send-keys name
const TMUX_NAMED: Record<string, string> = {
  Enter: "Enter", Escape: "Escape", Tab: "Tab", Space: "Space",
  Backspace: "BSpace", LineFeed: "C-j", // tmux has no LineFeed key; ^J == LF
  Up: "Up", Down: "Down", Left: "Left", Right: "Right",
  Home: "Home", End: "End", PageUp: "PPage", PageDown: "NPage",
  Insert: "IC", Delete: "DC",
  F1: "F1", F2: "F2", F3: "F3", F4: "F4", F5: "F5", F6: "F6",
  F7: "F7", F8: "F8", F9: "F9", F10: "F10", F11: "F11", F12: "F12",
};
// canonical key → the literal character it stands for
const TMUX_LITERAL_CHAR: Record<string, string> = { LT: "<", GT: ">", Dash: "-" };
const TMUX_MOD_PREFIX: Record<Modifier, string> = { Ctrl: "C-", Alt: "M-", Shift: "S-" };

const modPrefix = (mods: Modifier[]): string =>
  MOD_ORDER.filter((m) => mods.includes(m)).map((m) => TMUX_MOD_PREFIX[m]).join("");

/** Map one key token to either a tmux key name or a literal character. */
function keyToTmux(t: Extract<Token, { type: "key" }>): { name?: string; literal?: string } {
  const { key, mods, literal } = t;

  // Shift+Tab is tmux's BTab (the S- prefix doesn't apply to Tab).
  if (key === "Tab" && mods.includes("Shift")) {
    return { name: modPrefix(mods.filter((m) => m !== "Shift")) + "BTab" };
  }

  // Literal character tokens: <a>, <C-c>, <^x>, <M-x>.
  if (literal) {
    // ctrl/alt of a letter is case-insensitive; tmux prefers lowercase.
    const ch = len(key) === 1 ? key.toLowerCase() : key;
    if (mods.length === 0) return { literal: key }; // bare char → literal text
    if (mods.includes("Shift")) {
      throw new TmuxKeyError(`Shift on a literal character "${key}" — type the shifted character directly`);
    }
    return { name: modPrefix(mods) + ch };
  }

  // Keys that are really a literal character (<lt> <gt> <Dash>).
  if (key in TMUX_LITERAL_CHAR) {
    if (mods.length) throw new TmuxKeyError(`modifiers not supported on <${key}>`);
    return { literal: TMUX_LITERAL_CHAR[key] };
  }

  const name = TMUX_NAMED[key];
  if (!name) throw new TmuxKeyError(`no tmux mapping for key <${key}>`);
  if (key === "LineFeed" && mods.length) throw new TmuxKeyError(`modifiers not supported on <LineFeed>`);
  return { name: modPrefix(mods) + name };
}

/**
 * Lower a token stream to tmux send-keys segments: consecutive key names are
 * grouped into one `keys` segment; literal text (incl. bare chars like <a>) is
 * coalesced into `literal` segments. Throws TmuxKeyError on an unsendable combo.
 */
export function toTmux(tokens: Token[]): TmuxSegment[] {
  const out: TmuxSegment[] = [];
  const pushLiteral = (text: string) => {
    const last = out[out.length - 1];
    if (last?.type === "literal") last.text += text;
    else out.push({ type: "literal", text });
  };
  const pushName = (name: string) => {
    const last = out[out.length - 1];
    if (last?.type === "keys") last.names.push(name);
    else out.push({ type: "keys", names: [name] });
  };
  for (const t of tokens) {
    if (t.type === "text") { if (t.value) pushLiteral(t.value); continue; }
    const m = keyToTmux(t);
    if (m.literal !== undefined) pushLiteral(m.literal);
    else pushName(m.name!);
  }
  return out;
}

/** Convenience: parse + lower in one call. */
export const toTmuxSegments = (input: string, options?: ParseOptions): TmuxSegment[] =>
  toTmux(parse(input, options));
