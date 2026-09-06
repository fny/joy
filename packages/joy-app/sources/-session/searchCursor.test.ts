import { describe, it, expect } from 'vitest';
import { nextSearchCursor, reconcileSearchCursor } from './searchCursor';

const m = (...ids: string[]) => ids.map((messageId) => ({ messageId }));

describe('reconcileSearchCursor (#122)', () => {
    it('clamps the cursor when the selected match disappears (3/3 → 2/2)', () => {
        const r = reconcileSearchCursor(m('a', 'b'), 'c', 2);
        expect(r).toEqual({ index: 1, messageId: 'b', scroll: true });
    });

    it('follows the selected message when matches shift under it', () => {
        // A new matching message arrived ahead of the selection.
        const r = reconcileSearchCursor(m('new', 'a', 'b', 'c'), 'b', 1);
        expect(r).toEqual({ index: 2, messageId: 'b', scroll: false });
    });

    it('selects the first hit when nothing is selected yet', () => {
        expect(reconcileSearchCursor(m('a', 'b'), null, 0)).toEqual({ index: 0, messageId: 'a', scroll: true });
    });

    it('resets to an empty cursor when there are no matches', () => {
        expect(reconcileSearchCursor([], 'a', 5)).toEqual({ index: 0, messageId: null, scroll: false });
    });

    it('never produces an out-of-range index', () => {
        expect(reconcileSearchCursor(m('a'), 'zzz', 40).index).toBe(0);
        expect(reconcileSearchCursor(m('a', 'b', 'c'), 'zzz', -3).index).toBe(0);
    });
});

describe('nextSearchCursor (#122 regression: one decision per change)', () => {
    it('a new query starts at the first hit even when the old selection is still a match', () => {
        // B selected at index 1; the new query yields [X, A, B]. The split
        // effects left the counter at 3/3 (following B) with X on screen.
        const r = nextSearchCursor(m('X', 'A', 'B'), { queryChanged: true, selectedId: 'B', previousIndex: 1 });
        expect(r).toEqual({ index: 0, messageId: 'X', scroll: true });
        // Applying that decision then reconciling the SAME list is stable.
        expect(nextSearchCursor(m('X', 'A', 'B'), { queryChanged: false, selectedId: r.messageId, previousIndex: r.index }))
            .toEqual({ index: 0, messageId: 'X', scroll: false });
    });

    it('a new query with no hits clears the cursor', () => {
        expect(nextSearchCursor([], { queryChanged: true, selectedId: 'B', previousIndex: 1 }))
            .toEqual({ index: 0, messageId: null, scroll: false });
    });

    it('an unchanged query follows the selected message through a changed list', () => {
        expect(nextSearchCursor(m('new', 'a', 'b'), { queryChanged: false, selectedId: 'b', previousIndex: 1 }))
            .toEqual({ index: 2, messageId: 'b', scroll: false });
    });
});
