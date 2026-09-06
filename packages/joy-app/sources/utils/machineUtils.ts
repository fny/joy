import type { Machine } from '@/sync/storageTypes';

// A machine beats `machine-alive` every ~20s; the relay flips its `active` flag
// offline on a single late/jittered beat and back on the next, which made the UI
// flicker. So don't trust the raw `active` flag — treat the machine as online if
// we've HEARD from it within this window, offline otherwise. A genuinely-dead
// machine stops beating, goes stale past the window, and shows offline — but it
// keeps its cached metadata, so it stays in the list as a known, named machine.
export const MACHINE_ONLINE_WINDOW_MS = 60_000;

/** Liveness at an explicit instant — the testable core. */
export function isMachineOnlineAt(machine: Machine, now: number): boolean {
    // The relay's v2 lease liveness is authoritative for OFFLINE when present:
    // it is the same signal the work queue dispatches on, so "online" here can
    // never disagree with "a spawn would actually run".
    if (machine.leaseAlive === false) return false;
    // A live lease is only as current as the record that carried it. The relay
    // derives activeAt from the same lease (`seenAt`), so a record we stopped
    // receiving updates for goes stale past the window and reads offline —
    // instead of a cached `leaseAlive: true` keeping a silent machine online
    // forever (#323). Records that predate leaseAlive use the same window.
    return now - machine.activeAt < MACHINE_ONLINE_WINDOW_MS;
}

/**
 * Liveness now. Deliberately UNARY: it is handed straight to Array.filter all
 * over the app, and a second `now` parameter received the row index there —
 * every cached lease passed the filter forever while the direct call said
 * offline (#323, #180). Callers that need a fixed instant use
 * isMachineOnlineAt.
 */
export function isMachineOnline(machine: Machine): boolean {
    return isMachineOnlineAt(machine, Date.now());
}

/**
 * Milliseconds until the earliest currently-online machine in `machines`
 * leaves the window, or null when none is online. A page that lists online
 * machines re-renders at that moment so a silent daemon drops off the list
 * without waiting for an unrelated store update (#180).
 */
export function msUntilNextMachineOffline(machines: Iterable<Machine>, now: number): number | null {
    let next: number | null = null;
    for (const machine of machines) {
        if (!isMachineOnlineAt(machine, now)) continue;
        const remaining = machine.activeAt + MACHINE_ONLINE_WINDOW_MS - now;
        if (next === null || remaining < next) next = remaining;
    }
    return next === null ? null : Math.max(0, next);
}
