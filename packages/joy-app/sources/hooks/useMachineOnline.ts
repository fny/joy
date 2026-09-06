import * as React from 'react';
import type { Machine } from '@/sync/storageTypes';
import { isMachineOnline, MACHINE_ONLINE_WINDOW_MS, msUntilNextMachineOffline } from '@/utils/machineUtils';

// isMachineOnline() is a pure time-based check ("heard within 60s"). Evaluated
// once at render it goes stale: a machine that stops heartbeating keeps reading
// "online" until some unrelated state change happens to re-render it. This hook
// returns the current value AND schedules a single re-render at the moment the
// window expires, so a silent machine flips to offline on time. A fresh
// heartbeat (activeAt changes) re-runs the effect and re-arms the timer; while a
// machine keeps beating (~20s) it never reaches the timeout. isMachineOnline
// applies the same window to v2 records carrying `leaseAlive: true`, so the
// timer's expiry flips a stale lease offline too (#323).
export function useMachineOnline(machine: Machine | null | undefined): boolean {
    const activeAt = machine?.activeAt ?? 0;
    const [, force] = React.useReducer((n: number) => n + 1, 0);
    React.useEffect(() => {
        if (!machine) return;
        const remaining = activeAt + MACHINE_ONLINE_WINDOW_MS - Date.now();
        if (remaining <= 0) return; // already past the window; a new heartbeat re-arms
        const t = setTimeout(force, remaining + 100);
        return () => clearTimeout(t);
    }, [machine, activeAt]);
    return machine ? isMachineOnline(machine) : false;
}

/**
 * The list form of useMachineOnline: re-renders the caller when the earliest
 * currently-online machine in `machines` leaves the heartbeat window, so a
 * `machines.filter(isMachineOnline)` computed at render cannot keep a stopped
 * daemon on screen until something else happens to re-render (#180).
 */
export function useMachinesOnlineTick(machines: Machine[]): void {
    const [, force] = React.useReducer((n: number) => n + 1, 0);
    const nextExpiry = msUntilNextMachineOffline(machines, Date.now());
    React.useEffect(() => {
        if (nextExpiry === null) return;
        const t = setTimeout(force, nextExpiry + 100);
        return () => clearTimeout(t);
    }, [machines, nextExpiry]);
}
