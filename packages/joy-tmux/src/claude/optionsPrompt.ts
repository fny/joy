import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// Mirrors joy-app's sources/sync/prompt/systemPrompt.ts. The happy app injects
// this per-message via the SDK so Claude emits <options>…</options> blocks that
// the app renders as a tap-to-pick options card. A plain Claude Code terminal
// can't receive a per-message system prompt, so we instead bake this into the
// session at launch with `--append-system-prompt`.
export const OPTIONS_SYSTEM_PROMPT = `# Options

You have a way to give a user a easy way to answer your questions if you know possible answers. To provide this, you need to output in your final response an XML:

<options>
    <option>Option 1</option>
    ...
    <option>Option N</option>
</options>

You must output this in the very end of your response, not inside of any other text. Do not wrap it into a codeblock. Always dedicate "<options>" and "</options>" to a dedicated line. Never output anything like "custom", user always have an option to send a custom message. Do not enumerate options in both text and options block.
Always prefer to use the options mode to the text mode. Try to keep options minimal, better to clarify in a next steps.

# Plan mode with options

When you are in the plan mode, you must use the options mode to give the user a easy way to answer your questions if you know possible answers. Do not assume what is needed, when there is discrepancy between what you need and what you have, you must use the options mode.`;

// Persist the prompt and return a shell token that reads it at launch time —
// avoids escaping a multi-line, quote-laden prompt on the command line.
export function optionsPromptArg(baseDir = join(homedir(), ".happy", "joy-tmux-state")): string {
  const path = join(baseDir, "options-system-prompt.txt");
  try {
    mkdirSync(baseDir, { recursive: true });
    writeFileSync(path, OPTIONS_SYSTEM_PROMPT);
  } catch (e) {
    process.stderr.write(`[options-prompt] failed to write: ${e}\n`);
  }
  return `"$(cat '${path}')"`;
}
