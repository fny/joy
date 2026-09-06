import { describe, expect, it } from 'vitest';
import { applyReload, applySaved, discardEdits, isDirty } from './configRawDraft';

describe('raw config draft (#169)', () => {
    it('a clean editor follows the file on reload', () => {
        const out = applyReload({ disk: '{"a":1}', draft: '{"a":1}' }, '{"a":2}');
        expect(out.keptEdits).toBe(false);
        expect(out.state).toEqual({ disk: '{"a":2}', draft: '{"a":2}' });
    });

    it('the first read fills an empty editor', () => {
        const out = applyReload({ disk: null, draft: '' }, '{"a":1}');
        expect(out.state.draft).toBe('{"a":1}');
        expect(isDirty(out.state)).toBe(false);
    });

    it('a dirty editor keeps its edits when a path assignment reloads the file', () => {
        const typed = '{"a":1,"b":"typed"}';
        const out = applyReload({ disk: '{"a":1}', draft: typed }, '{"a":1,"x":true}');
        expect(out.keptEdits).toBe(true);
        expect(out.state.draft).toBe(typed);
        expect(out.state.disk).toBe('{"a":1,"x":true}');
        expect(isDirty(out.state)).toBe(true);
    });

    it('text typed while a Save was pending survives the post-save reload', () => {
        // Save pressed with 'v1'; user types on to 'v2' before the daemon answers.
        const afterSave = applySaved({ disk: 'v0', draft: 'v2' }, 'v1');
        expect(afterSave.draft).toBe('v2');
        expect(isDirty(afterSave)).toBe(true);
        // ...and a save whose draft did not move ends clean.
        expect(isDirty(applySaved({ disk: 'v0', draft: 'v1' }, 'v1'))).toBe(false);
    });

    it('discarding edits restores the file text', () => {
        expect(discardEdits({ disk: 'file', draft: 'edited' })).toEqual({ disk: 'file', draft: 'file' });
    });
});
