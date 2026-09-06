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

import { parseBudget } from './parseBudget';

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

// The attribute run is `[^<>]{0,4000}` — it cannot cross into the NEXT tag,
// so a message full of unfinished "<joy-img " fragments is scanned once
// instead of once per fragment (the old `[^>]*?` rescanned to the end of the
// text from every opening, quadratic). 4000 chars is far beyond any real tag.
const TAG_RE = /<joy-(img|file)\b[^<>]{0,4000}>/gi;
const ATTR_RE = /([a-zA-Z-]+)\s*=\s*"([^"]*)"/g;

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
// An unterminated tag at the END of the text — the streaming case: the tag's
// prefix has arrived but its closing '>' hasn't. Rendered as-is it shows raw
// XML to the user until the next token batch (or forever, if output was
// truncated mid-tag).
const PARTIAL_TAIL_RE = /<joy-(img|file)\b[^<>]{0,4000}$/i;

/** True when the text contains at least one joy tag (cheap pre-check). */
export function hasJoyTags(text: string): boolean {
    return PREFIX_RE.test(text);
}

export function splitJoySegments(text: string): JoySegment[] {
    const segments: JoySegment[] = [];
    let last = 0;
    TAG_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    const budget = parseBudget();
    while ((m = TAG_RE.exec(text))) {
        if (!budget.spend()) break; // the remainder is emitted as markdown below
        const before = text.slice(last, m.index);
        if (before.trim()) segments.push({ kind: 'md', text: before });
        const attrs = parseAttrs(m[0]);
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
        last = m.index + m[0].length;
    }
    // Strip a trailing unterminated tag (mid-stream) so raw XML never renders.
    const rest = text.slice(last).replace(PARTIAL_TAIL_RE, '');
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
