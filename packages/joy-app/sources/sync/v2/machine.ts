/**
 * Machine-plane client — the app's calls to a session's DAEMON over the
 * sealed tunnel (/v2/* on the daemon). Replaces the happy-socket RPCs for
 * v2 sessions: files, git, terminal, usage, harness config, history.
 *
 * Every call needs (a) the machine id the session runs on and (b) the
 * account master secret, which derives the tunnel key. Both come from the
 * caller so this module stays free of app-state coupling.
 */
import { tunnelJson, tunnelFetch, TunnelError } from './tunnel';

export interface MachineCtx {
    relayUrl: string;
    accountToken: string;
    machineKey: Uint8Array;
    machineId: string;
    /** The daemon-LOCAL session id (window id), not the relay session id. */
    localSessionId: string;
}

const j = <T>(ctx: MachineCtx, method: string, path: string, body?: unknown) =>
    tunnelJson<T>({
        relayUrl: ctx.relayUrl, accountToken: ctx.accountToken, machineKey: ctx.machineKey,
        machineId: ctx.machineId, method, path, json: body,
    });

// ── git ────────────────────────────────────────────────────────────────────
export interface V2GitStatus {
    ok: boolean;
    branch: string | null; oid: string | null; upstream: string | null;
    ahead: number; behind: number; clean: boolean;
    entries: Array<{ path: string; staged: string; unstaged: string; untracked?: boolean; conflicted?: boolean; renamedFrom?: string }>;
    error?: string;
}
export const machineGitStatus = (ctx: MachineCtx) =>
    j<V2GitStatus>(ctx, 'GET', `/v2/sessions/${ctx.localSessionId}/git/status`);

export const machineGitDiff = (ctx: MachineCtx, opts?: { staged?: boolean; path?: string; numstat?: boolean }) =>
    j<{ ok: boolean; diff?: string; error?: string }>(ctx, 'GET',
        `/v2/sessions/${ctx.localSessionId}/git/diff?staged=${opts?.staged ? 1 : 0}${opts?.numstat ? '&numstat=1' : ''}${opts?.path ? `&path=${encodeURIComponent(opts.path)}` : ''}`);

// ── files ──────────────────────────────────────────────────────────────────
export const machineReadFile = (ctx: MachineCtx, path: string) =>
    j<{ success: boolean; content?: string; error?: string }>(ctx, 'GET',
        `/v2/sessions/${ctx.localSessionId}/files/content?path=${encodeURIComponent(path)}`);

export const machineWriteFile = (ctx: MachineCtx, path: string, content: string, expectedHash?: string) =>
    j<{ success: boolean; hash?: string; error?: string }>(ctx, 'PUT',
        `/v2/sessions/${ctx.localSessionId}/files/content`, { path, content, ...(expectedHash ? { expectedHash } : {}) });

export const machineDeleteFile = (ctx: MachineCtx, path: string) =>
    j<{ success: boolean; error?: string }>(ctx, 'DELETE',
        `/v2/sessions/${ctx.localSessionId}/files/content?path=${encodeURIComponent(path)}`);

export const machineListDir = (ctx: MachineCtx, path: string, depth = 1) =>
    j<{ success: boolean; entries?: unknown[]; tree?: unknown; error?: string }>(ctx, 'GET',
        `/v2/sessions/${ctx.localSessionId}/files/entries?path=${encodeURIComponent(path)}&depth=${depth}`);

export const machineGrep = (ctx: MachineCtx, q: string, opts?: { path?: string; glob?: string; caseSensitive?: boolean; maxResults?: number }) =>
    j<{ success: boolean; stdout?: string; error?: string }>(ctx, 'GET',
        `/v2/sessions/${ctx.localSessionId}/files/grep?q=${encodeURIComponent(q)}`
        + (opts?.path ? `&path=${encodeURIComponent(opts.path)}` : '')
        + (opts?.glob ? `&glob=${encodeURIComponent(opts.glob)}` : '')
        + (opts?.caseSensitive ? '&caseSensitive=1' : '')
        + (opts?.maxResults ? `&maxResults=${opts.maxResults}` : ''));

// ── terminal ───────────────────────────────────────────────────────────────
export const machinePane = (ctx: MachineCtx, color = false) =>
    j<{ ok?: boolean; text?: string; error?: string }>(ctx, 'GET',
        `/v2/sessions/${ctx.localSessionId}/terminal?color=${color ? 1 : 0}`);

export const machineResize = (ctx: MachineCtx, cols: number, rows: number) =>
    j<{ ok?: boolean; error?: string }>(ctx, 'PATCH', `/v2/sessions/${ctx.localSessionId}/terminal`, { cols, rows });

export const machineSendKeys = (ctx: MachineCtx, script: string, literal = false) =>
    j<{ ok?: boolean; error?: string }>(ctx, 'POST', `/v2/sessions/${ctx.localSessionId}/terminal/keys`, { script, literal });

// ── session control ────────────────────────────────────────────────────────
export const machineSessionInfo = (ctx: MachineCtx) =>
    j<Record<string, unknown>>(ctx, 'GET', `/v2/sessions/${ctx.localSessionId}`);

export const machineKillSession = (ctx: MachineCtx) =>
    j<{ ok: boolean }>(ctx, 'DELETE', `/v2/sessions/${ctx.localSessionId}`);

export const machineRestartSession = (ctx: MachineCtx) =>
    j<{ ok: boolean; relaySessionId?: string }>(ctx, 'POST', `/v2/sessions/${ctx.localSessionId}/restart`);

export const machineSetMode = (ctx: MachineCtx, permissionMode: string) =>
    j<{ ok?: boolean; error?: string }>(ctx, 'PATCH', `/v2/sessions/${ctx.localSessionId}`, { permissionMode });

// ── machine-wide ───────────────────────────────────────────────────────────
export const machineStatus = (ctx: MachineCtx) => j<Record<string, unknown>>(ctx, 'GET', '/v2/status');
export const machineUsage = (ctx: MachineCtx, period = '30days') =>
    j<Record<string, unknown>>(ctx, 'GET', `/v2/usage?period=${encodeURIComponent(period)}`);
export const machineLimits = (ctx: MachineCtx, harness: string) =>
    j<Record<string, unknown>>(ctx, 'GET', `/v2/harnesses/${encodeURIComponent(harness)}/limits`);
/** This session's cost row (period like joy-usage plus "all"). Session-scoped:
 *  the daemon resolves the claude session id, so no extra round-trip here. */
export const machineSessionUsage = (ctx: MachineCtx, period = 'all') =>
    j<{ ok?: boolean; entry?: unknown; error?: string }>(ctx, 'GET', `/v2/sessions/${ctx.localSessionId}/usage?period=${encodeURIComponent(period)}`);

export const machineSlashCommands = (ctx: MachineCtx) =>
    j<{ slashCommands: string[] }>(ctx, 'GET', `/v2/sessions/${ctx.localSessionId}/slash-commands`);

// ── machine-wide (no session id needed) ────────────────────────────────────
/** Context for machine-scoped calls; localSessionId is unused by these. */
export type MachineOnlyCtx = Omit<MachineCtx, 'localSessionId'> & { localSessionId?: string };

const jm = <T>(ctx: MachineOnlyCtx, method: string, path: string, body?: unknown) =>
    tunnelJson<T>({
        relayUrl: ctx.relayUrl, accountToken: ctx.accountToken, machineKey: ctx.machineKey,
        machineId: ctx.machineId, method, path, json: body,
    });

export const machineStatusOnly = (ctx: MachineOnlyCtx) => jm<Record<string, unknown>>(ctx, 'GET', '/v2/status');
export const machineUsageOnly = (ctx: MachineOnlyCtx, period = '30days') =>
    jm<Record<string, unknown>>(ctx, 'GET', `/v2/usage?period=${encodeURIComponent(period)}`);
export const machineLimitsOnly = (ctx: MachineOnlyCtx, harness: string) =>
    jm<Record<string, unknown>>(ctx, 'GET', `/v2/harnesses/${encodeURIComponent(harness)}/limits`);
export const machineConfigRead = (ctx: MachineOnlyCtx, harness: string) =>
    jm<Record<string, unknown>>(ctx, 'GET', `/v2/harnesses/${encodeURIComponent(harness)}/config`);
export const machineConfigSchema = (ctx: MachineOnlyCtx, harness: string) =>
    jm<Record<string, unknown>>(ctx, 'GET', `/v2/harnesses/${encodeURIComponent(harness)}/config/schema`);
export const machineConfigWrite = (ctx: MachineOnlyCtx, harness: string, raw: string) =>
    jm<Record<string, unknown>>(ctx, 'PUT', `/v2/harnesses/${encodeURIComponent(harness)}/config`, { raw });
export const machineConfigSet = (ctx: MachineOnlyCtx, harness: string, edits: string[]) =>
    jm<Record<string, unknown>>(ctx, 'PATCH', `/v2/harnesses/${encodeURIComponent(harness)}/config`, { edits });
export const machineHistory = (ctx: MachineOnlyCtx, directory: string) =>
    jm<Record<string, unknown>>(ctx, 'GET', `/v2/history?directory=${encodeURIComponent(directory)}`);
export const machineHistoryMessages = (ctx: MachineOnlyCtx, directory: string, sessionId: string, limit = 10) =>
    jm<Record<string, unknown>>(ctx, 'GET', `/v2/history/${encodeURIComponent(sessionId)}/messages?directory=${encodeURIComponent(directory)}&limit=${limit}`);
export const machineSlashCommandsAll = (ctx: MachineOnlyCtx, refresh = false) =>
    jm<{ slashCommands: string[] }>(ctx, 'GET', `/v2/slash-commands${refresh ? '?refresh=1' : ''}`);

export { TunnelError, tunnelFetch };
