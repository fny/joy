/**
 * Splits the per-machine usage fetches of the all-machines report into the
 * reports that can be aggregated and the machines that returned nothing
 * usable. The screen used to keep only the good ones and label their sum
 * "All machines" — a timed-out or `ok:false` machine silently vanished from a
 * total that looked complete (#182).
 */
export interface UsageTargetResult<R extends { ok?: boolean; error?: string }, S> {
    id: string;
    rep: R;
    sess: S | null;
}

export interface UsageSplit<R extends { ok?: boolean; error?: string }, S> {
    good: UsageTargetResult<R, S>[];
    /** Machines with no usable report and why, in target order. */
    failed: { id: string; reason: string }[];
}

export function splitUsageResults<R extends { ok?: boolean; error?: string }, S>(
    targets: string[],
    results: PromiseSettledResult<UsageTargetResult<R, S>>[],
    fallbackReason = 'usage query failed',
): UsageSplit<R, S> {
    const good: UsageTargetResult<R, S>[] = [];
    const failed: { id: string; reason: string }[] = [];
    results.forEach((r, i) => {
        const id = targets[i] ?? (r.status === 'fulfilled' ? r.value.id : `#${i}`);
        if (r.status === 'rejected') {
            failed.push({ id, reason: r.reason instanceof Error ? r.reason.message : String(r.reason ?? fallbackReason) });
            return;
        }
        if (r.value.rep?.ok) {
            good.push(r.value);
        } else {
            failed.push({ id, reason: r.value.rep?.error || fallbackReason });
        }
    });
    return { good, failed };
}
