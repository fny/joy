// Parses the pseudo-XML blocks the Claude Code harness injects into the
// conversation as user messages — things the plain markdown renderer would
// otherwise show as raw `<tag>` noise.
//
// Handled:
//   <task-notification> … </task-notification>  → a card (status + summary)
//   <system-reminder>  … </system-reminder>     → stripped (machine context)
//   any other unknown top-level <tag>…</tag>     → collapsed to a generic chip
//
// Anything else passes through untouched as { kind: 'none', text }.

export type HarnessBlock =
    | { kind: 'task-notification'; status: string; summary: string; outputFile?: string }
    | { kind: 'unknown-block'; tag: string; text: string }
    | { kind: 'none'; text: string };

function pick(tag: string, s: string): string | undefined {
    const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(s);
    return m ? m[1].trim() : undefined;
}

// A top-level tag name at the very start of the (trimmed) text, e.g.
// "<task-notification>" → "task-notification". Tag chars: letters, digits, _ -.
const LEADING_TAG_RE = /^<([a-zA-Z][\w-]*)>/;

// Machine-only blocks that should never reach the user: system reminders plus
// the CLI's bash/local-command input+output wrappers (the pane shows bash).
const NOISE_BLOCK_RE = /<(system-reminder|bash-input|bash-stdout|bash-stderr|local-command-stdout|local-command-stderr|local-command-caveat)>[\s\S]*?<\/\1>\s*/g;

export function parseHarnessBlock(raw: string): HarnessBlock {
    // Strip machine-only blocks (often prepended to a real prompt).
    const text = raw.replace(NOISE_BLOCK_RE, '').trim();

    // Background task completion → card.
    if (text.startsWith('<task-notification>')) {
        const body = pick('task-notification', text) ?? '';
        return {
            kind: 'task-notification',
            status: pick('status', body) ?? 'done',
            summary: pick('summary', body) ?? 'Background task finished',
            outputFile: pick('output-file', body),
        };
    }

    // Any other block that's just `<tag>…</tag>` (whole message) → generic chip,
    // so unknown harness blocks never render as raw XML. Skips known
    // command/caveat wrappers, which parseLocalCommandMessage handles.
    const lead = LEADING_TAG_RE.exec(text);
    if (lead) {
        const tag = lead[1];
        const known = ['command-name', 'command-message', 'command-args', 'local-command-caveat', 'local-command-stdout', 'local-command-stderr', 'bash-input', 'bash-stdout', 'bash-stderr'];
        if (!known.includes(tag) && new RegExp(`</${tag}>\\s*$`).test(text)) {
            return { kind: 'unknown-block', tag, text: (pick(tag, text) ?? '').trim() };
        }
    }

    return { kind: 'none', text };
}
