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

/** The harnesses the daemon has a quota surface for (`/v2/harnesses/:h/limits`
 *  answers `unsupported` for the rest). A session on any other harness shows
 *  the context reading instead — not Claude's quota, which cannot stop it. */
export type LimitsHarness = 'claude' | 'codex';

/** The quota surface a session's harness has, or null when it has none. */
export function limitsHarnessFor(flavor: string | null | undefined): LimitsHarness | null {
    if (flavor === 'codex') return 'codex';
    if (!flavor || flavor === 'claude') return 'claude';
    return null;
}

async function fetchLimits(machineId: string, harness: LimitsHarness): Promise<MachineLimits | null> {
    const ctx = sync.machineOnlyCtx(machineId);
    if (!ctx) return null;
    const reply = await machineLimitsOnly(ctx, harness);
    const data = reply?.data as { limits?: LimitRow[]; observedAt?: number } | undefined;
    const rows = data?.limits;
    if (!Array.isArray(rows)) return null;
    return { rows, observedAt: data?.observedAt ?? Date.now() };
}

function load(machineId: string, harness: LimitsHarness): Promise<MachineLimits | null> {
    const key = `${machineId}:${harness}`;
    const existing = inflight.get(key);
    if (existing) return existing;
    const p = fetchLimits(machineId, harness)
        .then((value) => {
            if (value) cache.set(key, { at: Date.now(), value });
            return value;
        })
        // A failed read keeps whatever was cached: quota that is a few minutes
        // old is far better than a segment that blinks out on one bad call.
        .catch(() => null)
        .finally(() => { inflight.delete(key); });
    inflight.set(key, p);
    return p;
}

export function useMachineLimits(machineId: string | null | undefined, harness: LimitsHarness | null = 'claude'): MachineLimits | null {
    const key = machineId && harness ? `${machineId}:${harness}` : null;
    const [value, setValue] = React.useState<MachineLimits | null>(
        () => (key ? cache.get(key)?.value ?? null : null),
    );

    React.useEffect(() => {
        if (!machineId || !harness) { setValue(null); return; }
        const k = `${machineId}:${harness}`;
        let cancelled = false;
        // A harness switch shows that harness's cached rows at once (or nothing
        // until they load) — never the previous harness's figure.
        setValue(cache.get(k)?.value ?? null);
        const tick = () => {
            const hit = cache.get(k);
            if (hit && Date.now() - hit.at < REFRESH_MS) { setValue(hit.value); return; }
            void load(machineId, harness).then((v) => { if (!cancelled && v) setValue(v); });
        };
        tick();
        const timer = setInterval(tick, REFRESH_MS);
        return () => { cancelled = true; clearInterval(timer); };
    }, [machineId, harness]);

    return value;
}

export { tightestLimit, limitWindowName, limitResetLabel } from '@/utils/limitsFormat';
