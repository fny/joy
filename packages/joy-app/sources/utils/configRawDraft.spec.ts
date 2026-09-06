import { describe, expect, it } from 'vitest';
import { applyReload, applySaved, configTarget, discardEdits, emptyDraft, isDirty, parkDraft, takeParkedDraft } from './configRawDraft';

const A = configTarget('machine-a', 'claude');
const B = configTarget('machine-b', 'claude');

describe('raw config draft (#169)', () => {
    it('a clean editor follows the file on reload', () => {
        const out = applyReload({ target: A, disk: '{"a":1}', draft: '{"a":1}' }, '{"a":2}');
        expect(out.keptEdits).toBe(false);
        expect(out.state).toEqual({ target: A, disk: '{"a":2}', draft: '{"a":2}' });
    });

    it('the first read fills an empty editor', () => {
        const out = applyReload(emptyDraft(A), '{"a":1}');
        expect(out.state.draft).toBe('{"a":1}');
        expect(isDirty(out.state)).toBe(false);
    });

    it('a dirty editor keeps its edits when a path assignment reloads the file', () => {
        const typed = '{"a":1,"b":"typed"}';
        const out = applyReload({ target: A, disk: '{"a":1}', draft: typed }, '{"a":1,"x":true}');
        expect(out.keptEdits).toBe(true);
        expect(out.state.draft).toBe(typed);
        expect(out.state.disk).toBe('{"a":1,"x":true}');
        expect(isDirty(out.state)).toBe(true);
    });

    it('text typed while a Save was pending survives the post-save reload', () => {
        // Save pressed with 'v1'; user types on to 'v2' before the daemon answers.
        const afterSave = applySaved({ target: A, disk: 'v0', draft: 'v2' }, 'v1');
        expect(afterSave.draft).toBe('v2');
        expect(isDirty(afterSave)).toBe(true);
        // ...and a save whose draft did not move ends clean.
        expect(isDirty(applySaved({ target: A, disk: 'v0', draft: 'v1' }, 'v1'))).toBe(false);
    });

    it('discarding edits restores the file text', () => {
        expect(discardEdits({ target: A, disk: 'file', draft: 'edited' })).toEqual({ target: A, disk: 'file', draft: 'file' });
    });
});

describe('drafts are keyed by machine + agent (#169 regression)', () => {
    it("a read for machine B never inherits machine A's unsaved edits", () => {
        // Reviewer: edit A, change the route to B, press Save — B's disk was
        // fed into A's dirty state and machineConfigWrite got B + UNSAVED-A.
        const dirtyA = { target: A, disk: '{"a":1}', draft: 'UNSAVED-A' };
        const out = applyReload(dirtyA, '{"b":1}', B);
        expect(out.keptEdits).toBe(false);
        expect(out.state).toEqual({ target: B, disk: '{"b":1}', draft: '{"b":1}' });
        expect(isDirty(out.state)).toBe(false);
    });

    it("a save reply for another target replaces the draft instead of merging into it", () => {
        const dirtyA = { target: A, disk: 'a0', draft: 'a-typed' };
        expect(applySaved(dirtyA, 'b1', B)).toEqual({ target: B, disk: 'b1', draft: 'b1' });
    });

    it('edits parked on leaving a file come back for that file only', () => {
        const dirtyA = { target: A, disk: '{"a":1}', draft: 'UNSAVED-A' };
        parkDraft(dirtyA);
        expect(takeParkedDraft(B)).toBeNull();
        expect(takeParkedDraft(A)).toEqual(dirtyA);
        // taken once; a clean draft is never parked
        expect(takeParkedDraft(A)).toBeNull();
        parkDraft({ target: A, disk: 'x', draft: 'x' });
        expect(takeParkedDraft(A)).toBeNull();
    });
});
