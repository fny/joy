import type { Machine } from '@/sync/storageTypes';

// A machine beats `machine-alive` every ~20s; the relay flips its `active` flag
// offline on a single late/jittered beat and back on the next, which made the UI
// flicker. So don't trust the raw `active` flag — treat the machine as online if
// we've HEARD from it within this window, offline otherwise. A genuinely-dead
// machine stops beating, goes stale past the window, and shows offline — but it
// keeps its cached metadata, so it stays in the list as a known, named machine.
export const MACHINE_ONLINE_WINDOW_MS = 60_000;

export function isMachineOnline(machine: Machine): boolean {
    return Date.now() - machine.activeAt < MACHINE_ONLINE_WINDOW_MS;
}