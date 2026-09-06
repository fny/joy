import type { MarkdownBlock, MarkdownSpan } from "./parseMarkdown";
import { parseMarkdownSpans } from "./parseMarkdownSpans";
import { exceedsInputBudget, parseBudget, type ParseBudget } from "@/utils/parseBudget";

const OPTIONS_OPEN = '<joy-options>';
const OPTIONS_CLOSE = '</joy-options>';
const OPTION_OPEN = '<joy-option>';
const OPTION_CLOSE = '</joy-option>';

function plainBlock(text: string): MarkdownBlock {
    return { type: 'text', content: [{ styles: [], text, url: null }] };
}

// Complete <joy-option>…</joy-option> items in `body`, and the text after
// the last of them (the whole body when there is none).
function extractOptions(body: string): { items: string[]; rest: string } {
    const items: string[] = [];
    const optionRe = /<joy-option>([\s\S]*?)<\/joy-option>/g;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = optionRe.exec(body)) !== null) {
        items.push(m[1]);
        last = m.index + m[0].length;
    }
    return { items, rest: body.slice(last) };
}

// A `<joy-option>` opened on the LAST line of the input and not yet closed
// is an option still streaming in: it is dropped, not shown as raw text.
// Only the text from that opener on is dropped — an unclosed opener on an
// earlier line is malformed, and the text after it is real content (#264).
function stripInFlightOption(text: string): string {
    const at = text.lastIndexOf(OPTION_OPEN);
    if (at === -1 || text.includes(OPTION_CLOSE, at) || text.includes('\n', at)) return text;
    return text.slice(0, at);
}

// Split a pipe-delimited table row into cells, stripping only the leading/trailing
// empty strings caused by outer pipes while preserving interior empty cells.
// Only an UNESCAPED pipe delimits: `a\|b` is one cell reading "a|b" (#262) —
// the split used to shear it into "a\" and "b" and shift every later column.
function splitTableRow(line: string): string[] {
    const cells: string[] = [];
    let cell = '';
    const trimmed = line.trim();
    for (let i = 0; i < trimmed.length; i++) {
        const c = trimmed[i];
        if (c === '\\' && trimmed[i + 1] === '|') {
            cell += '|';
            i++;
        } else if (c === '|') {
            cells.push(cell.trim());
            cell = '';
        } else {
            cell += c;
        }
    }
    cells.push(cell.trim());
    if (cells.length > 0 && cells[0] === '') cells.shift();
    if (cells.length > 0 && cells[cells.length - 1] === '') cells.pop();
    return cells;
}

function isTableSeparatorLine(line: string): boolean {
    const trimmed = line.trim();
    return /^[|\s\-:=]*$/.test(trimmed) && trimmed.includes('-');
}

function parseTable(lines: string[], startIndex: number, budget: ParseBudget): { table: MarkdownBlock | null; nextIndex: number } {
    // Decide BEFORE collecting: a table is a header line whose next pipe
    // line (blank lines between them tolerated, as below) is the separator.
    // Collecting the whole pipe run first and checking afterwards made every
    // failed candidate re-scan the run — `a|b` repeated N times cost O(N²)
    // (#622). The cheap check here is exactly what the post-collection check
    // used to require: tableLines[1] exists, holds a pipe, and is a separator.
    let second = startIndex + 1;
    while (second < lines.length && lines[second].trim() === '') second++;
    if (second >= lines.length || !lines[second].includes('|') || !isTableSeparatorLine(lines[second])) {
        return { table: null, nextIndex: startIndex };
    }

    let index = startIndex;
    const tableLines: string[] = [];

    // Collect consecutive lines that contain pipe characters, skipping blank lines
    // that LLMs often insert between table rows. A blank gap followed by a NEW
    // header/separator pair starts a second table, not more rows of this one —
    // otherwise its cells landed under the first table's headers (#265).
    // One budget unit per collected row, and one per skipped blank line: a
    // table is consumed once it is found, so total table work is linear in
    // the input. A blank run is inspected ONCE and then stepped over whole —
    // advancing by a single line re-scanned the same run from every line in
    // it, quadratic in the run and unpaid for (40k blank lines: 12s, #622).
    while (index < lines.length) {
        if (lines[index].includes('|')) {
            if (!budget.spend()) break;
            tableLines.push(lines[index]);
            index++;
        } else if (lines[index].trim() === '') {
            let next = index;
            while (next < lines.length && lines[next].trim() === '') next++;
            if (!budget.spend(next - index)) break;
            if (
                tableLines.length >= 2
                && next + 1 < lines.length
                && lines[next].includes('|')
                && isTableSeparatorLine(lines[next + 1])
            ) {
                index = next;
                break;
            }
            index = next;
        } else {
            break;
        }
    }

    if (tableLines.length < 2) {
        return { table: null, nextIndex: startIndex };
    }

    // Validate that the second line is a separator containing dashes, which distinguishes tables from plain text
    if (!isTableSeparatorLine(tableLines[1])) {
        return { table: null, nextIndex: startIndex };
    }

    const headers = splitTableRow(tableLines[0])
        .map(cell => parseMarkdownSpans(cell, false));

    if (headers.length === 0) {
        return { table: null, nextIndex: startIndex };
    }

    // Extract data rows from remaining lines (skipping the separator line)
    const rows: MarkdownSpan[][][] = [];
    for (let i = 2; i < tableLines.length; i++) {
        const rowCells = splitTableRow(tableLines[i])
            .map(cell => parseMarkdownSpans(cell, false));
        if (rowCells.length > 0) {
            rows.push(rowCells);
        }
    }

    const table: MarkdownBlock = {
        type: 'table',
        headers,
        rows
    };

    return { table, nextIndex: index };
}

export function parseMarkdownBlock(markdown: string) {
    const blocks: MarkdownBlock[] = [];
    // Plain-text fallback past the input cap, like every other UI-thread
    // parser (utils/parseBudget): the text is still shown, undecorated.
    if (exceedsInputBudget(markdown)) {
        blocks.push(plainBlock(markdown));
        return blocks;
    }
    const budget = parseBudget();
    const lines = markdown.split('\n');
    let index = 0;
    // Options-region memo (#264). The first opener with no closer scans to
    // the end of the input; every later opener is then known to have no
    // closer either, and where the last option tags sit, so each line is
    // scanned once however many stray openers precede it.
    let noCloserFrom = lines.length;
    let lastOptionOpenLine = -1;
    let lastItemCloseLine = -1;
    outer: while (index < lines.length) {
        const line = lines[index];
        index++;

        // Headers
        for (let i = 1; i <= 6; i++) {
            if (line.startsWith(`${'#'.repeat(i)} `)) {
                blocks.push({ type: 'header', level: i as 1 | 2 | 3 | 4 | 5 | 6, content: parseMarkdownSpans(line.slice(i + 1).trim(), true) });
                continue outer;
            }
        }

        // Trim
        let trimmed = line.trim();

        // Options block. MUST come before the joy-control-tag stripper below: a
        // bare `<joy-options>` line matches that stripper's pattern, so with the
        // stripper first the opener was dropped and every `<joy-option>…` line
        // fell through as raw text (regression 2026-07-01, e91c3587).
        if (trimmed.startsWith(OPTIONS_OPEN)) {
            // The block may be written inline (`<joy-options><joy-option>Yes
            // </joy-option></joy-options> explanation…`) or one tag per line.
            // The region runs from the opener through the line holding the
            // closer; text AFTER the closer on that line is parsed like any
            // line. Looking only at the FOLLOWING lines for options and a
            // standalone closer swallowed the whole rest of the message (#264).
            //
            // Every region is parsed ONCE and the lines array never grows:
            // leftover text is written back into the slot it came from and
            // the loop re-reads that slot. The previous fallback appended the
            // consumed remainder back onto the array, so repeated stray
            // openers rescanned and copied shrinking suffixes quadratically.
            //
            // No closer: the block is still streaming, or malformed. Only the
            // complete options are consumed (through the line holding the
            // last `</joy-option>`), plus an option opened on the final line
            // that is still in flight. Everything else — an instruction after
            // the options, a closed block that holds prose but no option — is
            // ordinary content, not swallowed.
            const openerLine = index - 1;
            // One unit per region, plus one per KB of the opener line: the
            // leftover of an inline block is re-read from its slot, so a
            // long line of inline blocks costs its length per block.
            if (!budget.spend(1 + (trimmed.length >> 10))) {
                blocks.push(plainBlock(lines.slice(openerLine).join('\n')));
                break;
            }
            let closerLine = -1;
            if (openerLine < noCloserFrom) {
                let optionOpen = -1;
                let itemClose = -1;
                let i = openerLine;
                for (; i < lines.length; i++) {
                    const scanned = lines[i];
                    if (scanned.includes(OPTIONS_CLOSE)) break;
                    if (scanned.includes(OPTION_OPEN)) optionOpen = i;
                    if (scanned.includes(OPTION_CLOSE)) itemClose = i;
                }
                if (i < lines.length) {
                    closerLine = i;
                } else {
                    noCloserFrom = openerLine;
                    lastOptionOpenLine = optionOpen;
                    lastItemCloseLine = itemClose;
                }
            }
            const regionText = (to: number) =>
                to === openerLine ? trimmed : [trimmed, ...lines.slice(openerLine + 1, to + 1)].join('\n');
            const lastLine = lines.length - 1;

            if (closerLine !== -1) {
                const region = regionText(closerLine);
                const closeAt = region.indexOf(OPTIONS_CLOSE);
                const body = region.slice(OPTIONS_OPEN.length, closeAt);
                const after = region.slice(closeAt + OPTIONS_CLOSE.length);
                const { items } = extractOptions(body);
                let leftover: string;
                if (items.length > 0) {
                    blocks.push({ type: 'options', items });
                    leftover = after;
                } else if (closerLine === openerLine) {
                    // Not a block after all: only the two tags are dropped.
                    leftover = `${body}${after}`;
                } else {
                    // Same, across lines: the interior lines are parsed by the
                    // loop as they are; only the closer tag is blanked out.
                    lines[closerLine] = lines[closerLine].replace(OPTIONS_CLOSE, '');
                    leftover = body.slice(0, body.indexOf('\n'));
                    closerLine = openerLine;
                }
                index = closerLine + 1;
                if (leftover.trim()) {
                    lines[closerLine] = leftover.trim();
                    index = closerLine;
                }
                continue;
            }

            // Complete items can only exist up to the last `</joy-option>`;
            // when that region holds none, no later region does either
            // (extraction runs once, not once per stray opener).
            const regionEnd = Math.max(openerLine, lastItemCloseLine);
            const { items, rest } = lastItemCloseLine >= openerLine
                ? extractOptions(regionText(regionEnd).slice(OPTIONS_OPEN.length))
                : { items: [] as string[], rest: '' };
            if (items.length === 0) lastItemCloseLine = -1;
            // Lines of the region after the last complete item are left to the
            // loop untouched; only the item line's remainder is re-read.
            let restLines = 0;
            for (let i = 0; i < rest.length; i++) if (rest.charCodeAt(i) === 10) restLines++;
            const consumedTo = items.length > 0 ? regionEnd - restLines : openerLine;
            let leftover = items.length > 0
                ? (restLines > 0 ? rest.slice(0, rest.indexOf('\n')) : rest)
                : trimmed.slice(OPTIONS_OPEN.length);
            if (lastOptionOpenLine === lastLine) {
                if (consumedTo === lastLine) {
                    leftover = stripInFlightOption(leftover);
                } else {
                    lines[lastLine] = stripInFlightOption(lines[lastLine]);
                }
                lastOptionOpenLine = -1; // handled once, never rescanned
            }
            if (items.length > 0) {
                blocks.push({ type: 'options', items });
            }
            index = consumedTo + 1;
            if (leftover.trim()) {
                lines[consumedTo] = leftover.trim();
                index = consumedTo;
            }
            continue;
        }

        // Ignore joy control tags (e.g. <joy-bg … />) on their OWN line — they're
        // daemon-consumed and never shown. Line-level, not global: the ``` handler
        // below already consumed code blocks, so a fenced/inline example of the tag
        // (like this one) survives; only a bare own-line tag is dropped.
        if (/^<\/?joy-[\w-]+\b[^>]*>$/.test(trimmed)) {
            continue;
        }

        // Code block
        if (trimmed.startsWith('```')) {
            // A fence closes only on a backtick run at least as long as the
            // one that opened it, so a ```` block can quote a ``` example
            // (#263) — the old exact-``` check ended the outer block at the
            // inner fence and turned the real closer into a second block.
            const fenceSize = trimmed.match(/^`+/)![0].length;
            const language = trimmed.slice(fenceSize).trim() || null;
            let content = [];
            while (index < lines.length) {
                const nextLine = lines[index];
                const closer = nextLine.trim().match(/^`+$/);
                if (closer && closer[0].length >= fenceSize) {
                    index++;
                    break;
                }
                content.push(nextLine);
                index++;
            }
            const contentString = content.join('\n');

            // Detect mermaid diagram language and route to appropriate block type
            if (language === 'mermaid') {
                blocks.push({ type: 'mermaid', content: contentString });
            } else {
                blocks.push({ type: 'code-block', language, content: contentString });
            }
            continue;
        }

        // Horizontal rule
        if (trimmed === '---') {
            blocks.push({ type: 'horizontal-rule' });
            continue;
        }

        // Blockquote: consecutive '>'-prefixed lines fold into one quote block.
        // A bare '>' inside the run is a blank quoted line (paragraph break).
        if (trimmed.startsWith('>')) {
            const quoteLines: ReturnType<typeof parseMarkdownSpans>[] = [];
            let cur = trimmed;
            while (true) {
                quoteLines.push(parseMarkdownSpans(cur.replace(/^>\s?/, ''), false));
                if (index >= lines.length) break;
                const next = lines[index].trim();
                if (!next.startsWith('>')) break;
                cur = next;
                index++;
            }
            blocks.push({ type: 'quote', lines: quoteLines });
            continue;
        }

        // Image block
        const imageMatch = trimmed.match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
        if (imageMatch) {
            blocks.push({ type: 'image', alt: imageMatch[1], url: imageMatch[2].trim() });
            continue;
        }

        // If it is a numbered list
        const numberedListMatch = trimmed.match(/^(\d+)\.\s+/);
        if (numberedListMatch) {
            const indent = line.length - line.trimStart().length;
            let allLines = [{ number: parseInt(numberedListMatch[1]), indent, content: trimmed.slice(numberedListMatch[0].length) }];
            while (index < lines.length) {
                const nextRaw = lines[index];
                const nextTrimmed = nextRaw.trim();
                const nextMatch = nextTrimmed.match(/^(\d+)\.\s+/);
                if (!nextMatch) break;
                const nextIndent = nextRaw.length - nextRaw.trimStart().length;
                allLines.push({ number: parseInt(nextMatch[1]), indent: nextIndent, content: nextTrimmed.slice(nextMatch[0].length) });
                index++;
            }
            const baseIndent = allLines[0].indent;
            blocks.push({ type: 'numbered-list', items: allLines.map((l) => ({ number: l.number, depth: Math.floor((l.indent - baseIndent) / 2), spans: parseMarkdownSpans(l.content, false) })) });
            continue;
        }

        // If it is a list
        const listMatch = trimmed.match(/^([-*+])\s+/);
        if (listMatch) {
            const indent = line.length - line.trimStart().length;
            let allLines = [{ indent, content: trimmed.slice(listMatch[0].length) }];
            while (index < lines.length) {
                const nextRaw = lines[index];
                const nextTrimmed = nextRaw.trim();
                const nextMatch = nextTrimmed.match(/^([-*+])\s+/);
                if (!nextMatch) break;
                const nextIndent = nextRaw.length - nextRaw.trimStart().length;
                allLines.push({ indent: nextIndent, content: nextTrimmed.slice(nextMatch[0].length) });
                index++;
            }
            const baseIndent = allLines[0].indent;
            blocks.push({ type: 'list', items: allLines.map((l) => ({ depth: Math.floor((l.indent - baseIndent) / 2), spans: parseMarkdownSpans(l.content, false) })) });
            continue;
        }

        // Check for table
        if (trimmed.includes('|') && !trimmed.startsWith('```')) {
            const { table, nextIndex } = parseTable(lines, index - 1, budget);
            if (table) {
                blocks.push(table);
                index = nextIndex;
                continue outer;
            }
        }

        // Fallback
        if (trimmed.length > 0) {
            blocks.push({ type: 'text', content: parseMarkdownSpans(trimmed, false) });
        }
    }
    return blocks;
}
