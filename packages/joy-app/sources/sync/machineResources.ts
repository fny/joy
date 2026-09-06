/**
 * Machine-level reads as resources (sync/resource): the daemon's status,
 * which machines run joy-daemon, a machine's session list, its sealed
 * environment names, harness model catalogs and past-session pickers.
 *
 * Each key carries the real identity (machine; machine + harness; machine +
 * directory + harness), so a late answer for machine A can only ever land
 * in A's cache — the screens that used to fence this with generation tokens
 * (#153, #178, #179, #226) now just read the entry for the identity on
 * screen. A machine without a context yet is `unavailable` (the screen shows
 * a locked row or keeps Create enabled), a daemon refusal is an `error`.
 */
import { sync } from './sync';
import {
    machineEnvList, machineHarnessModels, machineHistoryLogs, machineListSessions,
    machineOpencodeSessions, machineStatusOnly,
} from './v2/machine';
import { withTimeout, type ResourceSpec } from './resource';
import { pastSessionsContextKey } from '@/utils/pastSessionsContext';
import type { JoySession } from '@/joy/types';

const NO_CTX = 'no machine context';

/** tunnelJson returns the daemon's HTTP status WITHOUT throwing, so every
 *  read validates status + payload shape; a daemon 500 is an error that
 *  keeps the last good value, never an empty list (#322). */
function daemonError(op: string, res: { status: number; data: unknown }): string {
    const body = res.data as { error?: unknown } | null;
    const detail = typeof body?.error === 'string' ? body.error : `HTTP ${res.status}`;
    return `${op} failed: ${detail}`;
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
        staleTime: 10_000,
        fetch: async ({ signal }) => {
            const ctx = sync.machineOnlyCtx(machineId);
            if (!ctx) return { kind: 'unavailable', reason: NO_CTX };
            const r = await withTimeout(machineStatusOnly(ctx), timeoutMs, signal, 'timeout');
            if (r.status !== 200 || !r.data) return { kind: 'error', reason: daemonError('status', r) };
            return { kind: 'ok', data: r.data as JoyStatus };
        },
    };
}

// ── which machines run joy-daemon ───────────────────────────────────────────

const PROBE_TIMEOUT_MS = 3000;

/**
 * The subset of `machineIds` whose daemon answered a status probe within 3s.
 * Online machines without joy-daemon never respond (the tunnel call can
 * hang), hence the per-probe race. Keyed by the probed set: a change of
 * online machines is a new key, so a run for the old set can never settle
 * into the new one (#178).
 */
export function joyMachinesSpec(machineIds: readonly string[]): ResourceSpec<string[]> {
    const ids = Array.from(new Set(machineIds)).sort();
    return {
        key: `joy-machines:${ids.join(',')}`,
        fetch: async ({ signal }) => {
            const probe = async (id: string): Promise<string> => {
                const ctx = sync.machineOnlyCtx(id);
                if (!ctx) throw new Error(NO_CTX);
                await withTimeout(machineStatusOnly(ctx), PROBE_TIMEOUT_MS, signal, 'probe timeout');
                return id;
            };
            const results = await Promise.allSettled(ids.map(probe));
            return { kind: 'ok', data: results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : [])) };
        },
    };
}

// ── a machine's joy sessions ────────────────────────────────────────────────

export function joySessionsSpec(machineId: string): ResourceSpec<JoySession[]> {
    return {
        key: `joy-sessions:${machineId}`,
        refetchOnFocus: true,
        refetchOnReconnect: true,
        fetch: async () => {
            const ctx = sync.machineOnlyCtx(machineId);
            if (!ctx) return { kind: 'unavailable', reason: NO_CTX };
            const res = await machineListSessions(ctx);
            const list = res.data?.sessions;
            if (res.status !== 200 || !Array.isArray(list)) return { kind: 'error', reason: daemonError('list sessions', res) };
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
        staleTime: 5000,
        refetchOnReconnect: true,
        fetch: async () => {
            const ctx = sync.machineOnlyCtx(machineId);
            if (!ctx) return { kind: 'unavailable', reason: 'no_ctx' };
            const r = await machineEnvList(ctx);
            if (r.data?.ok) return { kind: 'ok', data: r.data.names ?? [] };
            return { kind: 'error', reason: r.data?.error ?? `http_${r.status}` };
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

/** A harness's model catalog on a machine. Per MACHINE and harness: another
 *  machine's list is another key, so it can never be selected for this one. */
export function harnessModelsSpec(machineId: string, harness: string): ResourceSpec<HarnessModel[]> {
    return {
        key: `harness-models:${machineId}:${harness}`,
        staleTime: 5 * 60_000,
        fetch: async () => {
            const ctx = sync.machineOnlyCtx(machineId);
            if (!ctx) return { kind: 'unavailable', reason: NO_CTX };
            const r = await machineHarnessModels(ctx, harness);
            const models = r.data?.models as HarnessModel[] | undefined;
            // An op the daemon lacks (older daemon) or a harness that is not
            // installed: an authoritative empty catalog, the chip stays empty.
            if (r.status !== 200 || !r.data?.ok || !Array.isArray(models)) return { kind: 'ok', data: [] };
            return { kind: 'ok', data: models };
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
        staleTime: 30_000,
        fetch: async () => {
            const ctx = sync.machineOnlyCtx(machineId);
            if (!ctx) return { kind: 'unavailable', reason: NO_CTX };
            if (agent === 'opencode') {
                const r = await machineOpencodeSessions(ctx, cwd);
                if (!r.data?.ok) return { kind: 'error', reason: r.data?.error ?? `HTTP ${r.status}` };
                const rows = (r.data.sessions ?? []) as { id: string; title?: string; updatedAt: number }[];
                return { kind: 'ok', data: rows.map((s) => ({ id: s.id, title: s.title ?? null, updatedAt: s.updatedAt, sizeBytes: null })) };
            }
            const r = await machineHistoryLogs(ctx, cwd);
            if (!r.data?.ok) return { kind: 'error', reason: r.data?.error ?? `HTTP ${r.status}` };
            const logs = (r.data.logs ?? []) as { sessionId: string; sizeBytes: number; mtimeMs: number }[];
            return {
                kind: 'ok',
                data: logs
                    .map((l) => ({ id: l.sessionId, title: null, updatedAt: l.mtimeMs, sizeBytes: l.sizeBytes }))
                    .sort((a, b) => b.updatedAt - a.updatedAt),
            };
        },
    };
}
