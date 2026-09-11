import type { AttachmentSource } from './attachmentTypes';

// Upload names, as the daemon writes them (joy-daemon domain/attachments.ts):
// `YYYYMMDD-HHMMSS-NNNN.<name>.<ext>` in the session's uploads folder. An
// upload the source gave no name is named for where it came from.

const FALLBACK: Record<AttachmentSource, string> = { paste: 'paste', library: 'photo', document: 'file', drop: 'drop' };
const MIME_EXT: Record<string, string> = {
    'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp',
    'application/pdf': 'pdf', 'text/plain': 'txt', 'application/json': 'json', 'text/csv': 'csv',
    'text/markdown': 'md', 'application/zip': 'zip', 'text/html': 'html',
};

/** The name to show for an attachment in the composer: its own, or the word
 *  the daemon will name it after (`paste.jpg`, `photo.jpg`, `file.pdf`). */
export function attachmentDisplayName(a: { name: string; source?: AttachmentSource; mimeType?: string }): string {
    if (a.name) return a.name;
    const stem = a.source ? FALLBACK[a.source] : 'unknown';
    const ext = a.mimeType ? MIME_EXT[a.mimeType.toLowerCase()] : undefined;
    return ext ? `${stem}.${ext}` : stem;
}

/** The fixed-width timestamp prefix every upload name starts with. */
export const UPLOAD_PREFIX = /^\d{8}-\d{6}-\d{4}\./;

/** An upload's name without its prefix — what a download is saved as. Any
 *  other name comes back unchanged. */
export function stripUploadPrefix(fileName: string): string {
    return fileName.replace(UPLOAD_PREFIX, '') || fileName;
}
