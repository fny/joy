/**
 * Session and machine operations.
 *
 * Every call here rides one of two v2 lanes:
 *  - the relay's account plane (`/joy/v2/machines`, `/joy/v2/sessions`) for
 *    records the relay owns, and
 *  - the sealed E2E tunnel to the session's DAEMON (`/v2/*` on the daemon)
 *    for anything that touches the machine: files, git, bash, kill, restart.
 */

import { v2, v2ActiveTurn, v2CancelTurn, V2ApiError } from './v2/api';
import { machineReadFile, machineWriteFile, machineDeleteFile, machineGrep, machineHistory, machineHistoryMessages, machineKillSession, type MachineCtx, type MachineOnlyCtx, machineGitDiff, machineAbort } from './v2/machine';
import { tunnelJson } from './v2/tunnel';
import { storage } from './storage';
import { sync } from './sync';
import type { MachineMetadata } from './storageTypes';
import { approvalResponseError, resolveMetadataConflict } from './opsGuards';

// Strict type definitions for all operations

// Bash operation types
interface SessionBashRequest {
    command: string;
    cwd?: string;
    timeout?: number;
}

interface SessionBashResponse {
    success: boolean;
    stdout: string;
    stderr: string;
    exitCode: number;
    error?: string;
}

interface SessionReadFileResponse {
    success: boolean;
    content?: string; // base64 encoded
    error?: string;
    /** Set with `success: false`: what kind of failure (see OpsFailure). */
    failure?: OpsFailure;
    size?: number;
}

interface SessionWriteFileResponse {
    success: boolean;
    hash?: string;
    error?: string;
}

interface SessionDeleteFileResponse {
    success: boolean;
    error?: string;
}

interface SessionRipgrepResponse {
    success: boolean;
    exitCode?: number;
    stdout?: string;
    stderr?: string;
    error?: string;
}

interface SessionKillResponse {
    success: boolean;
    message: string;
}

/** The session has no machine context yet (no tunnel, key not derived). */
class NoMachineContextError extends Error {
    constructor(what: string) {
        super(`${what}: machine key not available yet`);
        this.name = 'NoMachineContextError';
    }
}
const noCtx = (what: string) => new NoMachineContextError(what);

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : 'Unknown error');

/**
 * Why a read did not succeed, for callers with a retry/unavailable policy
 * (sync/fileContents): `no-context` — the request could not be made;
 * `transport` — the tunnel threw or timed out (worth a bounded retry);
 * `daemon` — the daemon answered and refused (terminal).
 */
export type OpsFailure = 'no-context' | 'transport' | 'daemon';
const failureOf = (error: unknown): OpsFailure => (error instanceof NoMachineContextError ? 'no-context' : 'transport');

/** Tunnel call to a daemon path (machine-scoped). */
const daemonJson = <T>(ctx: MachineOnlyCtx, method: string, path: string, body?: unknown) =>
    tunnelJson<T>({
        relayUrl: ctx.relayUrl, accountToken: ctx.accountToken, machineKey: ctx.machineKey,
        machineId: ctx.machineId, method, path, json: body,
    });

/**
 * Permanently remove a machine record from the relay. Sessions spawned by the
 * machine are preserved; only the machine row is deleted.
 */
export async function machineDelete(machineId: string): Promise<{ success: boolean; message?: string }> {
    try {
        await v2.deleteMachine(machineId);
        return { success: true };
    } catch (error) {
        return { success: false, message: errorMessage(error) };
    }
}

/**
 * Kill every session on a machine (active + detached tmux windows).
 */
export async function joyKillAllSessions(machineId: string): Promise<{ ok: boolean; killed?: number }> {
    const ctx = sync.machineOnlyCtx(machineId);
    if (!ctx) throw noCtx('kill all sessions');
    const { data } = await daemonJson<{ ok: boolean; killed?: number }>(ctx, 'DELETE', '/v2/sessions');
    return data ?? { ok: false };
}

/**
 * Restart the daemon on a machine. Running sessions live in tmux and survive
 * the restart (the daemon re-adopts them).
 */
export async function joyRestartDaemon(machineId: string): Promise<{ ok: boolean }> {
    const ctx = sync.machineOnlyCtx(machineId);
    if (!ctx) throw noCtx('restart daemon');
    const { data } = await daemonJson<{ ok: boolean }>(ctx, 'POST', '/v2/daemon/restart');
    return data ?? { ok: false };
}

// A Claude transcript file on disk for a project directory (one per conversation).
export interface JoyLogEntry {
    sessionId: string;   // the .jsonl basename = Claude session UUID
    sizeBytes: number;
    mtimeMs: number;
}

// A single back-and-forth message previewed from a transcript.
export interface JoyLogMessage {
    role: 'user' | 'assistant';
    text: string;
    ts: number | null;
}

/**
 * List the Claude session logs (transcript JSONLs) for a project directory on
 * a machine, newest first.
 */
export async function machineListLogs(machineId: string, directory: string): Promise<JoyLogEntry[]> {
    const ctx = sync.machineOnlyCtx(machineId);
    if (!ctx) throw noCtx('list logs');
    const result = ((await machineHistory(ctx, directory)).data ?? { ok: false, error: 'no response' }) as { ok: boolean; logs?: JoyLogEntry[]; error?: string };
    if (!result.ok) throw new Error(result.error || 'Failed to list logs');
    return result.logs ?? [];
}

/**
 * Read the last `limit` back-and-forth messages from one transcript log.
 */
export async function machineReadLog(
    machineId: string,
    directory: string,
    sessionId: string,
    limit = 10
): Promise<JoyLogMessage[]> {
    const ctx = sync.machineOnlyCtx(machineId);
    if (!ctx) throw noCtx('read log');
    const result = ((await machineHistoryMessages(ctx, directory, sessionId, limit)).data ?? { ok: false, error: 'no response' }) as { ok: boolean; messages?: JoyLogMessage[]; error?: string };
    if (!result.ok) throw new Error(result.error || 'Failed to read log');
    return result.messages ?? [];
}

/**
 * Update machine metadata (sealed) with optimistic concurrency control and
 * automatic retry — the relay's PATCH /machines/:id CAS on metadataVersion.
 */
export async function machineUpdateMetadata(
    machineId: string,
    metadata: MachineMetadata,
    expectedVersion: number,
    maxRetries: number = 3
): Promise<{ version: number; metadata: string }> {
    let currentVersion = expectedVersion;
    let currentMetadata = { ...metadata };
    let retryCount = 0;

    const machineEncryption = sync.encryption.getMachineEncryption(machineId);
    if (!machineEncryption) {
        throw new Error(`Machine encryption not found for ${machineId}`);
    }

    while (retryCount < maxRetries) {
        const encryptedMetadata = await machineEncryption.encryptMetadata(currentMetadata);

        const result = await v2.patchMachine(machineId, {
            metadata: encryptedMetadata,
            expectedMetadataVersion: currentVersion,
        });

        if (result.result === 'success') {
            return {
                version: result.metadataVersion!,
                metadata: encryptedMetadata,
            };
        } else if (result.result === 'version-mismatch') {
            // Merge our change onto the latest record: keep the displayName we
            // are setting, take everything else from the server copy.
            const latestVersion = result.metadataVersion!;
            const latestMetadata = result.metadata
                ? await machineEncryption.decryptMetadata(latestVersion, result.metadata)
                : null;
            const decision = resolveMetadataConflict({
                serverHasMetadata: !!result.metadata,
                opened: latestMetadata,
                ours: currentMetadata,
                displayName: metadata.displayName,
            });
            retryCount++;
            if ('retry' in decision) {
                // The current record exists but did not open: do NOT advance
                // to its version with our stale fields — that CAS would
                // overwrite concurrent host/daemon updates (#382). Keep the
                // old expected version: the next PATCH is a guaranteed
                // mismatch that hands us the current record again (a re-read).
                if (retryCount >= maxRetries) {
                    throw new Error(`Failed to update: the current machine metadata could not be opened after ${maxRetries} attempts — not overwriting it`);
                }
                continue;
            }
            currentVersion = latestVersion;
            currentMetadata = decision.write;
            if (retryCount >= maxRetries) {
                throw new Error(`Failed to update after ${maxRetries} retries due to version conflicts`);
            }
        } else {
            throw new Error(result.error || 'Failed to update machine metadata');
        }
    }

    throw new Error('Unexpected error in machineUpdateMetadata');
}

/**
 * Abort the current turn. Cancels through the relay's control lane so the
 * durable turn terminalizes as CANCELLED (a raw daemon abort would read
 * completed). No active turn → nothing to cancel.
 */
export async function sessionAbort(sessionId: string): Promise<void> {
    const v2link = storage.getState().sessions[sessionId]?.metadata?.v2;
    if (!v2link?.sessionId) throw new Error('session has no relay link yet'); // nothing could be stopped — say so (#8)
    const turnId = await v2ActiveTurn(v2link.relay, v2link.sessionId);
    if (turnId) {
        await v2CancelTurn(v2link.relay, v2link.sessionId, turnId);
        return;
    }
    // No relay turn: the agent was started from the terminal, a peer message
    // or a daemon-dispatched item. Interrupt it on the machine (#8).
    const ctx = sync.machineCtx(sessionId);
    if (!ctx) throw noCtx('abort');
    const { status, data } = await machineAbort(ctx);
    if (status !== 200 || !data || data.ok !== true) throw new Error(data?.error || `abort failed (${status})`); // only an explicit ok is success (#8)
}

type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';

/**
 * Answer a tool approval held by the daemon (codex holds tool calls for a
 * human decision; claude runs without permission prompts). The extra fields
 * ride along for harnesses that understand them.
 */
async function answerApproval(sessionId: string, body: Record<string, unknown>): Promise<void> {
    const ctx = sync.machineCtx(sessionId);
    if (!ctx) throw noCtx('answer approval');
    const { status, data } = await daemonJson<{ ok?: boolean; error?: string }>(ctx, 'POST', `/v2/sessions/${ctx.localSessionId}/approvals`, body);
    // Only an explicit 2xx `{ ok: true }` is a decision the daemon applied. A
    // 500 with an empty body (status:500, data:null) or an `ok:false` used to
    // resolve here as success, so the app dismissed an approval the machine
    // was still holding (#381). Throwing keeps it pending so the user retries.
    const failure = approvalResponseError(status, data);
    if (failure) throw new Error(failure);
}

/**
 * Allow a permission request
 */
export async function sessionAllow(sessionId: string, id: string, mode?: PermissionMode, allowedTools?: string[], decision?: 'approved' | 'approved_for_session', updatedInput?: Record<string, unknown>): Promise<void> {
    await answerApproval(sessionId, { requestId: id, decision: 'allow', approved: true, mode, allowTools: allowedTools, scope: decision, updatedInput });
}

/**
 * Deny a permission request
 */
export async function sessionDeny(sessionId: string, id: string, mode?: PermissionMode, allowedTools?: string[], decision?: 'denied' | 'abort'): Promise<void> {
    await answerApproval(sessionId, { requestId: id, decision: 'deny', approved: false, mode, allowTools: allowedTools, scope: decision });
}

/**
 * Execute a bash command in the session cwd (daemon, over the tunnel).
 */
/** Patch for one path (or the whole tree) through the daemon's git route —
 *  the old bash path never reached the daemon and shell-quoted the path (#5, #92). */
export async function sessionGitDiff(sessionId: string, opts: { path?: string; head?: boolean; staged?: boolean } = {}): Promise<{ success: boolean; diff: string; error?: string; failure?: OpsFailure }> {
    try {
        const ctx = sync.machineCtx(sessionId);
        if (!ctx) throw noCtx('git diff');
        const { data } = await machineGitDiff(ctx, opts);
        if (!data?.ok) return { success: false, diff: '', error: data?.error || 'no response', failure: 'daemon' };
        return { success: true, diff: data.diff ?? '' };
    } catch (error) {
        return { success: false, diff: '', error: errorMessage(error), failure: failureOf(error) };
    }
}

function requireCtx(sessionId: string, what: string): MachineCtx {
    const ctx = sync.machineCtx(sessionId);
    if (!ctx) throw noCtx(what);
    return ctx;
}

/**
 * Read a file from the session's machine
 */
export async function sessionReadFile(sessionId: string, path: string): Promise<SessionReadFileResponse> {
    try {
        const { data } = await machineReadFile(requireCtx(sessionId, 'read file'), path);
        const res = (data ?? { success: false, error: 'no response' }) as SessionReadFileResponse;
        return res.success ? res : { ...res, failure: 'daemon' };
    } catch (error) {
        return { success: false, error: errorMessage(error), failure: failureOf(error) };
    }
}

/**
 * Write a file to the session's machine
 */
export async function sessionWriteFile(
    sessionId: string,
    path: string,
    content: string,
    expectedHash?: string | null,
    encoding: 'utf8' | 'base64' = 'utf8',
): Promise<SessionWriteFileResponse> {
    try {
        const { data } = await machineWriteFile(requireCtx(sessionId, 'write file'), path, content, expectedHash ?? undefined, encoding);
        return (data ?? { success: false, error: 'no response' }) as SessionWriteFileResponse;
    } catch (error) {
        return { success: false, error: errorMessage(error) };
    }
}

/**
 * Delete a file in the session cwd. Destructive and irreversible — the daemon
 * unlinks it (no trash), so callers must confirm first. Daemon-side guards:
 * jailed to the session cwd and files only (never directories).
 */
export async function sessionDeleteFile(sessionId: string, path: string): Promise<SessionDeleteFileResponse> {
    try {
        const { data } = await machineDeleteFile(requireCtx(sessionId, 'delete file'), path);
        return (data ?? { success: false, error: 'no response' }) as SessionDeleteFileResponse;
    } catch (error) {
        return { success: false, error: errorMessage(error) };
    }
}

/**
 * Run ripgrep in the session cwd. Takes rg-style args for caller convenience;
 * the daemon takes typed params, so the query/glob/case flags are recovered
 * from the argv.
 */
export async function sessionRipgrep(
    sessionId: string,
    args: string[],
    _cwd?: string
): Promise<SessionRipgrepResponse> {
    try {
        const eIdx = args.lastIndexOf('-e');
        const q = eIdx >= 0 && args[eIdx + 1] ? args[eIdx + 1] : [...args].reverse().find(a => !a.startsWith('-')) ?? '';
        const glob = args.includes('-g') ? args[args.indexOf('-g') + 1] : undefined;
        const { data } = await machineGrep(requireCtx(sessionId, 'ripgrep'), q, { glob, caseSensitive: !args.includes('-i') });
        return (data ?? { success: false, error: 'no response' }) as SessionRipgrepResponse;
    } catch (error) {
        return { success: false, error: errorMessage(error) };
    }
}

/**
 * Kill the session process immediately
 */
export async function sessionKill(sessionId: string, opts?: { ifStatus?: 'ended' | 'active' | 'starting' }): Promise<SessionKillResponse> {
    try {
        const { data } = await machineKillSession(requireCtx(sessionId, 'kill session'), opts);
        const r = (data ?? {}) as { success?: boolean; ok?: boolean; message?: string; error?: string };
        const success = r.success ?? r.ok ?? false;
        return { success, message: r.message ?? r.error ?? (success ? 'killed' : 'no response') };
    } catch (error) {
        return { success: false, message: errorMessage(error) };
    }
}

export interface SessionDeleteResult {
    success: boolean;
    message?: string;
    /** `status_mismatch`: the relay refused because the record's state was
     *  not one of `ifStatus` at the delete — `status` names the state it had. */
    code?: 'status_mismatch';
    status?: string;
}

/**
 * Permanently delete a session record from the relay (messages, events and
 * state go with it). The session should be inactive before deletion; pass
 * `ifStatus` (comma-separated relay states) to have the relay enforce that
 * at the delete instead of trusting a card read earlier (#173).
 */
export async function sessionDelete(sessionId: string, opts?: { ifStatus?: string }): Promise<SessionDeleteResult> {
    try {
        const v2link = storage.getState().sessions[sessionId]?.metadata?.v2;
        if (!v2link?.sessionId) {
            return { success: false, message: 'Session has no relay link' };
        }
        await v2.deleteSession(v2link.sessionId, opts);
        return { success: true };
    } catch (error) {
        if (error instanceof V2ApiError && error.status === 409 && error.code === 'status_mismatch') {
            const status = typeof (error.body as { status?: unknown } | null)?.status === 'string'
                ? (error.body as { status: string }).status
                : undefined;
            return { success: false, code: 'status_mismatch', status, message: `status_mismatch${status ? `: ${status}` : ''}` };
        }
        return { success: false, message: errorMessage(error) };
    }
}

// Export types for external use
export type {
    SessionBashRequest,
    SessionBashResponse,
    SessionReadFileResponse,
    SessionWriteFileResponse,
    SessionRipgrepResponse,
    SessionKillResponse
};
