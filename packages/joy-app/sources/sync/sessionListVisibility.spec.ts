/**
 * The "orphan header" regression: a session the relay still flags active but
 * whose last activity is stale is HISTORY (grouped under a date header). If
 * the row then carried the raw relay flag, the visibility filter would drop
 * it — leaving "Yesterday" / "2 days ago" headers with nothing under them and
 * no archive toggle. Grouping and the row flag now share one predicate.
 */
import { describe, it, expect } from 'vitest';
import { isSessionInActiveGroup, SESSION_STALE_AFTER_MS } from '@/sync/sessionLiveness';
import { filterVisibleSessionListViewData } from '@/sync/sessionListVisibility';
import type { SessionListViewItem } from '@/sync/storage';

const row = (id: string, active: boolean) =>
    ({ type: 'session', session: { id, active } as any }) as SessionListViewItem;

describe('isSessionInActiveGroup', () => {
    const fresh = Date.now();
    const stale = Date.now() - SESSION_STALE_AFTER_MS - 1;

    it('relay-active + fresh → active group', () => {
        expect(isSessionInActiveGroup({ active: true, activeAt: fresh })).toBe(true);
    });
    it('relay-active but STALE → history (the zombie-row case)', () => {
        expect(isSessionInActiveGroup({ active: true, activeAt: stale })).toBe(false);
    });
    it('detached / archived cards are history even when fresh and flagged active', () => {
        expect(isSessionInActiveGroup({ active: true, activeAt: fresh, metadata: { joy__state: 'detached' } })).toBe(false);
        expect(isSessionInActiveGroup({ active: true, activeAt: fresh, metadata: { joy__state: 'archived' } })).toBe(false);
        expect(isSessionInActiveGroup({ active: true, activeAt: fresh, metadata: { joy__state: 'running' } })).toBe(true);
    });
    it('relay-inactive is never active', () => {
        expect(isSessionInActiveGroup({ active: false, activeAt: fresh })).toBe(false);
    });
});

describe('filterVisibleSessionListViewData', () => {
    it('a history row under a date header stays visible and enables the archive toggle', () => {
        const data: SessionListViewItem[] = [
            { type: 'header', title: 'Yesterday' },
            row('s1', false),
        ];
        const out = filterVisibleSessionListViewData(data, false);
        expect(out.map(i => i.type)).toEqual(['archive-toggle', 'header', 'session']);
    });

    it('hide-archived collapses history to the toggle alone', () => {
        const data: SessionListViewItem[] = [
            { type: 'active-sessions', sessions: [] },
            { type: 'header', title: 'Yesterday' },
            row('s1', false),
        ];
        const out = filterVisibleSessionListViewData(data, true);
        expect(out.map(i => i.type)).toEqual(['active-sessions', 'archive-toggle']);
    });

    it('documents the failure shape: a history row wrongly flagged active yields an orphan header', () => {
        // This is what the list looked like before the shared predicate. The
        // filter is unchanged on purpose — the fix is that no row reaches it
        // with active:true, since the row flag comes from the grouping's own
        // predicate. Kept as a tripwire for anyone re-deriving `active` from
        // the raw relay state.
        const out = filterVisibleSessionListViewData([{ type: 'header', title: 'Yesterday' }, row('zombie', true)], false);
        expect(out.map(i => i.type)).toEqual(['header']);
    });
});
