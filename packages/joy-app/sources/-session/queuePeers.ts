import type { QueuedMessage } from '@/hooks/useJoyQueue';

// Rows other sessions, the CLI or cron jobs queued (`joy send`) are shown
// apart from the rows the user lined up: the daemon stamps `from` on them.

export function splitPeers<T extends QueuedMessage>(rows: T[]): { own: T[]; peers: T[] } {
    const own: T[] = []; const peers: T[] = [];
    for (const r of rows) (r.from ? peers : own).push(r);
    return { own, peers };
}

/** The message without the daemon's `<joy-message …>` wrapper. */
export function peerBody(text: string): string {
    const m = /^\s*<joy-message\b[^>]*>\s*([\s\S]*?)\s*<\/joy-message>\s*$/i.exec(text);
    return m ? m[1] : text;
}

/** "Claude Code · Greet (1a2b3c4d)" | "joy:1a2b3c4d" | "cli" | "cron:nightly". */
export function peerLabel(row: QueuedMessage): string {
    const from = row.from ?? '';
    const id = from.startsWith('joy:') ? from.slice(4) : null;
    if (row.fromLabel) return id ? `${row.fromLabel} (${id})` : row.fromLabel;
    return from;
}
