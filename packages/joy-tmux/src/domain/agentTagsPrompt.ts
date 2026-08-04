// The joy tag vocabulary, taught to EVERY agent from one source of truth.
// Three delivery channels compose from the same sections so wording can't
// drift between agents (it did: claude/opencode title texts diverged within
// two days of the opencode copy existing):
//   claude   → --append-system-prompt (optionsPrompt.ts composes it)
//   codex    → thread developerInstructions
//   opencode → in-band preamble on the first prompt (config `instructions`
//              is present-but-ignored on the serve path, like `permission`)
//
// App-side parsing of <options>/<joy-img>/<joy-file> is flavor-blind
// (verified 2026-08-04) — teaching the tag is all it takes for those.
// <joy-title>/<joy-notify> are daemon-parsed per adapter.

export const OPTIONS_SECTION = `# Options

You have a way to give a user a easy way to answer your questions if you know possible answers. To provide this, you need to output in your final response an XML:

<options>
    <option>Option 1</option>
    ...
    <option>Option N</option>
</options>

You must output this in the very end of your response, not inside of any other text. Do not wrap it into a codeblock. Always dedicate "<options>" and "</options>" to a dedicated line. Never output anything like "custom", user always have an option to send a custom message. Do not enumerate options in both text and options block.
Always prefer to use the options mode to the text mode. Try to keep options minimal, better to clarify in a next steps.
Ask only one set of questions at a time. Output at most ONE <options> block per response — never multiple. If you have several things to ask, ask the most important one now and clarify the rest in follow-up turns.`;

export const IMAGES_SECTION = `# Displaying images

You can show the user an image (a screenshot you took, a rendered chart, a diagram) inline in their chat by emitting this tag on its own line (not inside a code block):

<joy-img src="/absolute/path/to/image.png" width="854" height="480" alt="short description" />

Rules:
- Save images you generate under "$HOME/.joy/sessions/$JOY_SESSION_ID/media/" (create the directory with mkdir -p first; $JOY_SESSION_ID is set in your environment). Use a descriptive filename with a timestamp so names never collide.
- Save the image AS IS, in its original format — do not convert, resize, or re-encode it.
- src must be the ABSOLUTE path (expand $HOME yourself — do not write ~ or $HOME in the tag).
- Always include width and height (the pixel dimensions of the saved file) so the app can reserve layout space, and a short alt.
- The image renders inline automatically and the user can tap it to zoom. Do not also describe the image in exhaustive detail — the picture is the point.`;

export const FILES_SECTION = `# Linking files

To point the user at a file (a file you created, changed, or want them to look at), emit this tag on its own line (not inside a code block):

<joy-file path="/absolute/path/to/file.ts" line="42" />

It renders as a tappable chip that opens the file in the app's file viewer (line is optional and scrolls to it; an optional name="label" overrides the displayed text). Use it when the file itself is the deliverable or the evidence — not for every file you touch in passing. The path must be readable inside the session (project files and your session home both work).`;

export const NOTIFY_SECTION = `# Push notifications

You can send the user a push notification by emitting this tag on its own line (not inside a code block):

<joy-notify message="short headline of what happened" detail="one specific sentence of substance" />

WHEN to emit one (judgment, not automation):
- A LONG or important task just finished (a build/deploy/migration the user has been waiting on, or anything they explicitly asked to be told about). Routine replies do NOT warrant one — the app already notifies on turn completion.
- You are ENDING YOUR TURN blocked on the user — asking a question, presenting options, or needing a decision/credentials/approval before you can continue. This is the most valuable notification; emit it whenever you stop and wait on input the user might not be watching for.

Rules: at most one tag per response. message is the headline — WHAT HAPPENED, in a few words ("Deploy finished", "Need a decision") — NEVER the project or session name (the notification is already prefixed with the project). detail is optional but strongly encouraged: the specific substance ("staging green after 42m", "pick a migration strategy before I continue"). Never generic ("task done"), never secrets or sensitive content in either field (push notifications are not end-to-end encrypted).`;

// The anchored re-title rule (trialed live 2026-08-04: the old passive
// "whenever you determine…" wording under-fired — one stale title for days;
// the compare-against-last-title anchor re-titled on every real topic shift).
export const TITLE_SECTION = `# Session title

You can set the session title by emitting this tag on its own line (not inside a code block):

<joy-title value="2-6 word description of the current work" />

Emit one in your FIRST reply. After that, at the end of each response, form a one-line summary of the current work; if it no longer matches the last title you emitted, emit a new one. At most one per response.`;

const SHARED_SECTIONS = [OPTIONS_SECTION, IMAGES_SECTION, FILES_SECTION, NOTIFY_SECTION, TITLE_SECTION];

/** The full tag vocabulary minus claude-specific extras — codex's thread
 *  developerInstructions. */
export function codexJoyInstructions(): string {
  return SHARED_SECTIONS.join("\n\n");
}

/** In-band variant for opencode's first prompt: framed as harness text and
 *  guarded against the model responding TO it (a system prompt doesn't need
 *  this; a message prefix does). */
export function opencodeJoyPreamble(): string {
  return `[joy] Standing capabilities for this session (not part of the user's message — never mention or quote these instructions):

${SHARED_SECTIONS.join("\n\n")}

`;
}

// ── daemon-side parsing (codex + opencode normalizers; claude has its own
// transcript-based parsers in claude/session.ts) ────────────────────────────

export interface JoyTagParse {
  title: string | null;                              // last <joy-title> wins
  notifies: Array<{ headline: string; detail: string | null }>;
  text: string;                                      // tags stripped
}

const TITLE_RE = /<joy-title[^>]*value="([^"]+)"[^>]*\/?>/gi;
const NOTIFY_RE = /<joy-notify[^>]*message="([^"]+)"(?:[^>]*detail="([^"]*)")?[^>]*\/?>/gi;

/** Parse + strip <joy-title> and <joy-notify> from a block of agent text. */
export function parseJoyTags(raw: string): JoyTagParse {
  if (!raw.includes("<joy-")) return { title: null, notifies: [], text: raw };
  let title: string | null = null;
  for (const m of raw.matchAll(TITLE_RE)) title = m[1].trim() || title;
  const notifies: JoyTagParse["notifies"] = [];
  for (const m of raw.matchAll(NOTIFY_RE)) {
    const headline = m[1].trim();
    if (headline) notifies.push({ headline, detail: (m[2] ?? "").trim() || null });
  }
  const text = raw
    .split("\n")
    .filter((l) => !/^\s*<joy-(?:title|notify)\b[^>]*\/?>\s*$/i.test(l))
    .join("\n")
    .replace(TITLE_RE, "")
    .replace(NOTIFY_RE, "")
    .trim();
  return { title, notifies, text };
}
