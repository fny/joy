// Bracketed key-token language for raw tmux intervention.
//
// Input like `git commit<Enter>oops<C-c>` is parsed into literal-text and
// named-key segments. Tokens are case-insensitive and accept several
// dialects for the same key:
//
//   <Enter> <enter> <CR> <Return>          → Enter
//   <C-c> <ctrl+c> <Control-C> <^c>        → C-c
//   <M-x> <alt+x> <meta-x> <option+x>      → M-x
//   <cmd+k> <command-k> <super+k>          → M-k   (terminals have no Cmd;
//                                                    Meta is the nearest thing)
//   <ctrl+shift+a> <C-S-a>                 → C-S-a
//   <S-Tab> <shift+tab> <BTab>             → BTab
//   <Esc> <Up> <PgDn> <F5> <Backspace> …   → tmux named keys
//   <lt>                                   → literal '<'
//
// Anything that doesn't parse as a known key is passed through as literal
// text, angle brackets included — so prose like "use the <em> tag" survives.
// Bare single characters (<a>) are deliberately NOT keys for the same reason.
//
// Newlines inside literal text are translated to Enter key presses, so a
// multi-line paste behaves like typing it. C-style escapes in literal text are
// also honored: \n and \r → Enter, \t → Tab, \\ → a literal backslash (so
// `\\n` sends a literal "\n" rather than a newline).

export type KeySegment =
  | { type: "text"; text: string }
  | { type: "key"; key: string };

const KEY_ALIASES: Record<string, string> = {
  enter: "Enter", return: "Enter", cr: "Enter",
  esc: "Escape", escape: "Escape",
  tab: "Tab",
  btab: "BTab", // shift-tab; also produced by <S-Tab>/<shift+tab>
  space: "Space", spc: "Space",
  bs: "BSpace", backspace: "BSpace", bspace: "BSpace",
  del: "DC", delete: "DC", dc: "DC",
  ins: "IC", insert: "IC",
  up: "Up", down: "Down", left: "Left", right: "Right",
  home: "Home", end: "End",
  pgup: "PPage", pageup: "PPage", ppage: "PPage", prior: "PPage",
  pgdn: "NPage", pagedown: "NPage", npage: "NPage", next: "NPage",
};

const MOD_ALIASES: Record<string, "C" | "M" | "S"> = {
  c: "C", ctrl: "C", control: "C", "^": "C",
  m: "M", meta: "M", alt: "M", option: "M", opt: "M", a: "M",
  s: "S", shift: "S",
  // Terminals cannot transmit the Command/Super key; map to Meta so
  // muscle-memory tokens still do something sensible.
  cmd: "M", command: "M", super: "M", win: "M",
};

/** Resolve a bare key name (no modifiers) to a tmux key, or null. */
function resolveKeyName(name: string): string | null {
  const lower = name.toLowerCase();
  const fn = lower.match(/^f([1-9]|1[0-2])$/);
  if (fn) return `F${fn[1]}`;
  if (KEY_ALIASES[lower]) return KEY_ALIASES[lower];
  return null;
}

/**
 * Parse the inside of a <...> token. Returns a tmux key string, a literal
 * replacement ({ literal }), or null when it isn't a recognizable token
 * (caller passes the original text through verbatim).
 */
export function parseToken(inner: string): { key: string } | { literal: string } | null {
  const lower = inner.toLowerCase();
  if (lower === "lt") return { literal: "<" };
  if (lower === "gt") return { literal: ">" };

  // Strip modifier prefixes: e.g. ctrl+shift+a / C-S-a / ^c
  const mods: ("C" | "M" | "S")[] = [];
  let rest = inner;
  // ^x shorthand for ctrl-x
  if (rest.length > 1 && rest.startsWith("^")) {
    mods.push("C");
    rest = rest.slice(1);
  }
  for (;;) {
    const m = rest.match(/^([A-Za-z]+|\^)[+-](.+)$/s);
    if (!m) break;
    const alias = MOD_ALIASES[m[1].toLowerCase()];
    if (!alias) break;
    if (!mods.includes(alias)) mods.push(alias);
    rest = m[2];
  }

  // Resolve the final key.
  let key: string | null = resolveKeyName(rest);
  if (!key && rest.length === 1) {
    // Single character: only a key when modified (<C-c>); bare <a> stays text.
    if (mods.length === 0) return null;
    key = rest;
  }
  if (!key) return null;

  // shift+tab is its own named key in tmux.
  if (key === "Tab" && mods.includes("S")) {
    const others = mods.filter(m => m !== "S");
    return { key: others.length ? `${others.join("-")}-BTab` : "BTab" };
  }

  return { key: mods.length ? `${mods.join("-")}-${key}` : key };
}

/** Parse a full script into text/key segments. */
export function parseKeyScript(script: string): KeySegment[] {
  const segments: KeySegment[] = [];
  const pushText = (text: string) => {
    if (!text) return;
    const last = segments[segments.length - 1];
    if (last?.type === "text") last.text += text;
    else segments.push({ type: "text", text });
  };

  const re = /<([^<>\s]{1,24})>/g;
  let cursor = 0;
  for (let m = re.exec(script); m; m = re.exec(script)) {
    pushText(script.slice(cursor, m.index));
    const parsed = parseToken(m[1]);
    if (parsed === null) {
      pushText(m[0]); // unknown token → literal, brackets included
    } else if ("literal" in parsed) {
      pushText(parsed.literal);
    } else {
      segments.push({ type: "key", key: parsed.key });
    }
    cursor = m.index + m[0].length;
  }
  pushText(script.slice(cursor));

  // Expand literal text: actual newlines AND C-style escapes (\n \r → Enter,
  // \t → Tab, \\ → a literal backslash). Backslash escaping means `\\n` sends a
  // literal "\n", not a newline.
  const expanded: KeySegment[] = [];
  for (const seg of segments) {
    if (seg.type === "key") { expanded.push(seg); continue; }
    expanded.push(...expandTextSegment(seg.text));
  }
  return expanded;
}

function expandTextSegment(text: string): KeySegment[] {
  const out: KeySegment[] = [];
  let buf = "";
  const flush = () => { if (buf) { out.push({ type: "text", text: buf }); buf = ""; } };
  const enter = () => { flush(); out.push({ type: "key", key: "Enter" }); };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\\" && i + 1 < text.length) {
      const n = text[i + 1];
      if (n === "n" || n === "r") { enter(); i++; continue; }
      if (n === "t") { flush(); out.push({ type: "key", key: "Tab" }); i++; continue; }
      if (n === "\\") { buf += "\\"; i++; continue; }
      // Unknown escape → keep the backslash literal (the next char appends normally).
      buf += "\\";
      continue;
    }
    if (c === "\n") { enter(); continue; }
    buf += c;
  }
  flush();
  return out;
}
