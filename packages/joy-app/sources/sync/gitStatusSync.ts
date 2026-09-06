/**
 * Git status synchronization module
 * Keeps the per-project GitStatus summary (branch, counts, line totals) fresh
 * from the daemon's STRUCTURED status over the sealed tunnel. No git text is
 * parsed here: the daemon returns typed facts (docs/API.md, "Structured git
 * status") and this module only projects them onto the store's shape.
 */

import { InvalidateSync } from '@/utils/sync';
import { storage } from './storage';
import { sync } from './sync';
import { machineGitStatus } from './v2/machine';
import { gitStatusFromStructured } from './gitStatusModel';

/** Retryable read failure: rethrown so InvalidateSync's backoff loop retries
 *  instead of treating one failed refresh as a completed one (#379). */
class GitStatusUnavailable extends Error {
    constructor(message: string) { super(message); this.name = 'GitStatusUnavailable'; }
}

export class GitStatusSync {
    // Map project keys to sync instances
    private projectSyncMap = new Map<string, InvalidateSync>();
    // Map session IDs to project keys for cleanup
    private sessionToProjectKey = new Map<string, string>();
    // Debounce timers to coalesce rapid invalidations (e.g. new-message + update-session arriving together)
    private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
    // Generation per project: bumped whenever the project's sync is stopped or
    // its status cleared. A request that started under an older generation may
    // not publish — a stopped synchronizer's late answer used to overwrite its
    // replacement's fresher status, or repopulate a cleared one (#378).
    private generation = new Map<string, number>();

    /**
     * Get project key string for a session
     */
    private getProjectKeyForSession(sessionId: string): string | null {
        const session = storage.getState().sessions[sessionId];
        if (!session?.metadata?.machineId || !session?.metadata?.path) {
            return null;
        }
        return `${session.metadata.machineId}:${session.metadata.path}`;
    }

    /**
     * Get or create git status sync for a session (creates project-based sync)
     */
    getSync(sessionId: string): InvalidateSync {
        const projectKey = this.getProjectKeyForSession(sessionId);
        if (!projectKey) {
            // Return a no-op sync if no valid project
            return new InvalidateSync(async () => {});
        }

        // Map session to project key
        this.sessionToProjectKey.set(sessionId, projectKey);

        let sync = this.projectSyncMap.get(projectKey);
        if (!sync) {
            // Bind the PROJECT, not the first session: the route is resolved to a
            // currently-online session at fetch time. Baking in `sessionId` froze
            // git status forever once that session detached, even with another
            // live session in the same repo (BUG-14).
            sync = new InvalidateSync(() => this.fetchGitStatusForProject(projectKey));
            this.projectSyncMap.set(projectKey, sync);
        }
        return sync;
    }

    /**
     * Invalidate git status for a session (triggers refresh for the entire project).
     * Debounces rapid calls (e.g. new-message + update-session arriving together)
     * to avoid duplicate round-trips.
     */
    invalidate(sessionId: string): void {
        const projectKey = this.sessionToProjectKey.get(sessionId);
        if (projectKey) {
            const existing = this.debounceTimers.get(projectKey);
            if (existing) clearTimeout(existing);

            this.debounceTimers.set(projectKey, setTimeout(() => {
                this.debounceTimers.delete(projectKey);
                const sync = this.projectSyncMap.get(projectKey);
                if (sync) {
                    sync.invalidate();
                }
            }, 300));
        }
    }

    /**
     * Stop git status sync for a session
     */
    stop(sessionId: string): void {
        const projectKey = this.sessionToProjectKey.get(sessionId);
        if (projectKey) {
            this.sessionToProjectKey.delete(sessionId);

            // Check if any other sessions are using this project
            const hasOtherSessions = Array.from(this.sessionToProjectKey.values()).includes(projectKey);

            // Only stop the project sync if no other sessions are using it
            if (!hasOtherSessions) {
                const timer = this.debounceTimers.get(projectKey);
                if (timer) {
                    clearTimeout(timer);
                    this.debounceTimers.delete(projectKey);
                }
                const sync = this.projectSyncMap.get(projectKey);
                if (sync) {
                    sync.stop();
                    this.projectSyncMap.delete(projectKey);
                }
                this.bumpGeneration(projectKey); // in-flight requests of this sync may not publish (#378)
            }
        }
    }

    /**
     * Clear git status for a session when it's deleted
     * Similar to stop() but also clears any stored git status
     */
    clearForSession(sessionId: string): void {
        const projectKey = this.sessionToProjectKey.get(sessionId);

        // First stop any active syncs
        this.stop(sessionId);

        // Only clear git status if no other sessions share this path
        if (projectKey) {
            const hasOtherSessions = Array.from(this.sessionToProjectKey.values()).includes(projectKey);
            if (!hasOtherSessions) {
                this.bumpGeneration(projectKey);
                storage.getState().applyGitStatus(projectKey, null);
            }
        }
    }

    private bumpGeneration(projectKey: string): void {
        this.generation.set(projectKey, (this.generation.get(projectKey) ?? 0) + 1);
    }

    /**
     * Pick a currently-online session for a project (machineId:path) to route
     * through, so a detached session can't freeze the repo's git status.
     * Returns null if none is live (we then keep the last good status rather
     * than clearing or failing).
     */
    private resolveLiveSessionForProject(projectKey: string): string | null {
        const sessions = storage.getState().sessions;
        for (const s of Object.values(sessions)) {
            if (!s.metadata?.machineId || !s.metadata?.path) continue;
            if (`${s.metadata.machineId}:${s.metadata.path}` !== projectKey) continue;
            if (s.presence === 'online') return s.id;
        }
        return null;
    }

    /**
     * Fetch git status for a project using a currently-online session in that project.
     * Throws GitStatusUnavailable on a retryable failure (InvalidateSync backs off
     * and retries); a confirmed non-repository result and a git-side failure are
     * terminal for this refresh.
     */
    private async fetchGitStatusForProject(projectKey: string): Promise<void> {
        // Route through a live session resolved NOW (not a frozen first session).
        const sessionId = this.resolveLiveSessionForProject(projectKey);
        if (!sessionId) return; // no online session → keep last good status
        const session = storage.getState().sessions[sessionId];
        if (!session?.metadata?.path) {
            return;
        }
        const gen = this.generation.get(projectKey) ?? 0;
        const stillCurrent = () => (this.generation.get(projectKey) ?? 0) === gen && this.projectSyncMap.has(projectKey);

        // No machine context yet (the session is still binding): keep the last
        // good status and let the next invalidation try again.
        const mctx = await sync.awaitMachineCtx(sessionId);
        if (!mctx) return;

        let res: Awaited<ReturnType<typeof machineGitStatus>>;
        try {
            res = await machineGitStatus(mctx);
        } catch (error) {
            throw new GitStatusUnavailable(`git status for ${projectKey}: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (!stillCurrent()) return; // stopped or cleared while the request was in flight (#378)
        const { status, data } = res;
        if (status !== 200 || !data) {
            throw new GitStatusUnavailable(`git status for ${projectKey}: HTTP ${status}`);
        }
        if (!data.ok) {
            // git itself failed on the machine (bad ownership, timeout): not a
            // tunnel problem, so no retry storm — keep the last good status.
            console.warn(`[git] status unavailable for ${projectKey}, keeping last result: ${data.code} ${data.error}`);
            return;
        }
        if (data.relation === 'none') {
            storage.getState().applyGitStatus(projectKey, null); // authoritative: not a repository
            return;
        }
        storage.getState().applyGitStatus(projectKey, gitStatusFromStructured(data));
    }
}

// Global singleton instance
export const gitStatusSync = new GitStatusSync();
