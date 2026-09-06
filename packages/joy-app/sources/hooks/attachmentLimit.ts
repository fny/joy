/**
 * Append picked attachments to the current set without exceeding the per-
 * message limit, and REPORT what did not fit. The old `slice(0, max)` silently
 * dropped the overflow; on web every picked file owns a blob URL, so a dropped
 * preview that nobody released kept its bytes pinned for the life of the tab
 * (#320). The caller releases `dropped`.
 */
export function appendWithinLimit<T>(prev: readonly T[], incoming: readonly T[], max: number): { next: T[]; dropped: T[] } {
    const room = Math.max(0, max - prev.length);
    const kept = incoming.slice(0, room);
    const dropped = incoming.slice(room);
    return { next: kept.length ? [...prev, ...kept] : [...prev], dropped };
}
