/**
 * Calendar-date arithmetic for the session-history date headers (#166).
 *
 * "Yesterday" used to be local midnight minus 24 h, and "N days ago" the
 * floor of elapsed local-midnight milliseconds / 86 400 000. Across a DST
 * transition a calendar day is 23 or 25 hours long, so the day after the
 * spring-forward Sunday saw "yesterday" land at 23:00 two days back and
 * every older group undercounted by one. Counting whole calendar days from
 * the LOCAL date components (projected onto UTC, where every day is exactly
 * 24 h) removes the dependence on the day's length.
 */

/** Whole calendar days from `from` to `to`, by local date; negative if `to` is earlier. */
export function calendarDayDiff(from: Date, to: Date): number {
    const a = Date.UTC(from.getFullYear(), from.getMonth(), from.getDate());
    const b = Date.UTC(to.getFullYear(), to.getMonth(), to.getDate());
    return Math.round((b - a) / 86_400_000);
}

export type DateHeader =
    | { kind: 'today' }
    | { kind: 'yesterday' }
    | { kind: 'daysAgo'; days: number };

/** Which header a session dated `date` belongs under, as seen from `now`. */
export function dateHeaderFor(date: Date, now: Date = new Date()): DateHeader {
    const days = calendarDayDiff(date, now);
    if (days <= 0) return { kind: 'today' }; // a clock skewed into the future still reads "today", never "-1 days ago"
    if (days === 1) return { kind: 'yesterday' };
    return { kind: 'daysAgo', days };
}

/** A stable per-calendar-day key (local date), for grouping. */
export function localDayKey(date: Date): string {
    return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}
