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

const row = (
    id: string,
    active: boolean,
    facts?: { headless?: boolean; blocked?: boolean; permission?: boolean; automation?: unknown },
) =>
    ({
        type: 'session',
        session: {
            id,
            active,
            facts: { headless: false, blocked: false, permission: false, automation: null, ...facts },
        } as any,
    }) as SessionListViewItem;

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

    it('a header whose every row was filtered out is dropped, not left orphaned', () => {
        // This case used to yield ['header'] — a date header with nothing
        // under it — and the test asserted that, as a tripwire for anyone
        // re-deriving `active` from the raw relay state. The real defence was
        // upstream: no row reaches here with a stale active:true.
        //
        // The defence is now here as well. Hiding headless sessions means a
        // date group CAN legitimately lose every row it had, so the header
        // waits for a row that survives before it is emitted — which closes
        // the orphan shape for the zombie-row case too. Still a tripwire, and
        // now it asserts the good shape rather than the bad one.
        const out = filterVisibleSessionListViewData([{ type: 'header', title: 'Yesterday' }, row('zombie', true)], false);
        expect(out.map(i => i.type)).toEqual([]);
    });

    it('keeps a header that still has a row under it', () => {
        const out = filterVisibleSessionListViewData([{ type: 'header', title: 'Yesterday' }, row('s1', false)], false);
        expect(out.map(i => i.type)).toEqual(['archive-toggle', 'header', 'session']);
    });
});

/**
 * `joy new --headless` sessions are built into the list and hidden HERE, the
 * same way archived ones are. Hiding them in the store instead made the reveal
 * impossible: the list is rebuilt on session change, not on settings change,
 * so a toggle could not put back what the store had already dropped.
 */
describe('headless sessions', () => {
    const types = (out: SessionListViewItem[]) => out.map((i) => i.type);

    it('is hidden by default, and offers the toggle that reveals it', () => {
        const data: SessionListViewItem[] = [
            { type: 'active-sessions', sessions: [] },
            { type: 'header', title: 'Yesterday' },
            row('quiet', false, { headless: true }),
        ];
        const out = filterVisibleSessionListViewData(data, false);
        expect(types(out)).toEqual(['active-sessions', 'headless-toggle']);
        expect(out.find((i) => i.type === 'headless-toggle')).toMatchObject({ hidden: true });
    });

    it('appears when the toggle is on, and the toggle stays so there is a way back', () => {
        const data: SessionListViewItem[] = [
            { type: 'active-sessions', sessions: [] },
            { type: 'header', title: 'Yesterday' },
            row('quiet', false, { headless: true }),
        ];
        const out = filterVisibleSessionListViewData(data, false, true);
        expect(types(out)).toEqual(['active-sessions', 'archive-toggle', 'headless-toggle', 'header', 'session']);
        expect(out.find((i) => i.type === 'headless-toggle')).toMatchObject({ hidden: false });
    });

    it('offers no toggle at all when there is nothing headless to reveal', () => {
        const data: SessionListViewItem[] = [
            { type: 'active-sessions', sessions: [] },
            { type: 'header', title: 'Yesterday' },
            row('ordinary', false),
        ];
        expect(types(filterVisibleSessionListViewData(data, false))).not.toContain('headless-toggle');
    });

    it('a headless session waiting on a HUMAN is never hidden, toggle or no toggle', () => {
        for (const facts of [{ headless: true, blocked: true }, { headless: true, permission: true }]) {
            const data: SessionListViewItem[] = [
                { type: 'active-sessions', sessions: [] },
                { type: 'header', title: 'Yesterday' },
                row('needs-me', false, facts),
            ];
            const out = filterVisibleSessionListViewData(data, false);
            expect(types(out)).toContain('session');
            // Nothing is being hidden, so nothing offers to unhide it.
            expect(types(out)).not.toContain('headless-toggle');
        }
    });

    it('hides a headless session inside the ACTIVE block too, not just history', () => {
        const data: SessionListViewItem[] = [
            {
                type: 'active-sessions',
                sessions: [
                    { id: 'ordinary', active: true, facts: { headless: false } } as any,
                    { id: 'quiet', active: true, facts: { headless: true } } as any,
                ],
            },
        ];
        const hidden = filterVisibleSessionListViewData(data, false)[0] as { sessions: Array<{ id: string }> };
        expect(hidden.sessions.map((s) => s.id)).toEqual(['ordinary']);
        const shown = filterVisibleSessionListViewData(data, false, true)[0] as { sessions: Array<{ id: string }> };
        expect(shown.sessions.map((s) => s.id)).toEqual(['ordinary', 'quiet']);
    });

    it('an automation run is NOT hidden while it runs, even though it is headless', () => {
        // The marker is a visibility override that lasts exactly as long as
        // the run. Without it a run would be invisible for its whole life and
        // then appear as history, which is backwards.
        const data: SessionListViewItem[] = [
            { type: 'active-sessions', sessions: [] },
            { type: 'header', title: 'Yesterday' },
            row('run', false, { headless: true, automation: { runId: 'r1' } }),
        ];
        const out = filterVisibleSessionListViewData(data, false);
        expect(out.map((i) => i.type)).toContain('session');
        expect(out.map((i) => i.type)).not.toContain('headless-toggle');
    });

    it('a FAILED run stays visible — dismissing it is the only way it goes', () => {
        const data: SessionListViewItem[] = [
            { type: 'active-sessions', sessions: [] },
            { type: 'header', title: 'Yesterday' },
            row('broke', false, { headless: true, automation: { runId: 'r1', failed: true, errorCode: 'blocked:login' } }),
        ];
        expect(filterVisibleSessionListViewData(data, false).map((i) => i.type)).toContain('session');
    });

    it('treats a row with no facts as ordinary rather than throwing', () => {
        const data: SessionListViewItem[] = [
            { type: 'active-sessions', sessions: [] },
            { type: 'header', title: 'Yesterday' },
            { type: 'session', session: { id: 'legacy', active: false } as any },
        ];
        expect(() => filterVisibleSessionListViewData(data, false)).not.toThrow();
        expect(types(filterVisibleSessionListViewData(data, false))).toContain('session');
    });
});
