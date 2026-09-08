import * as React from 'react';
import { sync } from '@/sync/sync';
import { machineLimitsOnly } from '@/sync/v2/machine';

/**
 * Account quota windows for a machine — the same server truth behind the
 * limits page (`GET /v2/harnesses/:harness/limits`, read by the daemon from
 * Claude's OAuth usage API): 5-hour, weekly, and model-scoped windows with a
 * used percentage and a reset time.
 *
 * Why this exists as a hook (#646): the composer's "% left" segment used to
 * divide the conversation's context by a hardcoded 190,000 — a number the app
 * invented, which pinned large-window models at "0% left" forever. Quota is
 * both real and the thing actually worth watching: it is what runs out and
 * stops you working. The limits page already had it; nothing else could reach
 * it.
 */
export type { LimitRow } from '@/utils/limitsFormat';
import type { LimitRow } from '@/utils/limitsFormat';

export interface MachineLimits {
    rows: LimitRow[];
    /** When these were read, so a stale set can be labelled rather than trusted. */
    observedAt: number | null;
}

/** Quota moves slowly; the tunnel round-trip is not free. */
const REFRESH_MS = 5 * 60_000;

// Shared across every consumer of a machine, so the composer and the limits
// page do not each hold their own copy (or each fire their own tunnel call).
const cache = new Map<string, { at: number; value: MachineLimits }>();
const inflight = new Map<string, Promise<MachineLimits | null>>();

async function fetchLimits(machineId: string): Promise<MachineLimits | null> {
    const ctx = sync.machineOnlyCtx(machineId);
    if (!ctx) return null;
    const reply = await machineLimitsOnly(ctx, 'claude');
    const data = reply?.data as { limits?: LimitRow[]; observedAt?: number } | undefined;
    const rows = data?.limits;
    if (!Array.isArray(rows)) return null;
    return { rows, observedAt: data?.observedAt ?? Date.now() };
}

function load(machineId: string): Promise<MachineLimits | null> {
    const existing = inflight.get(machineId);
    if (existing) return existing;
    const p = fetchLimits(machineId)
        .then((value) => {
            if (value) cache.set(machineId, { at: Date.now(), value });
            return value;
        })
        // A failed read keeps whatever was cached: quota that is a few minutes
        // old is far better than a segment that blinks out on one bad call.
        .catch(() => null)
        .finally(() => { inflight.delete(machineId); });
    inflight.set(machineId, p);
    return p;
}

export function useMachineLimits(machineId: string | null | undefined): MachineLimits | null {
    const [value, setValue] = React.useState<MachineLimits | null>(
        () => (machineId ? cache.get(machineId)?.value ?? null : null),
    );

    React.useEffect(() => {
        if (!machineId) { setValue(null); return; }
        let cancelled = false;
        const tick = () => {
            const hit = cache.get(machineId);
            if (hit && Date.now() - hit.at < REFRESH_MS) { setValue(hit.value); return; }
            void load(machineId).then((v) => { if (!cancelled && v) setValue(v); });
        };
        tick();
        const timer = setInterval(tick, REFRESH_MS);
        return () => { cancelled = true; clearInterval(timer); };
    }, [machineId]);

    return value;
}

export { tightestLimit, limitWindowName, limitResetLabel } from '@/utils/limitsFormat';
