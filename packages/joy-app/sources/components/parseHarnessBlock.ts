// Parses the pseudo-XML blocks the Claude Code harness injects into the
// conversation as user messages — things the plain markdown renderer would
// otherwise show as raw `<tag>` noise.
//
// Handled:
//   <task-notification> … </task-notification>  → a card (status + summary)
//   <system-reminder>  … </system-reminder>     → stripped (machine context)
//   any other unknown top-level <tag>…</tag>     → collapsed to a generic chip
//
// A block collapses to a card/chip only when it IS the whole message. A
// notification followed by a real prompt (or by a second notification) used
// to return only the first block, silently dropping the prompt and the other
// notification (#269); now the notifications become readable lines and every
// other character of the message survives as text.
//
// Anything else passes through untouched as { kind: 'none', text }.

import { t } from '@/text';
import { exceedsInputBudget } from '@/utils/parseBudget';
import { replaceOutsideCode } from './markdown/codeRanges';

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

// Trailing whitespace is part of the match so a block replaced by a line keeps
// exactly one line break before whatever follows it.
const TASK_NOTIFICATION_RE = /<task-notification>([\s\S]*?)<\/task-notification>\s*/g;

/**
 * Remove every complete noise block that is NOT inside markdown code. A user
 * asking to "explain this fenced <system-reminder> example" had the example's
 * body deleted, leaving an empty fence (#270): quoted content is the user's,
 * only the harness's own top-level blocks are machine context. The same
 * rule guards EVERY rewrite below (replaceOutsideCode), not just this one.
 */
function stripNoiseBlocks(raw: string): string {
    return replaceOutsideCode(raw, NOISE_BLOCK_RE, () => '');
}

function parseTaskNotification(body: string): { status: string; summary: string; outputFile?: string } {
    return {
        status: pick('status', body) ?? 'done',
        summary: pick('summary', body) ?? 'Background task finished',
        outputFile: pick('output-file', body),
    };
}

export function parseHarnessBlock(raw: string): HarnessBlock {
    // Past the shared input cap the message is shown verbatim, like every
    // other decorating parser (utils/parseBudget): the rewrites below are
    // linear, but the cap keeps their cost bounded by one policy.
    if (exceedsInputBudget(raw)) {
        return { kind: 'none', text: raw };
    }

    // Strip machine-only blocks (often prepended to a real prompt).
    const text = stripNoiseBlocks(raw).trim();

    // Background task completion → card, when the notification is the message.
    if (text.startsWith('<task-notification>')) {
        TASK_NOTIFICATION_RE.lastIndex = 0;
        const first = TASK_NOTIFICATION_RE.exec(text);
        if (first && first.index === 0 && first[0].trimEnd().length === text.length) {
            return { kind: 'task-notification', ...parseTaskNotification(first[1]) };
        }
        // Mixed: several notifications, or a notification plus a real prompt.
        // Each block becomes one line; the rest of the message is kept
        // verbatim — including a fenced <task-notification> example, which
        // a global replace rewrote along with the real one (#270).
        const lines = replaceOutsideCode(text, TASK_NOTIFICATION_RE, (m) => {
            const n = parseTaskNotification(m[1]);
            return `${t('markdown.taskNotificationLine', { status: n.status, summary: n.summary })}\n`;
        }).trim();
        return { kind: 'none', text: lines };
    }

    // Any other block that's just `<tag>…</tag>` (whole message) → generic chip,
    // so unknown harness blocks never render as raw XML. Skips known
    // command/caveat wrappers, which parseLocalCommandMessage handles. The
    // opening and closing tags must belong to ONE block: with two blocks
    // around prose the first `</tag>` is not the one at the end, and the
    // message stays text (#269).
    const lead = LEADING_TAG_RE.exec(text);
    if (lead) {
        const tag = lead[1];
        const known = ['command-name', 'command-message', 'command-args', 'local-command-caveat', 'local-command-stdout', 'local-command-stderr', 'bash-input', 'bash-stdout', 'bash-stderr'];
        if (!known.includes(tag)) {
            const closeTag = `</${tag}>`;
            const firstClose = text.indexOf(closeTag);
            if (firstClose !== -1 && text.slice(firstClose + closeTag.length).trim() === '') {
                return { kind: 'unknown-block', tag, text: text.slice(lead[0].length, firstClose).trim() };
            }
        }
    }

    return { kind: 'none', text };
}
