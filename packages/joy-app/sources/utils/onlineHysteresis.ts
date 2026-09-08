/**
 * Stabilises the online/offline reading behind a session's status (#649).
 *
 * `isOnline` is computed at render time as
 * `presence === 'online' && Date.now() - activeAt < 90s`, and going offline
 * swaps the ENTIRE composer for the Resume button. Two consequences:
 *
 *  - Nothing re-renders when the 90s boundary passes, so the flip lands on
 *    whatever unrelated render happens next — an arbitrary moment.
 *  - The daemon heartbeats every ~30s against that 90s window, so one late or
 *    dropped keepalive crosses the line and the next one crosses back. The
 *    Resume button appears and vanishes.
 *
 * So offline has to be *sustained* before it is believed. Coming back is
 * instant: that direction is never wrong, and delaying it would hide a session
 * that is genuinely ready.
 */

export interface OnlineHysteresisState {
    /** What the UI shows. */
    stable: boolean;
    /** When the raw reading first went false in the current run, else null. */
    offlineSince: number | null;
}

export interface OnlineHysteresisInput extends OnlineHysteresisState {
    /** The instantaneous reading. */
    raw: boolean;
    now: number;
    graceMs: number;
}

/**
 * How long the raw reading must stay false before the UI accepts it. Comfortably
 * longer than one missed 30s keepalive lands late, short enough that a session
 * that really died is not claimed to be alive for long.
 */
export const OFFLINE_GRACE_MS = 8_000;

export function stabilizeOnline(input: OnlineHysteresisInput): OnlineHysteresisState {
    const { raw, stable, offlineSince, now, graceMs } = input;

    // Recovery is immediate and clears the clock.
    if (raw) {
        return offlineSince === null && stable ? { stable, offlineSince } : { stable: true, offlineSince: null };
    }

    // Already showing offline — nothing left to debounce.
    if (!stable) return { stable, offlineSince: offlineSince ?? now };

    // First false reading: start the clock, keep showing online.
    if (offlineSince === null) return { stable: true, offlineSince: now };

    // Sustained long enough to believe.
    if (now - offlineSince >= graceMs) return { stable: false, offlineSince };

    return { stable, offlineSince };
}

/** Same state? Lets a caller skip a re-render rather than loop on itself. */
export function sameOnlineState(a: OnlineHysteresisState, b: OnlineHysteresisState): boolean {
    return a.stable === b.stable && a.offlineSince === b.offlineSince;
}
