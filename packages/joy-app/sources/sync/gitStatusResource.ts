/**
 * Git status as ONE resource per project (sync/resource), keyed by
 * `machineId:path`. The daemon's STRUCTURED status (schema v2, parsed once on
 * the machine — docs/API.md "Structured git status") is the cached value;
 * the summary (badge, sidebar header) and the file list (Changes screen,
 * sidebar tree, all-files diff, prefetch) are projections of it from
 * gitStatusModel, memoized per value so consumers keyed on identity only
 * re-run on a real change.
 *
 * This replaces two fetch paths that read the same endpoint into two store
 * slots with their own latest-wins bookkeeping (gitStatusSync's per-project
 * InvalidateSync + generation, gitStatusFiles' refresh scope):
 *  - latest wins per project, whoever asked (#316, #378);
 *  - an explicit `relation: 'none'` is the authoritative "not a repository"
 *    (data null); a failed git command is an error and a missing machine
 *    context is unavailable — both keep the last good status (#379);
 *  - app focus and relay reconnect revalidate observed projects; a session
 *    becoming visible invalidates (debounced) its project.
 */
import { storage } from './storage';
import { sync } from './sync';
import { machineGitStatus, type GitStatusRepoV2 } from './v2/machine';
import { resources, type ResourceSpec } from './resource';
import { filesFromStructured, gitStatusFromStructured, type GitStatusFiles, type GitStatusFilesResult } from './gitStatusModel';
import type { GitStatus } from './storageTypes';
import { useResource, useResourceEntry, type UseResourceOptions } from '@/hooks/useResource';
import { useSession } from './storage';

/** The cached value: the structured status, or null = not a repository. */
export type GitStatusData = GitStatusRepoV2 | null;

export function gitStatusKey(pathKey: string): string {
    return `git-status:${pathKey}`;
}

export function projectKeyOf(session: { metadata?: { machineId?: string | null; path?: string | null } | null } | null | undefined): string | null {
    const machineId = session?.metadata?.machineId;
    const path = session?.metadata?.path;
    return machineId && path ? `${machineId}:${path}` : null;
}

/**
 * Route through a live session of the project resolved NOW, not a frozen
 * first session (BUG-14): an online one when there is one, else any session
 * of the project (its machine context is awaited while it binds).
 */
function sessionForProject(pathKey: string): string | null {
    let fallback: string | null = null;
    for (const s of Object.values(storage.getState().sessions)) {
        if (projectKeyOf(s) !== pathKey) continue;
        if (s.presence === 'online') return s.id;
        fallback ??= s.id;
    }
    return fallback;
}

export function gitStatusSpec(pathKey: string): ResourceSpec<GitStatusData> {
    return {
        key: gitStatusKey(pathKey),
        // Two screens mounting together (sidebar + Changes) share one read.
        staleTime: 2000,
        refetchOnFocus: true,
        refetchOnReconnect: true,
        retry: { attempts: 2, delayMs: 1000 },
        fetch: async () => {
            const sessionId = sessionForProject(pathKey);
            if (!sessionId) return { kind: 'unavailable', reason: 'no session for this project' };
            const mctx = await sync.awaitMachineCtx(sessionId);
            if (!mctx) return { kind: 'unavailable', reason: 'no machine context yet' };
            const { status, data } = await machineGitStatus(mctx); // a tunnel failure throws → bounded retry
            if (status !== 200 || !data) throw new Error(`git status HTTP ${status}`);
            // git itself failed on the machine (bad ownership, timeout): not a
            // tunnel problem, so no retry — the last good status stands.
            if (!data.ok) return { kind: 'error', reason: `${data.code}: ${data.error}` };
            if (data.relation === 'none') return { kind: 'ok', data: null }; // authoritative: not a repository
            return { kind: 'ok', data };
        },
    };
}

// ── projections, memoized per structured value ──────────────────────────────

const filesCache = new WeakMap<GitStatusRepoV2, GitStatusFiles>();
export function filesOf(data: GitStatusData | undefined): GitStatusFiles | null {
    if (!data) return null;
    let f = filesCache.get(data);
    if (!f) { f = filesFromStructured(data); filesCache.set(data, f); }
    return f;
}

const summaryCache = new WeakMap<GitStatusRepoV2, GitStatus>();
export function summaryOf(data: GitStatusData | undefined, dataUpdatedAt: number): GitStatus | null {
    if (!data) return null;
    let s = summaryCache.get(data);
    if (!s || s.lastUpdatedAt !== dataUpdatedAt) { s = gitStatusFromStructured(data, dataUpdatedAt); summaryCache.set(data, s); }
    return s;
}

// ── hooks ───────────────────────────────────────────────────────────────────

function useProjectKey(sessionId: string): string | null {
    // Reactive: on a cold load the screen mounts BEFORE sessions hydrate, so
    // the key appears later and the read must start then (#316 follow-up).
    return projectKeyOf(useSession(sessionId));
}

/** Subscribe to AND keep fresh the project's status (screens that show it). */
export function useGitStatusResource(sessionId: string, opts: UseResourceOptions = {}) {
    const pathKey = useProjectKey(sessionId);
    const spec = pathKey ? gitStatusSpec(pathKey) : null;
    const view = useResource<GitStatusData>(spec, opts);
    return {
        pathKey,
        entry: view,
        files: filesOf(view.data),
        summary: summaryOf(view.data, view.dataUpdatedAt),
        /** Time of the last daemon answer — the repository revision for diffs. */
        checkedAt: view.checkedAt,
        isLoading: view.isLoading,
        error: view.error,
        unavailable: view.unavailable,
        refresh: view.refresh,
    };
}

/** Passive: the project's summary as cached (badges, list rows). Never fetches. */
export function useSessionGitStatus(sessionId: string): GitStatus | null {
    const pathKey = useProjectKey(sessionId);
    const entry = useResourceEntry<GitStatusData>(pathKey ? gitStatusKey(pathKey) : null);
    return summaryOf(entry.data, entry.dataUpdatedAt);
}

/** Passive: the project's file list as cached. Never fetches. */
export function useSessionGitStatusFiles(sessionId: string): GitStatusFiles | null {
    const pathKey = useProjectKey(sessionId);
    const entry = useResourceEntry<GitStatusData>(pathKey ? gitStatusKey(pathKey) : null);
    return filesOf(entry.data);
}

// ── policies driven from sync ───────────────────────────────────────────────

const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * The session became visible (or its repository may have changed): refetch
 * its project's status. Debounced per project so a burst of triggers is one
 * round-trip; the read runs whether or not anyone observes the key, so the
 * badge of a session that was opened is populated.
 */
export function invalidateGitStatus(sessionId: string): void {
    const pathKey = projectKeyOf(storage.getState().sessions[sessionId]);
    if (!pathKey) return;
    const existing = debounceTimers.get(pathKey);
    if (existing) clearTimeout(existing);
    debounceTimers.set(pathKey, setTimeout(() => {
        debounceTimers.delete(pathKey);
        resources.invalidate(gitStatusKey(pathKey), { refetch: true });
        // An unobserved key with no spec yet (never ensured) needs one to run.
        if (!resources.peek(gitStatusKey(pathKey)).fetching) void resources.refresh(gitStatusSpec(pathKey));
    }, 300));
}

/** The session is being deleted: drop the project's status unless another session still shares it. */
export function clearGitStatusForSession(sessionId: string): void {
    const sessions = storage.getState().sessions;
    const pathKey = projectKeyOf(sessions[sessionId]);
    if (!pathKey) return;
    const shared = Object.values(sessions).some((s) => s.id !== sessionId && projectKeyOf(s) === pathKey);
    if (shared) return;
    const timer = debounceTimers.get(pathKey);
    if (timer) { clearTimeout(timer); debounceTimers.delete(pathKey); }
    resources.remove(gitStatusKey(pathKey));
}

/** One fresh read, three-state (diagnostics: `joy.gitFiles`). */
export async function fetchGitStatusFiles(sessionId: string): Promise<GitStatusFilesResult> {
    const pathKey = projectKeyOf(storage.getState().sessions[sessionId]);
    if (!pathKey) return { kind: 'unavailable', error: 'session has no path yet' };
    const entry = await resources.refresh(gitStatusSpec(pathKey));
    if (entry.unavailable) return { kind: 'unavailable', error: entry.unavailable };
    if (entry.error) return { kind: 'unavailable', error: entry.error };
    if (!entry.hasData) return { kind: 'unavailable', error: 'no answer' };
    const files = filesOf(entry.data);
    return files ? { kind: 'ok', files } : { kind: 'not-repo' };
}
