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
const FENCE = /^(`{3,}|~{3,})/;

/**
 * Split the changelog into releases on `# ` headings — but only headings
 * that sit OUTSIDE a fenced code block.
 *
 * #350: the previous `content.split(/^# /gm)` treated a shell comment such
 * as `# Configure the client` inside a ``` fence as a release heading: it
 * truncated the real release's markdown and fabricated a release titled
 * "Configure the client". A fence-aware line scanner keeps each body whole.
 * Fences follow CommonMark: an opening fence of N backticks/tildes is
 * closed only by a fence of the same character with at least N marks.
 */
export function parseChangelogContent(content: string): ChangelogData {
    const lines = content.split('\n');
    const sections: { title: string; bodyLines: string[] }[] = [];
    let openFence: { char: string; length: number } | null = null;

    for (const rawLine of lines) {
        const line = rawLine.replace(/\r$/, '');
        const fence = line.trimStart().match(FENCE);
        if (fence) {
            const marks = fence[1];
            if (!openFence) {
                openFence = { char: marks[0], length: marks.length };
            } else if (marks[0] === openFence.char && marks.length >= openFence.length) {
                openFence = null;
            }
            sections.at(-1)?.bodyLines.push(line);
            continue;
        }

        const heading = !openFence && line.match(RELEASE_HEADING);
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
