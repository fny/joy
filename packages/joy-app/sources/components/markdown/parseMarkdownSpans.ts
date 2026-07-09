import type { MarkdownSpan } from "./parseMarkdown";

// Updated pattern to handle nested markdown and asterisks
const pattern = /(\*\*(.*?)(?:\*\*|$))|(\*(.*?)(?:\*|$))|(\[([^\]]+)\](?:\(([^)]+)\))?)|(`(.*?)(?:`|$))/g;

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
        while (/[),.;:!?]$/.test(url)) {
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
const nestedLinkPattern = /\[([^\]]+)\]\(([^)]+)\)/g;
function pushStyledContent(spans: MarkdownSpan[], text: string, styles: MarkdownSpan['styles']) {
    let last = 0;
    let m: RegExpExecArray | null;
    nestedLinkPattern.lastIndex = 0;
    while ((m = nestedLinkPattern.exec(text)) !== null) {
        if (m.index > last) {
            pushTextWithAutoLinks(spans, text.slice(last, m.index), styles);
        }
        spans.push({ styles, text: m[1], url: m[2] });
        last = m.index + m[0].length;
    }
    if (last < text.length) {
        pushTextWithAutoLinks(spans, text.slice(last), styles);
    }
}

export function parseMarkdownSpans(markdown: string, header: boolean) {
    const spans: MarkdownSpan[] = [];
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    pattern.lastIndex = 0;

    while ((match = pattern.exec(markdown)) !== null) {
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
            if (match[7]) {
                spans.push({ styles: [], text: match[6], url: match[7] });
            } else {
                // If no URL part, treat as plain text with brackets
                pushTextWithAutoLinks(spans, `[${match[6]}]`, []);
            }
        } else if (match[8]) {
            // Inline code
            spans.push({ styles: ['code'], text: match[9], url: null });
        }

        lastIndex = pattern.lastIndex;
    }

    // If there's any text remaining after the last match, treat it as plain
    if (lastIndex < markdown.length) {
        pushTextWithAutoLinks(spans, markdown.slice(lastIndex), []);
    }

    return spans;
}
