/**
 * <joy-img/> and <joy-file/> tag parsing. The agent displays an image inline
 * or links a file by emitting a tag in its reply text (see joy-tmux's injected
 * system prompt for the authoring contract):
 *
 *   <joy-img src="/abs/path/img.webp" width="854" height="480" alt="…" />
 *   <joy-file path="/abs/or/relative/path.ts" line="42" name="optional label" />
 *
 * splitJoySegments splits a message's text into markdown, image, and file
 * segments so the renderer can interleave MarkdownView blocks with the tag
 * components. Unknown/malformed tags (no src/path) are stripped rather than
 * shown as raw XML.
 */

import { exceedsInputBudget, parseBudget } from './parseBudget';
import { findCodeRanges, isInsideCode } from '@/components/markdown/codeRanges';

export interface JoyImgSegment {
    kind: 'img';
    src: string;
    width: number | null;
    height: number | null;
    alt: string | null;
}

export interface JoyFileSegment {
    kind: 'file';
    path: string;
    line: number | null;
    name: string | null;
}

export interface JoyMdSegment {
    kind: 'md';
    text: string;
}

export type JoySegment = JoyImgSegment | JoyFileSegment | JoyMdSegment;

// A tag is at most this long; the attribute scan never runs past it, so a
// message full of unfinished "<joy-img " fragments is scanned once instead
// of once per fragment (the old `[^>]*?` rescanned to the end of the text
// from every opening, quadratic). 4000 chars is far beyond any real tag.
const MAX_TAG_LENGTH = 4000;
const TAG_START_RE = /<joy-(img|file)\b/gi;
const ATTR_RE = /([a-zA-Z-]+)\s*=\s*"([^"]*)"/g;

/**
 * Index just past the `>` that closes the tag opening at `start`, or -1 when
 * the tag is unterminated within MAX_TAG_LENGTH. Quoted attribute values are
 * skipped whole: a `>` inside `path="/tmp/a>b.txt"` or `alt="1 > 0"` used to
 * end the tag early, dropping the attribute and leaking the rest of the tag
 * into the message as text (#435). A second `<` outside quotes means this tag
 * never closed (the next tag begins) — also unterminated.
 */
function findTagEnd(text: string, start: number): number {
    const limit = Math.min(text.length, start + MAX_TAG_LENGTH);
    let inQuote = false;
    for (let i = start + 1; i < limit; i++) {
        const c = text[i];
        if (inQuote) {
            if (c === '"') inQuote = false;
            continue;
        }
        if (c === '"') inQuote = true;
        else if (c === '>') return i + 1;
        else if (c === '<') return -1;
    }
    return -1;
}

function parseAttrs(tag: string): Record<string, string> {
    const attrs: Record<string, string> = {};
    let m: RegExpExecArray | null;
    ATTR_RE.lastIndex = 0;
    while ((m = ATTR_RE.exec(tag))) {
        attrs[m[1].toLowerCase()] = m[2];
    }
    return attrs;
}

function positiveInt(v: string | undefined): number | null {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

const PREFIX_RE = /<joy-(img|file)/i;

/** True when the text contains at least one joy tag (cheap pre-check). */
export function hasJoyTags(text: string): boolean {
    return PREFIX_RE.test(text);
}

export function splitJoySegments(text: string): JoySegment[] {
    const segments: JoySegment[] = [];
    // Plain text without a tag skips every pass below, the code-range
    // prepass included; past the shared input cap the text is shown
    // verbatim, like the other decorating parsers (utils/parseBudget).
    if (!hasJoyTags(text) || exceedsInputBudget(text)) {
        if (text.trim()) segments.push({ kind: 'md', text });
        return segments;
    }
    // A tag quoted inside a fenced or inline code example is documentation,
    // not an attachment: extracting it replaced the literal with a live image
    // and split the fence around it (#436).
    const codeRanges = findCodeRanges(text);
    let last = 0;
    let searchFrom = 0;
    const budget = parseBudget();
    // Unterminated tag at the END of the text — the streaming case: the tag's
    // prefix has arrived but its closing '>' hasn't. Rendered as-is it shows
    // raw XML to the user until the next token batch (or forever, if output
    // was truncated mid-tag).
    let partialTailStart = -1;

    while (searchFrom < text.length) {
        if (!budget.spend()) break; // the remainder is emitted as markdown below
        TAG_START_RE.lastIndex = searchFrom;
        const m = TAG_START_RE.exec(text);
        if (!m) break;
        const start = m.index;
        if (isInsideCode(codeRanges, start)) {
            searchFrom = start + m[0].length;
            continue;
        }
        const end = findTagEnd(text, start);
        if (end === -1) {
            // No closing '>' before the next '<' or the end of the text. Only a
            // tail that runs to the very end is the streaming case; anything
            // else is malformed text and stays visible.
            if (text.indexOf('<', start + 1) === -1 && text.length - start <= MAX_TAG_LENGTH) {
                partialTailStart = start;
                break;
            }
            searchFrom = start + m[0].length;
            continue;
        }
        const before = text.slice(last, start);
        if (before.trim()) segments.push({ kind: 'md', text: before });
        const tag = text.slice(start, end);
        const attrs = parseAttrs(tag);
        if (m[1].toLowerCase() === 'img' && attrs.src) {
            segments.push({
                kind: 'img',
                src: attrs.src,
                width: positiveInt(attrs.width),
                height: positiveInt(attrs.height),
                alt: attrs.alt?.trim() || null,
            });
        } else if (m[1].toLowerCase() === 'file' && attrs.path) {
            segments.push({
                kind: 'file',
                path: attrs.path,
                line: positiveInt(attrs.line),
                name: attrs.name?.trim() || null,
            });
        }
        // No src/path → tag is stripped (never render raw XML to the user).
        last = end;
        searchFrom = end;
    }
    // Strip a trailing unterminated tag (mid-stream) so raw XML never renders.
    const rest = partialTailStart === -1 ? text.slice(last) : text.slice(last, partialTailStart);
    if (rest.trim()) segments.push({ kind: 'md', text: rest });
    return segments;
}

/** Mime type from the file extension — the tag points at files the agent saved
 *  as-is (typically png/jpeg screenshots), so extension sniffing suffices. */
export function joyImgMime(src: string): string {
    const ext = src.toLowerCase().split('.').pop() ?? '';
    if (ext === 'png') return 'image/png';
    if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
    if (ext === 'gif') return 'image/gif';
    return 'image/webp';
}
