/**
 * Machine-level reads as resources (sync/resource): the daemon's status,
 * which machines run joy-daemon, a machine's session list, its sealed
 * environment names, harness model catalogs and past-session pickers.
 *
 * Each key carries the real identity (machine; machine + harness; machine +
 * directory + harness), so a late answer for machine A can only ever land
 * in A's cache — the screens that used to fence this with generation tokens
 * (#153, #178, #179, #226) now just read the entry for the identity on
 * screen.
 *
 * Every adapter honours the store's four states the same way:
 *  - no machine context (no tunnel yet, machine unknown) → `unavailable`;
 *  - a transport failure (the tunnel threw or timed out) → thrown, so the
 *    store retries within the spec's bound and then records an `error`,
 *    keeping the last good value;
 *  - a daemon answer that is not a valid success (non-200 status, `ok:
 *    false`, a body without the expected array) → `error`, last good value
 *    kept, nothing stamped fresh;
 *  - an authoritative empty result is published ONLY for an explicit,
 *    well-formed success that says "none" (an empty list; a harness the
 *    daemon reports as unsupported/not installed).
 *
 * Every spec declares its recovery policy explicitly (`refetchOnFocus`,
 * `refetchOnReconnect`, with the reason beside it). Whatever the policy, an
 * entry that was `unavailable` for lack of a machine context is read again
 * when the context arrives (sync/resource `onContextReady`, raised by
 * sync.ts once machine keys hydrate), so a screen that mounted before the
 * first machine sync does not sit on "unavailable" until a reconnect.
 */
import { sync } from './sync';
import {
    machineEnvList, machineHarnessModels, machineHistoryLogs, machineListSessions,
    machineOpencodeSessions, machineStatusOnly,
} from './v2/machine';
import { resources, withTimeout, type ResourceOutcome, type ResourceSpec } from './resource';
import { pastSessionsContextKey } from '@/utils/pastSessionsContext';
import type { JoySession } from '@/joy/types';

const NO_CTX = 'no machine context';

/** One entry per machine (status, discovery set, sessions, env names): small
 *  values, bounded by count and idle age. Picker catalogs are per machine +
 *  harness (+ directory): a few more, expired sooner. */
const MACHINE_FAMILY = 'machine';
const PICKER_FAMILY = 'picker';
resources.defineFamily(MACHINE_FAMILY, { maxEntries: 128, maxAgeMs: 60 * 60_000 });
resources.defineFamily(PICKER_FAMILY, { maxEntries: 64, maxAgeMs: 30 * 60_000 });

type DaemonResponse = { status: number; data: unknown };

/** tunnelJson returns the daemon's HTTP status WITHOUT throwing, so every
 *  read validates status + payload shape; a daemon 500 is an error that
 *  keeps the last good value, never an empty list (#322). */
function daemonError(op: string, res: DaemonResponse): string {
    const body = res.data as { error?: unknown } | null;
    const detail = typeof body?.error === 'string' ? body.error : `HTTP ${res.status}`;
    return `${op} failed: ${detail}`;
}

/** A 200 whose body says `ok: true` (or carries no ok flag at all). */
function isDaemonSuccess(res: DaemonResponse): boolean {
    if (res.status !== 200) return false;
    const body = res.data as { ok?: unknown } | null;
    return !!body && typeof body === 'object' && body.ok !== false;
}

// ── daemon status ───────────────────────────────────────────────────────────

export type JoyStatus = {
    ok?: boolean;
    version?: string;
    uptimeMs?: number;
    sessions?: number;
    messages?: number;
    clients?: number;
    pid?: number;
    os?: { platform?: string; release?: string; arch?: string; hostname?: string };
    claude?: { available: boolean; version: string | null };
};

/** One joy-status probe of a machine, bounded by `timeoutMs`. */
export function joyStatusSpec(machineId: string, timeoutMs = 4000): ResourceSpec<JoyStatus> {
    return {
        key: `joy-status:${machineId}`,
        family: MACHINE_FAMILY,
        staleTime: 10_000,
        // A status card: a reconnect may mean a daemon restart, so re-read;
        // app focus does not (10s staleTime + the screen's own focus ensure).
        refetchOnReconnect: true,
        refetchOnFocus: false,
        fetch: async ({ signal }) => {
            const ctx = sync.machineOnlyCtx(machineId);
            if (!ctx) return { kind: 'unavailable', reason: NO_CTX };
            const r = await withTimeout(machineStatusOnly(ctx), timeoutMs, signal, 'timeout');
            if (!isDaemonSuccess(r)) return { kind: 'error', reason: daemonError('status', r) };
            return { kind: 'ok', data: r.data as JoyStatus };
        },
    };
}

// ── which machines run joy-daemon ───────────────────────────────────────────

const PROBE_TIMEOUT_MS = 3000;

/**
 * The subset of `machineIds` whose daemon answered a status probe within 3s
 * with a valid success. Online machines without joy-daemon never respond
 * (the tunnel call can hang), hence the per-probe race: a probe that times
 * out, throws, or answers with a non-success status is NOT a running daemon.
 * Keyed by the probed set: a change of online machines is a new key, so a
 * run for the old set can never settle into the new one (#178).
 *
 * The outcome is `unavailable` when NO machine could even be asked (no
 * context for any of them — the tunnel is not up yet), and an `error` when
 * every probe failed on transport (the previous discovery stands); the
 * empty list is authoritative only when at least one daemon was reachable
 * and answered no.
 */
export function joyMachinesSpec(machineIds: readonly string[]): ResourceSpec<string[]> {
    const ids = Array.from(new Set(machineIds)).sort();
    return {
        key: `joy-machines:${ids.join(',')}`,
        family: MACHINE_FAMILY,
        // Discovery: daemons come and go while the app is away or offline,
        // so both app focus and a reconnect probe again (observed keys only).
        refetchOnFocus: true,
        refetchOnReconnect: true,
        fetch: async ({ signal }) => {
            if (ids.length === 0) return { kind: 'ok', data: [] };
            type Probe = 'running' | 'not-running' | 'no-ctx' | 'transport';
            const probe = async (id: string): Promise<Probe> => {
                const ctx = sync.machineOnlyCtx(id);
                if (!ctx) return 'no-ctx';
                try {
                    const r = await withTimeout(machineStatusOnly(ctx), PROBE_TIMEOUT_MS, signal, 'probe timeout');
                    // A daemon that answers a refusal is present but not usable — for
                    // the picker that is the same as absent; a 200 is a running daemon.
                    return isDaemonSuccess(r) ? 'running' : 'not-running';
                } catch (e) {
                    // A silent tunnel (no daemon to answer) times out: not running.
                    // Any other transport failure says nothing about the daemon.
                    return e instanceof Error && e.message === 'probe timeout' ? 'not-running' : 'transport';
                }
            };
            const results = await Promise.all(ids.map(probe));
            const running = ids.filter((_, i) => results[i] === 'running');
            if (running.length > 0) return { kind: 'ok', data: running };
            if (results.every((r) => r === 'no-ctx')) return { kind: 'unavailable', reason: NO_CTX };
            if (results.some((r) => r === 'transport')) throw new Error('probe failed: machine unreachable');
            return { kind: 'ok', data: [] };
        },
        retry: { attempts: 1, delayMs: 500 },
    };
}

// ── a machine's joy sessions ────────────────────────────────────────────────

export function joySessionsSpec(machineId: string): ResourceSpec<JoySession[]> {
    return {
        key: `joy-sessions:${machineId}`,
        family: MACHINE_FAMILY,
        // A live list: sessions start and end while the app is away.
        refetchOnFocus: true,
        refetchOnReconnect: true,
        fetch: async () => {
            const ctx = sync.machineOnlyCtx(machineId);
            if (!ctx) return { kind: 'unavailable', reason: NO_CTX };
            const res = await machineListSessions(ctx);
            const list = res.data?.sessions;
            if (!isDaemonSuccess(res) || !Array.isArray(list)) return { kind: 'error', reason: daemonError('list sessions', res) };
            return { kind: 'ok', data: list as unknown as JoySession[] };
        },
    };
}

// ── sealed environment names ────────────────────────────────────────────────

/** Names of the keys in the daemon's sealed environment store (never values).
 *  `unavailable: 'no_ctx'` and `error: 'no_machine_key'` both render as the
 *  locked row (joyMachineDaemonState.resolveEnvErrorRow). */
export function machineEnvSpec(machineId: string): ResourceSpec<string[]> {
    return {
        key: `machine-env:${machineId}`,
        family: MACHINE_FAMILY,
        staleTime: 5000,
        // Names can be added from another device or the CLI while the app is
        // away (focus) and the daemon may have been re-keyed (reconnect).
        refetchOnFocus: true,
        refetchOnReconnect: true,
        fetch: async () => {
            const ctx = sync.machineOnlyCtx(machineId);
            if (!ctx) return { kind: 'unavailable', reason: 'no_ctx' };
            const r = await machineEnvList(ctx);
            const names = r.data?.names;
            if (isDaemonSuccess(r) && Array.isArray(names) && names.every((n) => typeof n === 'string')) {
                return { kind: 'ok', data: names };
            }
            // The daemon's own code (no_machine_key) is the row's reason; a
            // non-200 without one is reported by status.
            const reason = typeof r.data?.error === 'string' ? r.data.error : `http_${r.status}`;
            return { kind: 'error', reason };
        },
    };
}

// ── harness model catalogs ──────────────────────────────────────────────────

export interface HarnessModel {
    /** What the harness takes on its command line (codex: `model`; opencode / agy: `id`). */
    model?: string;
    id?: string;
    providerID?: string;
    displayName: string;
    supportedReasoningEfforts?: string[];
    defaultReasoningEffort?: string | null;
    isDefault?: boolean;
}

/**
 * A harness's model catalog on a machine. Per MACHINE and harness: another
 * machine's list is another key, so it can never be selected for this one.
 *
 * Authoritative empty ONLY when the daemon says so explicitly: a 404 (an
 * older daemon without the op, or a harness it does not know) or a 200 with
 * an empty list. A 5xx, a refusal or a malformed body is an error that keeps
 * the last good catalog and is not cached as fresh.
 */
export function harnessModelsSpec(machineId: string, harness: string): ResourceSpec<HarnessModel[]> {
    return {
        key: `harness-models:${machineId}:${harness}`,
        family: PICKER_FAMILY,
        staleTime: 5 * 60_000,
        // A catalog changes when the harness is (re)installed — a reconnect
        // is the signal for that; app focus is not (5 min staleTime covers the
        // screen's own re-ensure on focus).
        refetchOnReconnect: true,
        refetchOnFocus: false,
        fetch: async () => {
            const ctx = sync.machineOnlyCtx(machineId);
            if (!ctx) return { kind: 'unavailable', reason: NO_CTX };
            const r = await machineHarnessModels(ctx, harness);
            if (r.status === 404) return { kind: 'ok', data: [] }; // the daemon has no such op or harness
            const models = r.data?.models;
            if (!isDaemonSuccess(r) || !Array.isArray(models)) return { kind: 'error', reason: daemonError('models', r) };
            return { kind: 'ok', data: models as unknown as HarnessModel[] };
        },
    };
}

// ── past sessions for the resume picker ─────────────────────────────────────

export interface PastSessionRow {
    id: string;
    title: string | null;
    updatedAt: number;
    sizeBytes: number | null;
}

/**
 * Resumable conversations of ONE machine + directory + harness (#153): the
 * key is the context, so a row fetched for project A can never be listed —
 * or submitted as a resume id — under project B, and A's slow answer lands
 * in A's cache only.
 */
export function pastSessionsSpec(machineId: string, cwd: string, agent: 'claude' | 'opencode'): ResourceSpec<PastSessionRow[]> {
    return {
        key: `past-sessions:${pastSessionsContextKey({ machineId, cwd, agent })}`,
        family: PICKER_FAMILY,
        staleTime: 30_000,
        // History grows on the machine while the app is away or offline:
        // both app focus and a reconnect re-list an open picker.
        refetchOnFocus: true,
        refetchOnReconnect: true,
        fetch: async (): Promise<ResourceOutcome<PastSessionRow[]>> => {
            const ctx = sync.machineOnlyCtx(machineId);
            if (!ctx) return { kind: 'unavailable', reason: NO_CTX };
            if (agent === 'opencode') {
                const r = await machineOpencodeSessions(ctx, cwd);
                const rows = r.data?.sessions;
                if (!isDaemonSuccess(r) || !Array.isArray(rows)) return { kind: 'error', reason: daemonError('opencode sessions', r) };
                const list = rows as unknown as { id: string; title?: string; updatedAt: number }[];
                return { kind: 'ok', data: list.map((s) => ({ id: s.id, title: s.title ?? null, updatedAt: s.updatedAt, sizeBytes: null })) };
            }
            const r = await machineHistoryLogs(ctx, cwd);
            const logs = r.data?.logs;
            if (!isDaemonSuccess(r) || !Array.isArray(logs)) return { kind: 'error', reason: daemonError('history', r) };
            const list = logs as unknown as { sessionId: string; sizeBytes: number; mtimeMs: number }[];
            return {
                kind: 'ok',
                data: list
                    .map((l) => ({ id: l.sessionId, title: null, updatedAt: l.mtimeMs, sizeBytes: l.sizeBytes }))
                    .sort((a, b) => b.updatedAt - a.updatedAt),
            };
        },
    };
}
