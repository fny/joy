import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { joyStateDir } from "../paths";

// Mirrors joy-app's sources/sync/prompt/systemPrompt.ts. The joy app injects
// this per-message via the SDK so Claude emits <joy-options>…</joy-options> blocks that
// the app renders as a tap-to-pick options card. A plain Claude Code terminal
// can't receive a per-message system prompt, so we instead bake this into the
// session at launch with `--append-system-prompt`.
import { OPTIONS_SECTION, IMAGES_SECTION, FILES_SECTION, NOTIFY_SECTION, TITLE_SECTION, PEERS_SECTION, CLI_SECTION } from "../domain/agentTagsPrompt";

// Claude-only extras layered onto the shared tag sections (agentTagsPrompt.ts
// is the single source of truth for the cross-agent wording).
const CLAUDE_EXTRAS = `# Plan mode with options

When you are in the plan mode, you must use the options mode to give the user a easy way to answer your questions if you know possible answers. Do not assume what is needed, when there is discrepancy between what you need and what you have, you must use the options mode.

# Never use the AskUserQuestion tool

Do NOT call the AskUserQuestion tool. It renders an interactive picker that the user CANNOT answer in this environment — it freezes the session. Whenever you would ask the user anything, write the question as plain text in your response and put the possible answers in an <joy-options> block at the very end (as described above). This applies always, including in plan mode.

# Long-running background processes

When you start a command with run_in_background that is expected to KEEP RUNNING until something explicitly stops it — a server, daemon, or persistent watcher (e.g. a dev server like "npm run dev" or "vite", or "tail -f") — emit a single tag on its own line, using the background ID from that tool's result (the "Command running in background with ID: <id>" value):

<joy-bg id="<id>" long-running label="<short label>" />

Only emit this for processes that will NOT stop on their own. Do NOT emit it for background work that is expected to FINISH — a build, a test run, a one-shot script, a "watch" that will terminate, a "sleep", etc. Put the tag on its own line (not inside a code block), and keep the label short, e.g. label="Nuxt dev server".`;

export const OPTIONS_SYSTEM_PROMPT = [
  OPTIONS_SECTION,
  CLAUDE_EXTRAS,
  IMAGES_SECTION,
  FILES_SECTION,
  NOTIFY_SECTION,
  TITLE_SECTION,
  PEERS_SECTION,
  CLI_SECTION,
].join("\n\n");

// Persist the prompt and return a shell token that reads it at launch time —
// avoids escaping a multi-line, quote-laden prompt on the command line.
export function optionsPromptArg(baseDir = joyStateDir()): string {
  const path = join(baseDir, "options-system-prompt.txt");
  try {
    mkdirSync(baseDir, { recursive: true });
    writeFileSync(path, OPTIONS_SYSTEM_PROMPT);
  } catch (e) {
    process.stderr.write(`[options-prompt] failed to write: ${e}\n`);
  }
  return `"$(cat '${path}')"`;
}
