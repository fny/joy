/**
 * Pure planning for the Settings → Cleanup screen. The screen used to call
 * sessionDelete on every record in a folder — including sessions whose agent
 * was still running (#173) — and to kill every id from a detached list it
 * had captured before the user confirmed, even if the session had been
 * restarted meanwhile (#174). These helpers separate "what may be deleted
 * outright" from "what must be stopped first", and re-filter a confirmed
 * list against the freshest state right before acting.
 */

export type JoyLifecycle = 'running' | 'detached' | 'archived';

export interface CleanupCandidate {
    id: string;
    /** joy__state from the session card; undefined when the card has none. */
    state: JoyLifecycle | string | undefined | null;
}

export interface FolderDeletionPlan {
    /** Records whose agent is known to be gone — delete outright. */
    deleteNow: string[];
    /** Sessions that must be stopped (and confirmed stopped) before their
     *  record may go. Unknown state lands here: never delete the record of an
     *  agent that may still be working. */
    stopFirst: string[];
}

export function planFolderDeletion(candidates: CleanupCandidate[]): FolderDeletionPlan {
    const deleteNow: string[] = [];
    const stopFirst: string[] = [];
    for (const c of candidates) {
        if (c.state === 'detached' || c.state === 'archived') deleteNow.push(c.id);
        else stopFirst.push(c.id);
    }
    return { deleteNow, stopFirst };
}

export interface DetachedRecheck {
    /** Still detached per the fresh lookup — safe to close. */
    kill: string[];
    /** No longer detached (restarted, archived, or gone) — leave alone. */
    skip: string[];
}

/** Re-check a previously captured detached list against the freshest state.
 *  Only ids whose CURRENT state is still 'detached' may be killed. */
export function recheckDetached(ids: string[], currentState: (id: string) => string | undefined | null): DetachedRecheck {
    const kill: string[] = [];
    const skip: string[] = [];
    for (const id of ids) {
        if (currentState(id) === 'detached') kill.push(id);
        else skip.push(id);
    }
    return { kill, skip };
}

/** Wording for the folder-deletion confirm: says up front that running
 *  sessions will be stopped, so the user approves THAT, not just a tidy-up. */
export function describeFolderDeletion(plan: FolderDeletionPlan, folderName: string): string {
    const total = plan.deleteNow.length + plan.stopFirst.length;
    const records = `${total} session record${total === 1 ? '' : 's'} for "${folderName}"`;
    if (plan.stopFirst.length === 0) return `Permanently deletes ${records}. Cannot be undone.`;
    const n = plan.stopFirst.length;
    return `Stops ${n} running session${n === 1 ? '' : 's'} first, then permanently deletes ${records}. Sessions that cannot be stopped keep their records. Cannot be undone.`;
}
