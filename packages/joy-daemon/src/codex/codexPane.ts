// What the Codex TUI is showing when it is NOT the conversation: its sign-in
// screens. Codex runs behind the app-server, so the daemon only ever looked at
// JSON-RPC and never at the pane — and a session whose ChatGPT token had
// lapsed sat on "Sign in with ChatGPT … Press enter to continue" for 21
// minutes with the first prompt held behind it and nothing in the app saying
// why (fny c80b0698, 2026-09-09). These parsers read that pane; the session's
// auth watcher acts on what they return.
//
// Pure functions over captured text, exported for tests built from the real
// capture. The TUI hard-wraps, so nothing here assumes a sentence fits a line.

export type CodexPaneAuth =
  /** "Sign in with ChatGPT / Device Code / API key — Press enter to continue". A choice. */
  | { kind: "chooser"; options: string[] }
  /** "Finish signing in via your browser": a URL and a one-time code to enter there. */
  | { kind: "device"; url: string; code: string; expiresMinutes: number | null }
  /** A keypress with no decision attached ("Before you start … Press enter to continue"). */
  | { kind: "continue" }
  /** The session's token is dead mid-conversation: "Your access token could not be refreshed…". */
  | { kind: "broken"; message: string };

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
function plain(text: string): string {
  return text.replace(ANSI, "").split("\n").map((l) => l.replace(/\s+$/, "")).join("\n");
}
/** Collapse the TUI's hard wraps so phrases can be matched across lines. */
function flat(text: string): string {
  return plain(text).replace(/\s*\n\s*/g, " ").replace(/\s{2,}/g, " ");
}

export function codexSignInChooser(text: string): string[] | null {
  const f = flat(text);
  if (!/Sign in with ChatGPT/i.test(f) || !/Press enter to continue/i.test(f)) return null;
  // The numbered rows: "1. Sign in with ChatGPT", "2. Sign in with Device Code", "3. Provide your own API key".
  const opts: string[] = [];
  for (const m of plain(text).matchAll(/^\s*>?\s*(\d)\.\s+(.+?)\s*$/gm)) opts.push(m[2].trim());
  if (opts.length === 0) return null;
  // A device-code screen carries numbered steps too; it is the more specific
  // state and wins in codexPaneAuth — here we only refuse to call steps a chooser.
  if (/Enter this one-time code/i.test(f)) return null;
  return opts;
}

export function codexDeviceLogin(text: string): { url: string; code: string; expiresMinutes: number | null } | null {
  const f = flat(text);
  if (!/Finish signing in via your browser|one-time code/i.test(f)) return null;
  const url = /(https?:\/\/[a-z0-9.-]*openai\.com\/[^\s]*device[^\s]*)/i.exec(f)?.[1] ?? null;
  // The code is on its own line: letters/digits in groups joined by a dash.
  const code = /^\s*([A-Z0-9]{3,8}-[A-Z0-9]{3,8})\s*$/m.exec(plain(text))?.[1] ?? null;
  if (!url || !code) return null;
  const exp = /expires in (\d+) minutes?/i.exec(f);
  return { url: url.replace(/[)\].,;]+$/, ""), code, expiresMinutes: exp ? Number(exp[1]) : null };
}

export function codexContinueScreen(text: string): boolean {
  const f = flat(text);
  if (!/Press enter to continue/i.test(f)) return false;
  // Not the chooser (a decision) and not a device screen (needs the browser).
  if (/Sign in with ChatGPT/i.test(f) && /\d\.\s*Sign in/i.test(f)) return false;
  if (/one-time code/i.test(f)) return false;
  return /Before you start|Signed in with your ChatGPT account|Decide how much autonomy/i.test(f);
}

export function codexAuthBroken(text: string): string | null {
  const f = flat(text);
  const m = /(Your access token could not be refreshed[^.]*\.\s*Please log out and sign in again\.?|Please log out and sign in again\.?|not logged in\b[^.]*\.?)/i.exec(f);
  return m ? m[1].trim().slice(0, 200) : null;
}

/** The one auth state the pane shows now, most specific first, or null for a
 *  conversation pane. `broken` is only reported when the pane is otherwise a
 *  conversation: once a sign-in screen is up, that is the state. */
export function codexPaneAuth(text: string): CodexPaneAuth | null {
  const device = codexDeviceLogin(text);
  if (device) return { kind: "device", ...device };
  const chooser = codexSignInChooser(text);
  if (chooser) return { kind: "chooser", options: chooser };
  if (codexContinueScreen(text)) return { kind: "continue" };
  const broken = codexAuthBroken(text);
  if (broken) return { kind: "broken", message: broken };
  return null;
}
