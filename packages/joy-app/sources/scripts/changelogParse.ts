/**
 * Pure CHANGELOG.md → entries parser, shared by scripts/parseChangelog.ts
 * (build-time) and its tests. No I/O here so it can run under vitest.
 */

export interface ChangelogEntry {
    title: string;
    summary: string;
    markdown: string;
}

export interface ChangelogData {
    entries: ChangelogEntry[];
    latestTitle: string;
}

const RELEASE_HEADING = /^# (.*)$/;
/** An opening fence: optional indentation, the marks, then the info string. */
const FENCE_OPEN = /^\s*(`{3,}|~{3,})(.*)$/;
/** A closing fence is the WHOLE line: optional indentation, the marks, and
 *  nothing but trailing whitespace. Anything after the marks makes it a line
 *  of code, not a closer — ```not-a-closing-fence inside a ``` block used
 *  to close it, so a `# Fake` on the next line became a release (#350). */
const FENCE_CLOSE = /^\s*(`{3,}|~{3,})\s*$/;

/**
 * Split the changelog into releases on `# ` headings — but only headings
 * that sit OUTSIDE a fenced code block.
 *
 * #350: the previous `content.split(/^# /gm)` treated a shell comment such
 * as `# Configure the client` inside a ``` fence as a release heading: it
 * truncated the real release's markdown and fabricated a release titled
 * "Configure the client". A fence-aware line scanner keeps each body whole.
 * Fences follow CommonMark: an opening fence of N backticks/tildes is
 * closed only by a fence of the same character with at least N marks that
 * stands alone on its line (indentation and trailing whitespace allowed); a
 * backtick opener's info string may not itself contain a backtick.
 */
export function parseChangelogContent(content: string): ChangelogData {
    const lines = content.split('\n');
    const sections: { title: string; bodyLines: string[] }[] = [];
    let openFence: { char: string; length: number } | null = null;

    for (const rawLine of lines) {
        const line = rawLine.replace(/\r$/, '');
        if (openFence) {
            const close = line.match(FENCE_CLOSE);
            if (close && close[1][0] === openFence.char && close[1].length >= openFence.length) {
                openFence = null;
            }
            sections.at(-1)?.bodyLines.push(line);
            continue;
        }
        const open = line.match(FENCE_OPEN);
        if (open && !(open[1][0] === '`' && open[2].includes('`'))) {
            openFence = { char: open[1][0], length: open[1].length };
            sections.at(-1)?.bodyLines.push(line);
            continue;
        }

        const heading = line.match(RELEASE_HEADING);
        if (heading) {
            sections.push({ title: heading[1].trim(), bodyLines: [] });
            continue;
        }
        // Text before the first release heading has nowhere to go (as before).
        sections.at(-1)?.bodyLines.push(line);
    }

    const entries: ChangelogEntry[] = [];
    for (const section of sections) {
        const body = section.bodyLines.join('\n').trim();
        if (!body) continue;

        // First non-empty line is the summary, rest is markdown
        const bodyLines = body.split('\n');
        let summary = '';
        let markdownStart = 0;

        for (let i = 0; i < bodyLines.length; i++) {
            const trimmed = bodyLines[i].trim();
            if (trimmed && !trimmed.startsWith('-')) {
                summary = trimmed;
                markdownStart = i + 1;
                break;
            } else if (trimmed.startsWith('-')) {
                // No summary, starts with bullets
                markdownStart = i;
                break;
            }
        }

        const markdown = bodyLines.slice(markdownStart).join('\n').trim();
        entries.push({ title: section.title, summary, markdown });
    }

    const latestTitle = entries.length > 0 ? entries[0].title : '';
    return { entries, latestTitle };
}
