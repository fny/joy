// Pure classification/parsing for the file viewer — NO react-native imports,
// so unit tests run under node (vitest). UI lives in FileContentRender.tsx.

import { hasOwn, safeGet } from './safeGet';
import { fileExtension } from './binaryFile';

export type FileRenderKind = 'image' | 'markdown' | 'html' | 'csv' | 'tsv';

// Looked up by the file's extension, which is user data: "data.constructor"
// or "x.__proto__" used to classify as an image and produce a MIME type of
// "[object Object]" / the Object function (#434). Own-property reads only.
// fileExtension() needs a real separator, so a root file named "png" is not
// an image either (#422).
const IMAGE_MIME: Record<string, string> = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    webp: 'image/webp', bmp: 'image/bmp', ico: 'image/x-icon', avif: 'image/avif',
};

export function fileRenderKind(path: string): FileRenderKind | null {
    const ext = fileExtension(path);
    if (hasOwn(IMAGE_MIME, ext) || ext === 'svg') return 'image';
    if (ext === 'md' || ext === 'markdown') return 'markdown';
    if (ext === 'html' || ext === 'htm') return 'html';
    if (ext === 'csv') return 'csv';
    if (ext === 'tsv') return 'tsv';
    return null;
}

/** Images are binary (except svg), so the viewer must fetch base64 for them
 *  instead of bailing at the binary-extension gate. */
export function isRasterImagePath(path: string): boolean {
    return hasOwn(IMAGE_MIME, fileExtension(path));
}

export function imageDataUri(path: string, opts: { base64?: string; utf8?: string }): string | null {
    const ext = fileExtension(path);
    if (ext === 'svg' && opts.utf8) return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(opts.utf8)}`;
    const mime = safeGet(IMAGE_MIME, ext);
    if (mime && opts.base64) return `data:${mime};base64,${opts.base64}`;
    return null;
}

// ── CSV/TSV ─────────────────────────────────────────────────────────────────

/** Quote-aware CSV/TSV parse (RFC-ish: "" escapes a quote inside a quoted
 *  cell; newlines inside quotes stay in the cell). Capped for safety — the
 *  viewer shows a truncation notice past the cap.
 *
 *  Record separators are LF or CRLF read OUTSIDE quotes; a CR inside a quoted
 *  field is data and stays (the old trailing-CR trim ran on the decoded cell
 *  and ate it, #432). A record counts as started once a quote opens or any
 *  character lands, so a final `""` record is one empty field, not nothing
 *  (#431). `truncated` means input with another record was left unread — not
 *  merely that the last permitted row ended in a newline (#433). */
export function parseDelimited(text: string, delimiter: ',' | '\t', maxRows = 500): { rows: string[][]; truncated: boolean } {
    const rows: string[][] = [];
    let row: string[] = [];
    let cell = '';
    let inQuotes = false;
    let started = false; // the current record has content (even an empty quoted field)
    let truncated = false;
    const pushCell = () => { row.push(cell); cell = ''; };
    const pushRow = () => { pushCell(); rows.push(row); row = []; started = false; };
    let i = 0;
    for (; i < text.length; i++) {
        const c = text[i];
        if (inQuotes) {
            if (c === '"') {
                if (text[i + 1] === '"') { cell += '"'; i++; }
                else inQuotes = false;
            } else cell += c;
        } else if (c === '"' && cell === '') {
            inQuotes = true;
            started = true;
        } else if (c === delimiter) {
            pushCell();
            started = true;
        } else if (c === '\n' || (c === '\r' && text[i + 1] === '\n')) {
            if (c === '\r') i++;
            pushRow();
            if (rows.length >= maxRows) {
                i++;
                break;
            }
        } else {
            cell += c;
            started = true;
        }
    }
    if (rows.length >= maxRows) {
        // Anything but blank line endings after the cap is an unread record.
        truncated = /[^\r\n]/.test(text.slice(i));
    } else if (started || inQuotes) {
        pushRow();
    }
    return { rows, truncated };
}
