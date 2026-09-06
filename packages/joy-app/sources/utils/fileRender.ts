// Pure classification/parsing for the file viewer — NO react-native imports,
// so unit tests run under node (vitest). UI lives in FileContentRender.tsx.

import { hasOwn, safeGet } from './safeGet';

export type FileRenderKind = 'image' | 'markdown' | 'html' | 'csv' | 'tsv';

// Looked up by the file's extension, which is user data: "data.constructor"
// or "x.__proto__" used to classify as an image and produce a MIME type of
// "[object Object]" / the Object function (#434). Own-property reads only.
const IMAGE_MIME: Record<string, string> = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    webp: 'image/webp', bmp: 'image/bmp', ico: 'image/x-icon', avif: 'image/avif',
};

export function fileRenderKind(path: string): FileRenderKind | null {
    const ext = path.split('.').pop()?.toLowerCase() ?? '';
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
    return hasOwn(IMAGE_MIME, path.split('.').pop()?.toLowerCase() ?? '');
}

export function imageDataUri(path: string, opts: { base64?: string; utf8?: string }): string | null {
    const ext = path.split('.').pop()?.toLowerCase() ?? '';
    if (ext === 'svg' && opts.utf8) return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(opts.utf8)}`;
    const mime = safeGet(IMAGE_MIME, ext);
    if (mime && opts.base64) return `data:${mime};base64,${opts.base64}`;
    return null;
}

// ── CSV/TSV ─────────────────────────────────────────────────────────────────

/** Quote-aware CSV/TSV parse (RFC-ish: "" escapes a quote inside a quoted
 *  cell; newlines inside quotes stay in the cell). Capped for safety — the
 *  viewer shows a truncation notice past the cap. */
export function parseDelimited(text: string, delimiter: ',' | '\t', maxRows = 500): { rows: string[][]; truncated: boolean } {
    const rows: string[][] = [];
    let row: string[] = [];
    let cell = '';
    let inQuotes = false;
    let truncated = false;
    const pushCell = () => { row.push(cell); cell = ''; };
    const pushRow = () => { pushCell(); rows.push(row); row = []; };
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (inQuotes) {
            if (c === '"') {
                if (text[i + 1] === '"') { cell += '"'; i++; }
                else inQuotes = false;
            } else cell += c;
        } else if (c === '"' && cell === '') {
            inQuotes = true;
        } else if (c === delimiter) {
            pushCell();
        } else if (c === '\n') {
            if (cell.endsWith('\r')) cell = cell.slice(0, -1);
            pushRow();
            if (rows.length >= maxRows) { truncated = true; break; }
        } else {
            cell += c;
        }
    }
    if (!truncated && (cell.length > 0 || row.length > 0)) pushRow();
    return { rows, truncated };
}

