/**
 * <joy-img/> tag parsing. The agent displays an image inline in chat by
 * emitting a standard-img-like tag in its reply text (see joy-tmux's injected
 * system prompt for the authoring contract):
 *
 *   <joy-img src="/abs/path/img.webp" width="854" height="480" alt="…" />
 *
 * splitJoyImgSegments splits a message's text into markdown and image
 * segments so the renderer can interleave MarkdownView blocks with image
 * components. Unknown/malformed tags (no src) are stripped rather than shown
 * as raw XML.
 */

export interface JoyImgSegment {
    kind: 'img';
    src: string;
    width: number | null;
    height: number | null;
    alt: string | null;
}

export interface JoyMdSegment {
    kind: 'md';
    text: string;
}

export type JoySegment = JoyImgSegment | JoyMdSegment;

const TAG_RE = /<joy-img\b[^>]*?\/?>/gi;
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

const PREFIX_RE = /<joy-img/i;
// An unterminated tag at the END of the text — the streaming case: the tag's
// prefix has arrived but its closing '>' hasn't. Rendered as-is it shows raw
// XML to the user until the next token batch (or forever, if output was
// truncated mid-tag).
const PARTIAL_TAIL_RE = /<joy-img\b[^>]*$/i;

/** True when the text contains at least one joy-img tag (cheap pre-check). */
export function hasJoyImg(text: string): boolean {
    return PREFIX_RE.test(text);
}

export function splitJoyImgSegments(text: string): JoySegment[] {
    const segments: JoySegment[] = [];
    let last = 0;
    TAG_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = TAG_RE.exec(text))) {
        const before = text.slice(last, m.index);
        if (before.trim()) segments.push({ kind: 'md', text: before });
        const attrs = parseAttrs(m[0]);
        if (attrs.src) {
            segments.push({
                kind: 'img',
                src: attrs.src,
                width: positiveInt(attrs.width),
                height: positiveInt(attrs.height),
                alt: attrs.alt?.trim() || null,
            });
        }
        // No src → tag is stripped (never render raw XML to the user).
        last = m.index + m[0].length;
    }
    // Strip a trailing unterminated tag (mid-stream) so raw XML never renders.
    const rest = text.slice(last).replace(PARTIAL_TAIL_RE, '');
    if (rest.trim()) segments.push({ kind: 'md', text: rest });
    return segments;
}

/** Mime type from the file extension — the tag points at agent-encoded files
 *  (webp by contract, jpeg/png as fallbacks), so extension sniffing suffices. */
export function joyImgMime(src: string): string {
    const ext = src.toLowerCase().split('.').pop() ?? '';
    if (ext === 'png') return 'image/png';
    if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
    if (ext === 'gif') return 'image/gif';
    return 'image/webp';
}
