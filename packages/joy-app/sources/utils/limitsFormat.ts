/**
 * Pure helpers for the account quota windows behind the limits page.
 *
 * Kept free of React and react-native imports so they can be tested directly —
 * and so the composer can reason about quota without dragging the fetch layer
 * along (#646).
 */
export interface LimitRow {
    id: string;
    usedPercent: number;
    /** ISO string; codex rows may carry unix seconds instead. */
    resetsAt?: string | number | null;
    windowMinutes?: number;
    scope?: string;
}

/**
 * The window closest to running out — that is the one worth a single number on
 * the status line. Ties break toward the SHORTER window: a 5-hour window at 90%
 * bites sooner than a weekly one at the same figure.
 */
export function tightestLimit(rows: LimitRow[] | undefined): LimitRow | null {
    if (!rows || rows.length === 0) return null;
    return rows.reduce((worst, row) => {
        if (!worst) return row;
        if (row.usedPercent !== worst.usedPercent) return row.usedPercent > worst.usedPercent ? row : worst;
        return (row.windowMinutes ?? Infinity) < (worst.windowMinutes ?? Infinity) ? row : worst;
    }, null as LimitRow | null);
}

/** "5-hour window", "Weekly window", "Fable · weekly" — what the row covers. */
export function limitWindowName(row: LimitRow): string {
    const minutes = row.windowMinutes;
    const base = minutes == null ? (row.id || 'window')
        : minutes <= 360 ? '5-hour window'
            : minutes <= 20_000 ? 'Weekly window'
                : `${Math.round(minutes / 1440)}-day window`;
    // A model-scoped row is about that model's own allowance, not the account's.
    return row.scope && row.scope !== 'account' ? `${row.scope} · ${base}` : base;
}

export function limitResetLabel(at: string | number | null | undefined): string | null {
    if (at == null) return null;
    const date = typeof at === 'number' ? new Date(at < 1e12 ? at * 1000 : at) : new Date(at);
    if (isNaN(date.getTime())) return null;
    const ms = date.getTime() - Date.now();
    if (ms <= 0) return 'resets soon';
    // Round to whole minutes FIRST. Taking the hour floor and then rounding the
    // remainder independently produces "1h 60m" for anything within 30s of the
    // hour — the limits page has been able to print that since it shipped.
    const totalMinutes = Math.round(ms / 60_000);
    const h = Math.floor(totalMinutes / 60);
    const m = totalMinutes % 60;
    if (h >= 48) return `resets in ${Math.round(h / 24)}d`;
    return h > 0 ? `resets in ${h}h ${m}m` : `resets in ${m}m`;
}
