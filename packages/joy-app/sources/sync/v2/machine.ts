/**
 * Machine-plane client — the app's calls to a session's DAEMON over the
 * sealed tunnel (/v2/* on the daemon). Replaces the old socket RPCs for
 * v2 sessions: files, git, terminal, usage, harness config, history.
 *
 * Every call needs (a) the machine id the session runs on and (b) the
 * account master secret, which derives the tunnel key. Both come from the
 * caller so this module stays free of app-state coupling.
 */
import { tunnelJson, tunnelFetch as rawTunnelFetch, TunnelError, type TunnelFetchOpts, type TunnelResponse } from './tunnel';
import { t } from '@/text';

/** Refusals that mean "this machine's daemon predates the protocol the app
 *  speaks" (#418: a reply with no request binding is indistinguishable from a
 *  replay and is refused). Every screen shows `e.message`, so the wording is
 *  applied here once; `.code` keeps the raw reason for logs. */
const DAEMON_OUTDATED_CODES = new Set(['unbound_response', 'bad_response_head']);
async function userFacing<T>(p: Promise<T>): Promise<T> {
    try { return await p; }
    catch (e) {
        if (e instanceof TunnelError && DAEMON_OUTDATED_CODES.has(e.code)) throw new TunnelError(e.status, e.code, t('errors.daemonOutdated'));
        throw e;
    }
}

export interface MachineCtx {
    relayUrl: string;
    accountToken: string;
    machineKey: Uint8Array;
    machineId: string;
    /** The daemon-LOCAL session id (window id), not the relay session id. */
    localSessionId: string;
}

const j = <T>(ctx: MachineCtx, method: string, path: string, body?: unknown) =>
    userFacing(tunnelJson<T>({
        relayUrl: ctx.relayUrl, accountToken: ctx.accountToken, machineKey: ctx.machineKey,
        machineId: ctx.machineId, method, path, json: body,
    }));

// ── git ────────────────────────────────────────────────────────────────────
// Structured git status, schema v2 — the daemon parses git's machine formats
// once (docs/API.md, "Structured git status"); the app renders these facts
// and never reads git text. Mirrors packages/joy-daemon/src/domain/gitStatus.ts.

/** Exact per-side line counts, or an explicit "unknown" — never a silent zero. */
export type GitLineCount = { added: number; removed: number } | 'unavailable';

/** A filename as IDENTITY (`cwd`: send this back to files/* and git/diff)
 *  and as DISPLAY (`display`: show this; control characters are pictured,
 *  undecodable bytes are U+FFFD). `repo` is the same identity relative to the
 *  repository root. When `utf8` is false the strings are lossy and
 *  `rawBase64` carries the exact repo-relative bytes. */
export interface GitPathV2 {
    repo: string;
    cwd: string;
    display: string;
    utf8: boolean;
    rawBase64?: string;
}

export interface GitStatusEntryV2 {
    path: GitPathV2;
    /** Porcelain XY letters for the index and worktree columns; '.' = unchanged. */
    index: string;
    worktree: string;
    untracked: boolean;
    /** Every unmerged record, AA and DD included. */
    conflict: { xy: string } | null;
    rename: { from: GitPathV2; score: number | null; copy: boolean } | null;
    submodule: boolean;
    binary: boolean | null;
    lines: { staged: GitLineCount; unstaged: GitLineCount };
}

export type GitHeadV2 =
    | { kind: 'branch'; name: string; oid: string }
    | { kind: 'detached'; oid: string }
    | { kind: 'unborn'; name: string | null };

export interface GitBranchRefV2 {
    name: string;
    oid: string;
    current: boolean;
    worktree: string | null;
    upstream: string | null;
}

export interface GitStatusRepoV2 {
    v: 2;
    ok: true;
    relation: 'root' | 'inside';
    cwd: string;
    repository: { root: string; gitDir: string; commonDir: string; linkedWorktree: boolean; prefix: string };
    head: GitHeadV2;
    upstream: { name: string; ahead: number | null; behind: number | null } | null;
    operation: 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'bisect' | null;
    stashCount: number;
    branches: GitBranchRefV2[];
    entries: GitStatusEntryV2[];
    totals: {
        staged: GitLineCount;
        unstaged: GitLineCount;
        counts: { staged: number; unstaged: number; untracked: number; conflicted: number; entries: number };
    };
    clean: boolean;
}

export type GitStatusV2 =
    | GitStatusRepoV2
    | { v: 2; ok: true; relation: 'none'; cwd: string }
    | { v: 2; ok: false; code: 'git_missing' | 'git_failed' | 'timeout'; error: string };

// ── REMOVE once every daemon runs a release with ?v=2 (2026-09) ─────────────
// An older daemon ignores the `v` query and answers its original shape (no
// `v` field). It is folded into the structured shape with every line count
// 'unavailable' — the old numstat text is NOT parsed here.
interface LegacyGitStatus {
    ok: boolean;
    branch: string | null; oid: string | null; upstream: string | null;
    ahead: number; behind: number; clean: boolean;
    entries: Array<{ path: string; staged: string; unstaged: string; untracked?: boolean; conflicted?: boolean; renamedFrom?: string }>;
    error?: string;
}
function legacyToStructured(d: LegacyGitStatus, cwd: string): GitStatusV2 {
    if (!d.ok) {
        // The old shape folded "not a repository" and "git failed" into one
        // ok:false + stderr; only git's own wording is an authoritative not-a-repo.
        if (/not a git repository|must be run in a work tree/i.test(d.error ?? '')) return { v: 2, ok: true, relation: 'none', cwd };
        return { v: 2, ok: false, code: 'git_failed', error: d.error ?? 'git failed' };
    }
    const path = (p: string): GitPathV2 => ({ repo: p, cwd: p, display: p, utf8: true });
    const counts = { staged: 0, unstaged: 0, untracked: 0, conflicted: 0, entries: 0 };
    const entries: GitStatusEntryV2[] = (d.entries ?? []).map((e) => {
        counts.entries++;
        if (e.untracked) counts.untracked++;
        else if (e.conflicted) counts.conflicted++;
        else {
            if (e.staged) counts.staged++;
            if (e.unstaged) counts.unstaged++;
        }
        return {
            path: path(e.path),
            index: e.untracked ? '?' : e.staged || '.',
            worktree: e.untracked ? '?' : e.unstaged || '.',
            untracked: !!e.untracked,
            conflict: e.conflicted ? { xy: `${e.staged || 'U'}${e.unstaged || 'U'}` } : null,
            rename: e.renamedFrom !== undefined ? { from: path(e.renamedFrom), score: null, copy: false } : null,
            submodule: false,
            binary: null,
            lines: { staged: 'unavailable', unstaged: 'unavailable' },
        };
    });
    return {
        v: 2, ok: true, relation: 'root', cwd,
        repository: { root: cwd, gitDir: '', commonDir: '', linkedWorktree: false, prefix: '' },
        head: d.branch ? { kind: 'branch', name: d.branch, oid: d.oid ?? '' } : { kind: 'detached', oid: d.oid ?? '' },
        upstream: d.upstream ? { name: d.upstream, ahead: d.ahead ?? null, behind: d.behind ?? null } : null,
        operation: null,
        stashCount: 0,
        branches: [],
        entries,
        totals: { staged: 'unavailable', unstaged: 'unavailable', counts },
        clean: entries.length === 0,
    };
}
// ── end REMOVE ───────────────────────────────────────────────────────────────

/** Structured git status (v=2). `data` is null only when the daemon sent no
 *  JSON body; an old daemon's answer is folded into the v2 shape (see above). */
export const machineGitStatus = async (ctx: MachineCtx): Promise<{ status: number; data: GitStatusV2 | null }> => {
    const r = await j<GitStatusV2 | LegacyGitStatus>(ctx, 'GET', `/v2/sessions/${ctx.localSessionId}/git/status?v=2`);
    if (r.status !== 200 || !r.data) return { status: r.status, data: null };
    if ('v' in r.data && r.data.v === 2) return { status: r.status, data: r.data };
    return { status: r.status, data: legacyToStructured(r.data as LegacyGitStatus, '') }; // REMOVE with the legacy block
};

export const machineGitDiff = (ctx: MachineCtx, opts?: { staged?: boolean; head?: boolean; path?: string; numstat?: boolean }) =>
    j<{ ok: boolean; diff?: string; error?: string }>(ctx, 'GET',
        `/v2/sessions/${ctx.localSessionId}/git/diff?staged=${opts?.staged ? 1 : 0}${opts?.head ? '&head=1' : ''}${opts?.numstat ? '&numstat=1' : ''}${opts?.path ? `&path=${encodeURIComponent(opts.path)}` : ''}`);

/** Tracked (+ untracked, not ignored) files of the session's repo, relative paths. */
export const machineGitEntries = (ctx: MachineCtx, opts?: { untracked?: boolean; path?: string }) =>
    j<{ ok: boolean; files?: string[]; error?: string }>(ctx, 'GET',
        `/v2/sessions/${ctx.localSessionId}/git/entries?untracked=${opts?.untracked ? 1 : 0}${opts?.path ? `&path=${encodeURIComponent(opts.path)}` : ''}`);

/** Interrupt whatever turn the agent is running, relay-started or not (#8). */
export const machineAbort = (ctx: MachineCtx) =>
    j<{ ok?: boolean; error?: string }>(ctx, 'POST', `/v2/sessions/${ctx.localSessionId}/abort`, {});

// ── files ──────────────────────────────────────────────────────────────────
export const machineReadFile = (ctx: MachineCtx, path: string) =>
    j<{ success: boolean; content?: string; error?: string }>(ctx, 'GET',
        `/v2/sessions/${ctx.localSessionId}/files/content?path=${encodeURIComponent(path)}`);

/** `encoding` MUST match how `content` is encoded: the daemon decodes as utf8
 *  unless told 'base64'. The editor sent base64 without saying so and files
 *  were overwritten with their own base64 text (issue #93). */
export const machineWriteFile = (ctx: MachineCtx, path: string, content: string, expectedHash?: string, encoding: 'utf8' | 'base64' = 'utf8') =>
    j<{ success: boolean; hash?: string; error?: string }>(ctx, 'PUT',
        `/v2/sessions/${ctx.localSessionId}/files/content`, { path, content, encoding, ...(expectedHash ? { expectedHash } : {}) });

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

/** `ifStatus` makes the kill conditional on the daemon's CURRENT status at
 *  the instant of the decision (409 status_mismatch otherwise) — the
 *  detached-session cleanup passes 'ended' so a session that restarted after
 *  the user confirmed is never killed (#174). */
export const machineKillSession = (ctx: MachineCtx, opts?: { ifStatus?: 'ended' | 'active' | 'starting' }) =>
    j<{ ok: boolean; error?: string; status?: string }>(ctx, 'DELETE', `/v2/sessions/${ctx.localSessionId}${opts?.ifStatus ? `?ifStatus=${opts.ifStatus}` : ''}`);

export const machineRestartSession = (ctx: MachineCtx) =>
    j<{ ok: boolean; relaySessionId?: string }>(ctx, 'POST', `/v2/sessions/${ctx.localSessionId}/restart`);

export const machineSetModel = (ctx: MachineCtx, model: string) =>
    j<{ ok?: boolean; error?: string }>(ctx, 'PATCH', `/v2/sessions/${ctx.localSessionId}`, { model });

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
    userFacing(tunnelJson<T>({
        relayUrl: ctx.relayUrl, accountToken: ctx.accountToken, machineKey: ctx.machineKey,
        machineId: ctx.machineId, method, path, json: body,
    }));

export const machineHarnessModels = (ctx: MachineOnlyCtx, harness: string) =>
    jm<{ ok?: boolean; models?: Array<Record<string, unknown>>; error?: string }>(ctx, 'GET', `/v2/harnesses/${encodeURIComponent(harness)}/models`);
export const machineHistoryLogs = (ctx: MachineOnlyCtx, directory: string) =>
    jm<{ ok?: boolean; logs?: Array<Record<string, unknown>>; sessions?: Array<Record<string, unknown>>; error?: string }>(ctx, 'GET', `/v2/history?directory=${encodeURIComponent(directory)}`);
export const machineSessionUsageAll = (ctx: MachineOnlyCtx, period = '30days') =>
    jm<{ ok?: boolean; sessions?: unknown[] }>(ctx, 'GET', `/v2/usage/sessions?period=${encodeURIComponent(period)}`);
export const machineSessionInfoFor = (ctx: MachineOnlyCtx, localSessionId: string) =>
    jm<Record<string, unknown>>(ctx, 'GET', `/v2/sessions/${encodeURIComponent(localSessionId)}`);
export const machineSessionLog = (ctx: MachineOnlyCtx, localSessionId: string) =>
    jm<{ ok?: boolean; lines?: unknown[]; log?: unknown[]; error?: string }>(ctx, 'GET', `/v2/sessions/${encodeURIComponent(localSessionId)}/log`);
/** Hand a session's work to another model (returns at once; progress rides joy__handoff). */
export const machineHandoff = (ctx: MachineOnlyCtx, localSessionId: string, body: { agent: string; model?: string; effort?: string; permissionMode?: string }) =>
    jm<{ ok?: boolean; pending?: boolean; note?: string; error?: string }>(ctx, 'POST', `/v2/sessions/${encodeURIComponent(localSessionId)}/handoff`, body);
export const machineHandback = (ctx: MachineOnlyCtx, localSessionId: string) =>
    jm<{ ok?: boolean; pending?: boolean; note?: string; error?: string }>(ctx, 'POST', `/v2/sessions/${encodeURIComponent(localSessionId)}/handback`, {});
/** Fork a session from its last message into a NEW session on the same machine. */
export const machineForkSession = (ctx: MachineOnlyCtx, localSessionId: string) =>
    jm<{ ok?: boolean; localSessionId?: string; error?: string }>(ctx, 'POST', `/v2/sessions/${encodeURIComponent(localSessionId)}/fork`, {});
/** Package a session's conversation for another machine (transcript tail, base64). */
export const machineTeleportExport = (ctx: MachineOnlyCtx, localSessionId: string) =>
    jm<{ ok?: boolean; agent?: string; claudeSessionId?: string; cwd?: string; model?: string; permissionMode?: string; bytes?: number; truncated?: boolean; transcriptBase64?: string; error?: string }>(ctx, 'POST', `/v2/sessions/${encodeURIComponent(localSessionId)}/teleport-export`, {});
/** Land a teleported conversation on THIS machine in `cwd` and resume it. */
export const machineTeleportImport = (ctx: MachineOnlyCtx, body: { cwd: string; claudeSessionId: string; transcriptBase64: string; model?: string; permissionMode?: string; createDir?: boolean }) =>
    jm<{ ok?: boolean; localSessionId?: string; error?: string }>(ctx, 'POST', '/v2/teleport-import', body);
export const machineRestartSessionFor = (ctx: MachineOnlyCtx, localSessionId: string, body?: Record<string, unknown>) =>
    jm<{ ok?: boolean; relaySessionId?: string; error?: string }>(ctx, 'POST', `/v2/sessions/${encodeURIComponent(localSessionId)}/restart`, body ?? {});
export const machineKillSessionFor = (ctx: MachineOnlyCtx, localSessionId: string) =>
    jm<{ ok?: boolean }>(ctx, 'DELETE', `/v2/sessions/${encodeURIComponent(localSessionId)}`);
export const machineOpencodeSessions = (ctx: MachineOnlyCtx, cwd: string) =>
    jm<{ ok?: boolean; sessions?: Array<Record<string, unknown>>; error?: string }>(ctx, 'GET', `/v2/harnesses/opencode/sessions?cwd=${encodeURIComponent(cwd)}`);
export const machineListSessions = (ctx: MachineOnlyCtx) =>
    jm<{ sessions?: Array<Record<string, unknown>> }>(ctx, 'GET', '/v2/sessions');
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

/** Raw-bytes tunnel call with the same user-facing refusal wording as the JSON helpers. */
export const tunnelFetch = (opts: TunnelFetchOpts): Promise<TunnelResponse> => userFacing(rawTunnelFetch(opts));
export { TunnelError };

// ── sealed environment store (provider keys every new session inherits) ────
export const machineEnvList = (ctx: MachineOnlyCtx) =>
    jm<{ ok?: boolean; names?: string[]; error?: string }>(ctx, 'GET', '/v2/env');
export const machineEnvSet = (ctx: MachineOnlyCtx, name: string, value: string) =>
    jm<{ ok?: boolean; error?: string }>(ctx, 'POST', '/v2/env', { name, value });
export const machineEnvUnset = (ctx: MachineOnlyCtx, name: string) =>
    jm<{ ok?: boolean; existed?: boolean; error?: string }>(ctx, 'DELETE', `/v2/env/${encodeURIComponent(name)}`);
