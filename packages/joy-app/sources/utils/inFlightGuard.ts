/**
 * One synchronous in-flight guard for a surface whose operations must not
 * interleave — the terminal pane's "type text, then press Enter" is the
 * motivating case: two overlapping submits could land as A-text, B-text,
 * A-Enter (submitting "AB") plus a stray Enter that answers the next prompt.
 *
 * `run` claims the guard SYNCHRONOUSLY (no await between the check and the
 * claim), so two callers in the same tick cannot both pass; the guard stays
 * held for the WHOLE async operation, including any follow-up step the
 * operation chains internally. A rejected claim returns `null` without
 * touching the operation, so the caller can keep the user's input intact.
 */
export interface InFlightGuard {
    /** True while an operation holds the guard. */
    readonly busy: boolean;
    /** Run `op` exclusively; returns its result, or null if another operation
     *  currently holds the guard (op is NOT started). */
    run<T>(op: () => Promise<T>): Promise<T | null>;
}

export function createInFlightGuard(): InFlightGuard {
    let held = false;
    return {
        get busy() { return held; },
        async run<T>(op: () => Promise<T>): Promise<T | null> {
            if (held) return null;
            held = true;
            try {
                return await op();
            } finally {
                held = false;
            }
        },
    };
}
