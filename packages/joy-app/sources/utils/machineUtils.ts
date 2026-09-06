import type { Machine } from '@/sync/storageTypes';

// A machine beats `machine-alive` every ~20s; the relay flips its `active` flag
// offline on a single late/jittered beat and back on the next, which made the UI
// flicker. So don't trust the raw `active` flag — treat the machine as online if
// we've HEARD from it within this window, offline otherwise. A genuinely-dead
// machine stops beating, goes stale past the window, and shows offline — but it
// keeps its cached metadata, so it stays in the list as a known, named machine.
export const MACHINE_ONLINE_WINDOW_MS = 60_000;

export function isMachineOnline(machine: Machine, now: number = Date.now()): boolean {
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
