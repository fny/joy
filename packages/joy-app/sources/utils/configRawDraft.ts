/**
 * Raw-editor draft bookkeeping for the agent-config screen (#169).
 *
 * The editor holds three strings: `disk` (the file as last read), `draft`
 * (what the editor shows) and, implicitly, whether they differ. Every reload
 * used to overwrite the draft with the file — after a JSON-path assignment, or
 * when a Save completed while the user kept typing — so unsaved edits vanished
 * with no warning. `applyReload` decides what a fresh read may do to the draft.
 */
export interface RawDraftState {
    /** File contents at the last successful read (null before the first). */
    disk: string | null;
    /** Editor contents. */
    draft: string;
}

export function isDirty(state: RawDraftState): boolean {
    return state.disk !== null && state.draft !== state.disk;
}

export interface ReloadOutcome {
    state: RawDraftState;
    /** The file changed on disk but the editor kept unsaved edits. */
    keptEdits: boolean;
}

/**
 * A fresh read landed. A clean editor follows the file; a dirty editor keeps
 * its edits and only learns the new on-disk text (so a later Save still
 * writes what the user sees, and the screen can offer "reload and discard").
 */
export function applyReload(state: RawDraftState, disk: string): ReloadOutcome {
    if (!isDirty(state)) {
        return { state: { disk, draft: disk }, keptEdits: false };
    }
    return { state: { disk, draft: state.draft }, keptEdits: disk !== state.draft };
}

/**
 * A Save finished and the file now reads `disk` (what was pressed on). Text
 * typed since the press is the newer truth: keep it; the editor is dirty
 * only if it still differs from the file.
 */
export function applySaved(state: RawDraftState, disk: string): RawDraftState {
    return { disk, draft: state.draft };
}

/** Discard edits: the editor follows the file again. */
export function discardEdits(state: RawDraftState): RawDraftState {
    return { disk: state.disk, draft: state.disk ?? '' };
}
