import type { MarkdownSpan } from "./parseMarkdown";
import { exceedsInputBudget, parseBudget } from "@/utils/parseBudget";

// Inline pattern: bold, italic, link text, code. Every bracketed class is
// LINEAR: the link text is `[^\[\]]+`, not `[^\]]+` — with the latter, a run
// of unclosed "[" made each "[" rescan to the end of the input (quadratic —
// 50k brackets froze the app). The link DESTINATION is not in the pattern:
// scanLinkDestination reads it from the "(" that follows the "]".
const pattern = /(\*\*(.*?)(?:\*\*|$))|(\*(.*?)(?:\*|$))|(\[([^\[\]]+)\])|(`(.*?)(?:`|$))/g;

// A link destination is "(" … ")" with parentheses balanced to ANY depth and
// backslash escapes ("[x](https://a/b\)c)" keeps its ")"): a fixed-depth
// regex truncated "a_(b_(c))" and took an escaped ")" for the closer (#266).
// Stops at a newline. Bounded: past MAX_DESTINATION_DEPTH open parentheses
// the scan gives up, so "[x](" repeated cannot rescan the line from every
// fragment (each attempt reads at most a few hundred characters).
const MAX_DESTINATION_DEPTH = 32;

function scanLinkDestination(text: string, openAt: number): { url: string; end: number } | null {
    if (text.charCodeAt(openAt) !== 40 /* ( */) return null;
    let depth = 0;
    let i = openAt + 1;
    while (i < text.length) {
        const c = text[i];
        if (c === '\\' && i + 1 < text.length && text[i + 1] !== '\n') {
            i += 2;
            continue;
        }
        if (c === '\n') return null;
        if (c === '(') {
            depth++;
            if (depth > MAX_DESTINATION_DEPTH) return null;
        } else if (c === ')') {
            if (depth === 0) {
                // "[x]()" has no destination: the brackets stay text, as before.
                return i > openAt + 1 ? { url: text.slice(openAt + 1, i), end: i + 1 } : null;
            }
            depth--;
        }
        i++;
    }
    return null;
}

function countChar(text: string, ch: string): number {
    let n = 0;
    for (let i = 0; i < text.length; i++) if (text[i] === ch) n++;
    return n;
}

// Markdown lets a destination escape its parentheses: "[x](https://a/b\(c\))".
function unescapeLinkDestination(url: string): string {
    return url.replace(/\\([()])/g, '$1');
}

function pushTextWithAutoLinks(spans: MarkdownSpan[], text: string, styles: MarkdownSpan['styles']) {
    const urlPattern = /https?:\/\/[^\s<]+/g;
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = urlPattern.exec(text)) !== null) {
        const plainText = text.slice(lastIndex, match.index);
        if (plainText) {
            spans.push({ styles, text: plainText, url: null });
        }

        let url = match[0];
        let trailing = '';
        // Trailing punctuation belongs to the sentence, not the URL — except a
        // ")" that closes a "(" inside the URL (wikipedia's "Function_(mathematics)"),
        // which used to be stripped and left the link one character short (#266).
        while (/[),.;:!?]$/.test(url)) {
            if (url.endsWith(')') && countChar(url, '(') >= countChar(url, ')')) break;
            trailing = url.slice(-1) + trailing;
            url = url.slice(0, -1);
        }

        if (url) {
            spans.push({ styles, text: url, url });
        }
        if (trailing) {
            spans.push({ styles, text: trailing, url: null });
        }

        lastIndex = match.index + match[0].length;
    }

    if (lastIndex < text.length) {
        spans.push({ styles, text: text.slice(lastIndex), url: null });
    }
}

// [text](url) links NESTED inside an already-styled run (bold/italic). The
// top-level pattern consumes the whole **…** first and the inner content was
// only auto-linked — a markdown link inside bold rendered as raw "[text](url)"
// (seen live with "**[ENG-5297 — …](linear.app/…)**"). Re-parse links here;
// everything between them still gets the bare-URL auto-linking.
const nestedLinkTextPattern = /\[([^\[\]]+)\]/g;
function pushStyledContent(spans: MarkdownSpan[], text: string, styles: MarkdownSpan['styles']) {
    let last = 0;
    let m: RegExpExecArray | null;
    nestedLinkTextPattern.lastIndex = 0;
    while ((m = nestedLinkTextPattern.exec(text)) !== null) {
        const dest = scanLinkDestination(text, m.index + m[0].length);
        if (!dest) continue; // "[text]" without a destination stays plain text
        if (m.index > last) {
            pushTextWithAutoLinks(spans, text.slice(last, m.index), styles);
        }
        spans.push({ styles, text: m[1], url: unescapeLinkDestination(dest.url) });
        last = dest.end;
        nestedLinkTextPattern.lastIndex = dest.end;
    }
    if (last < text.length) {
        pushTextWithAutoLinks(spans, text.slice(last), styles);
    }
}

export function parseMarkdownSpans(markdown: string, header: boolean) {
    const spans: MarkdownSpan[] = [];

    // Plain-text fallback for absurdly long paragraphs: the whole text is
    // still shown, just undecorated (work budget, see utils/parseBudget).
    if (exceedsInputBudget(markdown)) {
        spans.push({ styles: [], text: markdown, url: null });
        return spans;
    }

    const budget = parseBudget();
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    pattern.lastIndex = 0;

    while ((match = pattern.exec(markdown)) !== null) {
        if (!budget.spend()) break; // the remainder is emitted as plain text below

        // Capture the text between the end of the last match and the start of this match as plain text
        const plainText = markdown.slice(lastIndex, match.index);
        if (plainText) {
            pushTextWithAutoLinks(spans, plainText, []);
        }

        if (match[1]) {
            // Bold
            pushStyledContent(spans, match[2], header ? [] : ['bold']);
        } else if (match[3]) {
            // Italic
            pushStyledContent(spans, match[4], header ? [] : ['italic']);
        } else if (match[5]) {
            // Link - handle incomplete links (no URL part)
            const dest = scanLinkDestination(markdown, pattern.lastIndex);
            if (dest) {
                spans.push({ styles: [], text: match[6], url: unescapeLinkDestination(dest.url) });
                pattern.lastIndex = dest.end;
            } else {
                // If no URL part, treat as plain text with brackets
                pushTextWithAutoLinks(spans, `[${match[6]}]`, []);
            }
        } else if (match[7]) {
            // Inline code
            spans.push({ styles: ['code'], text: match[8], url: null });
        }

        lastIndex = pattern.lastIndex;
        // A zero-length match would otherwise spin forever at one index.
        if (match[0].length === 0) pattern.lastIndex++;
    }

    // If there's any text remaining after the last match, treat it as plain
    if (lastIndex < markdown.length) {
        pushTextWithAutoLinks(spans, markdown.slice(lastIndex), []);
    }

    return spans;
}
