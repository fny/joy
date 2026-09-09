/**
 * Pure helpers behind the Storage page — sizes, ages and selection maths — so
 * the arithmetic is tested without rendering anything.
 */

export function formatBytes(n: number | null | undefined): string {
    if (n == null || !Number.isFinite(n) || n < 0) return '—';
    if (n < 1024) return `${n} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let v = n / 1024; let i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

/** "3h ago", "12d ago", "—" — whole units, no seconds. */
export function ageLabel(at: number | null | undefined, now = Date.now()): string {
    if (at == null || !Number.isFinite(at)) return '—';
    const ms = Math.max(0, now - at);
    const m = Math.floor(ms / 60_000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 48) return `${h}h ago`;
    const d = Math.floor(h / 24);
    if (d < 60) return `${d}d ago`;
    return `${Math.floor(d / 30)}mo ago`;
}

export interface Selectable {
    id: string; bytes: number;
    /** An agent is up: deleting kills it. */
    running?: boolean;
    /** @deprecated alias of running */
    live?: boolean;
    relayEvents?: number; relayBytes?: number;
    /** A loose tmux server (not a session): counted separately, killed if alive. */
    tmux?: { alive: boolean };
}

export interface SelectionSummary { count: number; bytes: number; relayBytes: number; relayEvents: number; live: number; tmux: number; tmuxAlive: number }

export function summarizeSelection(rows: Selectable[], selected: ReadonlySet<string>): SelectionSummary {
    const out: SelectionSummary = { count: 0, bytes: 0, relayBytes: 0, relayEvents: 0, live: 0, tmux: 0, tmuxAlive: 0 };
    for (const r of rows) {
        if (!selected.has(r.id)) continue;
        if (r.tmux) { out.tmux++; if (r.tmux.alive) out.tmuxAlive++; continue; }
        out.count++; out.bytes += r.bytes; out.relayBytes += r.relayBytes ?? 0; out.relayEvents += r.relayEvents ?? 0;
        if (r.running ?? r.live) out.live++;
    }
    return out;
}

/** The confirm text: what goes, and the parts that need saying twice. */
export function describeNuke(s: SelectionSummary): string {
    const parts: string[] = [];
    if (s.count > 0) parts.push(`${s.count} session${s.count === 1 ? '' : 's'}`, `${formatBytes(s.bytes)} on the machine`);
    if (s.relayEvents > 0) parts.push(`${s.relayEvents} relay event${s.relayEvents === 1 ? '' : 's'} (${formatBytes(s.relayBytes)})`);
    if (s.tmux > 0) parts.push(`${s.tmux} loose tmux server${s.tmux === 1 ? '' : 's'}`);
    let text = `Delete ${parts.join(', ')}. This cannot be undone.`;
    const warnings: string[] = [];
    if (s.live > 0) warnings.push(`${s.live} session${s.live === 1 ? ' is' : 's are'} still running and will be killed first.`);
    if (s.tmuxAlive > 0) warnings.push(`${s.tmuxAlive} tmux server${s.tmuxAlive === 1 ? ' is' : 's are'} still up — whatever runs inside dies with ${s.tmuxAlive === 1 ? 'it' : 'them'}.`);
    if (warnings.length) text += `\n\n${warnings.join(' ')}`;
    return text;
}
