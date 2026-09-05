/**
 * Git status synchronization module
 * Provides real-time git repository status tracking using remote bash commands
 */

import { InvalidateSync } from '@/utils/sync';
import { GitStatus } from './storageTypes';
import { storage } from './storage';
import { parseStatusSummary, getStatusCounts, isDirty } from './git-parsers/parseStatus';
import { parseStatusSummaryV2, getStatusCountsV2, isDirtyV2, getCurrentBranchV2, getTrackingInfoV2 } from './git-parsers/parseStatusV2';
import { parseCurrentBranch } from './git-parsers/parseBranch';
import { parseNumStat, mergeDiffSummaries } from './git-parsers/parseDiff';
import { sync } from './sync';
import { machineGitStatus, machineGitDiff } from './v2/machine';


export class GitStatusSync {
    // Map project keys to sync instances
    private projectSyncMap = new Map<string, InvalidateSync>();
    // Map session IDs to project keys for cleanup
    private sessionToProjectKey = new Map<string, string>();
    // Debounce timers to coalesce rapid invalidations (e.g. new-message + update-session arriving together)
    private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

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
            // Bind the PROJECT, not the first session: the bash route is resolved to
            // a currently-online session at fetch time. Baking in `sessionId` froze
            // git status forever once that session detached, even with another live
            // session in the same repo (BUG-14).
            sync = new InvalidateSync(() => this.fetchGitStatusForProject(projectKey));
            this.projectSyncMap.set(projectKey, sync);
        }
        return sync;
    }

    /**
     * Invalidate git status for a session (triggers refresh for the entire project).
     * Debounces rapid calls (e.g. new-message + update-session arriving together)
     * to avoid duplicate RPC round-trips.
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
                storage.getState().applyGitStatus(projectKey, null);
            }
        }
    }

    /**
     * Pick a currently-online session for a project (machineId:path) to route bash
     * through, so a detached session can't freeze the repo's git status. Prefers an
     * online session; returns null if none is live (we then keep the last good
     * status rather than clearing or failing).
     */
    /** Daemon-parsed porcelain (v2) → the app's GitStatus shape. */
    private fromV2GitStatus(d: import('./v2/machine').V2GitStatus, unstagedNumstat = '', stagedNumstat = ''): GitStatus {
        const sum = (raw: string) => {
            const d = parseNumStat(raw.trim());
            return { added: d.insertions, removed: d.deletions };
        };
        const u = sum(unstagedNumstat), sg = sum(stagedNumstat);
        const modified: string[] = [];
        const staged: string[] = [];
        const untracked: string[] = [];
        for (const e of d.entries ?? []) {
            if (e.untracked) { untracked.push(e.path); continue; }
            if (e.staged) staged.push(e.path);
            if (e.unstaged) modified.push(e.path);
        }
        return {
            branch: d.branch ?? null,
            ahead: d.ahead ?? 0,
            behind: d.behind ?? 0,
            modifiedCount: modified.length,
            stagedCount: staged.length,
            untrackedCount: untracked.length,
            modifiedFiles: modified,
            stagedFiles: staged,
            untrackedFiles: untracked,
            isDirty: (d.entries ?? []).length > 0,
            stagedLinesAdded: sg.added,
            stagedLinesRemoved: sg.removed,
            unstagedLinesAdded: u.added,
            unstagedLinesRemoved: u.removed,
            linesAdded: u.added + sg.added,
            linesRemoved: u.removed + sg.removed,
            linesChanged: u.added + sg.added + u.removed + sg.removed,
            stashCount: 0,
            lastUpdatedAt: Date.now(),
        } as unknown as GitStatus;
    }

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
     * Fetch git status for a project using a currently-online session in that project
     */
    private async fetchGitStatusForProject(projectKey: string): Promise<void> {
        try {
            // Route through a live session resolved NOW (not a frozen first session).
            const sessionId = this.resolveLiveSessionForProject(projectKey);
            if (!sessionId) return; // no online session → keep last good status
            const session = storage.getState().sessions[sessionId];
            if (!session?.metadata?.path) {
                return;
            }

            // v2 sessions read git state from the DAEMON's machine plane over
            // the sealed tunnel — one parsed call instead of four shell
            // round-trips, and no realtime socket involved.
            const mctx = await sync.awaitMachineCtx(sessionId);
            if (mctx) {
                const { status, data } = await machineGitStatus(mctx);
                if (status === 200 && data?.ok) {
                    // Line counts come from two numstat calls; without them every
                    // +N/−N badge was blank (#103).
                    const [unstaged, staged] = await Promise.all([
                        machineGitDiff(mctx, { numstat: true }),
                        machineGitDiff(mctx, { numstat: true, staged: true }),
                    ]);
                    storage.getState().applyGitStatus(projectKey, this.fromV2GitStatus(data, unstaged.data?.diff ?? '', staged.data?.diff ?? ''));
                } else if (status === 200 && data && !data.ok) {
                    storage.getState().applyGitStatus(projectKey, null); // not a repo
                }
                return;
            }

            // No machine context yet (the session is still binding): keep the
            // last good status. The shell fallback that lived here never
            // reached the daemon (#5).
            return;

        } catch (error) {
            console.error('Error fetching git status for project', projectKey, ':', error);
            // Don't apply error state, just skip this update
        }
    }

    /**
     * Parse git status porcelain v2 output into structured data
     */
    private parseGitStatusV2(
        porcelainV2Output: string,
        diffStatOutput: string = '',
        stagedDiffStatOutput: string = ''
    ): GitStatus {
        // Parse status using v2 parser
        const statusSummary = parseStatusSummaryV2(porcelainV2Output);
        const counts = getStatusCountsV2(statusSummary);
        const repoIsDirty = isDirtyV2(statusSummary);
        const branchName = getCurrentBranchV2(statusSummary);
        const trackingInfo = getTrackingInfoV2(statusSummary);

        // Parse diff statistics
        const unstagedDiff = parseNumStat(diffStatOutput);
        const stagedDiff = parseNumStat(stagedDiffStatOutput);
        const { stagedAdded, stagedRemoved, unstagedAdded, unstagedRemoved } = mergeDiffSummaries(stagedDiff, unstagedDiff);
        
        // Calculate totals
        const linesAdded = stagedAdded + unstagedAdded;
        const linesRemoved = stagedRemoved + unstagedRemoved;
        const linesChanged = linesAdded + linesRemoved;

        return {
            branch: branchName,
            isDirty: repoIsDirty,
            modifiedCount: counts.modified,
            untrackedCount: counts.untracked,
            stagedCount: counts.staged,
            stagedLinesAdded: stagedAdded,
            stagedLinesRemoved: stagedRemoved,
            unstagedLinesAdded: unstagedAdded,
            unstagedLinesRemoved: unstagedRemoved,
            linesAdded,
            linesRemoved,
            linesChanged,
            lastUpdatedAt: Date.now(),
            // V2-specific fields
            upstreamBranch: statusSummary.branch.upstream || null,
            aheadCount: trackingInfo?.ahead,
            behindCount: trackingInfo?.behind,
            stashCount: statusSummary.stashCount
        };
    }

    /**
     * Parse git status porcelain output into structured data using simple-git parsers
     * (Legacy v1 fallback method - kept for compatibility)
     */
    private parseGitStatus(
        branchName: string | null, 
        porcelainOutput: string,
        diffStatOutput: string = '',
        stagedDiffStatOutput: string = ''
    ): GitStatus {
        // Parse status using simple-git parser
        const statusSummary = parseStatusSummary(porcelainOutput);
        const counts = getStatusCounts(statusSummary);
        const repoIsDirty = isDirty(statusSummary);

        // Parse diff statistics
        const unstagedDiff = parseNumStat(diffStatOutput);
        const stagedDiff = parseNumStat(stagedDiffStatOutput);
        const { stagedAdded, stagedRemoved, unstagedAdded, unstagedRemoved } = mergeDiffSummaries(stagedDiff, unstagedDiff);
        
        // Calculate totals
        const linesAdded = stagedAdded + unstagedAdded;
        const linesRemoved = stagedRemoved + unstagedRemoved;
        const linesChanged = linesAdded + linesRemoved;

        return {
            branch: branchName || null,
            isDirty: repoIsDirty,
            modifiedCount: counts.modified,
            untrackedCount: counts.untracked,
            stagedCount: counts.staged,
            stagedLinesAdded: stagedAdded,
            stagedLinesRemoved: stagedRemoved,
            unstagedLinesAdded: unstagedAdded,
            unstagedLinesRemoved: unstagedRemoved,
            linesAdded,
            linesRemoved,
            linesChanged,
            lastUpdatedAt: Date.now()
        };
    }

}

// Global singleton instance
export const gitStatusSync = new GitStatusSync();
