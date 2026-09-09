import { describe, expect, it } from 'vitest';
import {
    buildListLayout,
    dayBucket,
    groupOf,
    matchesFilter,
    viewClaims,
    type ListSession,
    type SessionView,
} from './sessionListModel';

const NOW = new Date(2026, 8, 9, 12, 0, 0).getTime();
const day = 86_400_000;

const s = (over: Partial<ListSession> & Pick<ListSession, 'id'>): ListSession => ({
    state: 'waiting',
    machineId: 'faraz-vip',
    path: '/home/f/Workspace/joy',
    flavor: 'claude',
    createdAt: NOW,
    activeAt: NOW,
    ...over,
});

const layout = (over: Partial<Parameters<typeof buildListLayout>[0]>) => buildListLayout({
    sessions: [],
    pinned: [],
    views: [],
    axis: 'project',
    filter: 'all',
    collapsed: [],
    now: NOW,
    ...over,
});
const keys = (l: ReturnType<typeof layout>) => l.sections.map((x) => x.key);
const idsIn = (l: ReturnType<typeof layout>, key: string) =>
    l.sections.find((x) => x.key === key)?.sessions.map((x) => x.id) ?? [];

describe('matchesFilter', () => {
    it('needs me is the two states holding a session up', () => {
        expect(matchesFilter(s({ id: 'a', state: 'blocked' }), 'needs')).toBe(true);
        expect(matchesFilter(s({ id: 'a', state: 'permission_required' }), 'needs')).toBe(true);
        expect(matchesFilter(s({ id: 'a', state: 'thinking' }), 'needs')).toBe(false);
    });

    it('working covers every phase of an open turn, not just thinking', () => {
        for (const state of ['thinking', 'agents', 'tasks', 'compacting', 'retrying']) {
            expect(matchesFilter(s({ id: 'a', state }), 'working'), state).toBe(true);
        }
        expect(matchesFilter(s({ id: 'a', state: 'waiting' }), 'working')).toBe(false);
    });

    it('all keeps everything', () => {
        expect(matchesFilter(s({ id: 'a', state: 'disconnected' }), 'all')).toBe(true);
    });
});

describe('viewClaims', () => {
    it('claims a hand-picked member with no rule at all — that is what Pinned is', () => {
        expect(viewClaims({ id: 'v', name: 'V', ids: ['a'] }, s({ id: 'a' }))).toBe(true);
        expect(viewClaims({ id: 'v', name: 'V', ids: ['a'] }, s({ id: 'b' }))).toBe(false);
    });

    it('a view with neither rule nor members claims nothing', () => {
        expect(viewClaims({ id: 'v', name: 'V' }, s({ id: 'a' }))).toBe(false);
    });

    it('ANDs its rule fields', () => {
        const v: SessionView = { id: 'v', name: 'V', machineId: 'fny', flavor: 'codex' };
        expect(viewClaims(v, s({ id: 'a', machineId: 'fny', flavor: 'codex' }))).toBe(true);
        expect(viewClaims(v, s({ id: 'a', machineId: 'fny', flavor: 'claude' }))).toBe(false);
        expect(viewClaims(v, s({ id: 'a', machineId: 'boite', flavor: 'codex' }))).toBe(false);
    });

    it('matches path as a prefix, so a view can scope to a tree', () => {
        const v: SessionView = { id: 'v', name: 'V', path: '/home/f/Workspace' };
        expect(viewClaims(v, s({ id: 'a', path: '/home/f/Workspace/joy' }))).toBe(true);
        expect(viewClaims(v, s({ id: 'a', path: '/home/f/Vibe/other' }))).toBe(false);
    });

    it('takes a hand-picked straggler ALONGSIDE a rule — the case neither alone expresses', () => {
        const v: SessionView = { id: 'v', name: 'V', machineId: 'fny', ids: ['straggler'] };
        expect(viewClaims(v, s({ id: 'straggler', machineId: 'boite' }))).toBe(true);
        expect(viewClaims(v, s({ id: 'other', machineId: 'fny' }))).toBe(true);
    });

    it('treats a missing flavour as claude, the way the rest of the app does', () => {
        expect(viewClaims({ id: 'v', name: 'V', flavor: 'claude' }, s({ id: 'a', flavor: null }))).toBe(true);
    });
});

describe('grouping axes', () => {
    it('project groups by path and shows the folder name', () => {
        expect(groupOf(s({ id: 'a', path: '/home/f/Workspace/joy' }), 'project', NOW))
            .toEqual({ key: 'p:/home/f/Workspace/joy', title: 'joy' });
    });

    it('machine groups by machine', () => {
        expect(groupOf(s({ id: 'a', machineId: 'fny' }), 'machine', NOW).key).toBe('m:fny');
    });

    it('date buckets relative to today', () => {
        expect(dayBucket(NOW, NOW)).toBe('Today');
        expect(dayBucket(NOW - day, NOW)).toBe('Yesterday');
        expect(dayBucket(NOW - 3 * day, NOW)).toBe('3 days ago');
        expect(dayBucket(NOW - 30 * day, NOW)).toBe('Earlier');
    });

    it('orders date buckets in time order, not by size', () => {
        const l = layout({
            axis: 'date',
            sessions: [
                s({ id: 'old', createdAt: NOW - 20 * day }),
                s({ id: 'y', createdAt: NOW - day }),
                s({ id: 't1' }), s({ id: 't2' }),
            ],
        });
        expect(l.sections.map((x) => x.title)).toEqual(['Today', 'Yesterday', 'Earlier']);
    });

    it('orders other axes busiest first, so the project you are in rises', () => {
        const l = layout({
            sessions: [
                s({ id: 'a', path: '/p/one' }),
                s({ id: 'b', path: '/p/two' }), s({ id: 'c', path: '/p/two' }),
            ],
        });
        expect(l.sections.map((x) => x.title)).toEqual(['two', 'one']);
    });

    it('sorts newest first INSIDE a section — time is the sort, not the grouping', () => {
        const l = layout({
            sessions: [
                s({ id: 'older', activeAt: NOW - 5000 }),
                s({ id: 'newest', activeAt: NOW }),
                s({ id: 'middle', activeAt: NOW - 100 }),
            ],
        });
        expect(idsIn(l, 'p:/home/f/Workspace/joy')).toEqual(['newest', 'middle', 'older']);
    });
});

describe('rule 1 — a session appears exactly once', () => {
    it('a pin leaves its group', () => {
        const l = layout({ sessions: [s({ id: 'a' }), s({ id: 'b' })], pinned: ['a'] });
        expect(keys(l)).toEqual(['pinned', 'p:/home/f/Workspace/joy']);
        expect(idsIn(l, 'pinned')).toEqual(['a']);
        expect(idsIn(l, 'p:/home/f/Workspace/joy')).toEqual(['b']);
    });

    it('pins outrank a view that would also claim them', () => {
        const l = layout({
            sessions: [s({ id: 'a', machineId: 'fny' })],
            pinned: ['a'],
            views: [{ id: 'v1', name: 'fny', machineId: 'fny' }],
        });
        expect(keys(l)).toEqual(['pinned']);
    });

    it('the FIRST view to claim a session takes it', () => {
        const l = layout({
            sessions: [s({ id: 'a', machineId: 'fny', flavor: 'codex' })],
            views: [
                { id: 'first', name: 'On fny', machineId: 'fny' },
                { id: 'second', name: 'Codex', flavor: 'codex' },
            ],
        });
        expect(keys(l)).toEqual(['v:first']);
    });

    it('every session lands somewhere, and nowhere twice', () => {
        const sessions = [
            s({ id: 'a', machineId: 'fny' }),
            s({ id: 'b', path: '/other' }),
            s({ id: 'c', state: 'blocked' }),
        ];
        const l = layout({
            sessions,
            pinned: ['c'],
            views: [{ id: 'v', name: 'fny', machineId: 'fny' }],
        });
        const seen = l.sections.flatMap((x) => x.sessions.map((y) => y.id));
        expect(seen.slice().sort()).toEqual(['a', 'b', 'c']);
        expect(new Set(seen).size).toBe(seen.length);
    });
});

describe('rule 2 — a filtered view says what it lost', () => {
    it('reports the count instead of quietly shrinking', () => {
        const l = layout({
            sessions: [s({ id: 'a', state: 'blocked' }), s({ id: 'b', state: 'waiting' })],
            pinned: ['a', 'b'],
            filter: 'needs',
        });
        const pinned = l.sections[0];
        expect(pinned.sessions.map((x) => x.id)).toEqual(['a']);
        expect(pinned.total).toBe(2);
        expect(pinned.hiddenByFilter).toBe(1);
    });

    it('a view emptied by the filter still stands, so its absence is explained', () => {
        const l = layout({
            sessions: [s({ id: 'a', state: 'waiting' })],
            pinned: ['a'],
            filter: 'needs',
        });
        expect(keys(l)).toEqual(['pinned']);
        expect(l.sections[0].sessions).toEqual([]);
        expect(l.sections[0].hiddenByFilter).toBe(1);
    });

    it('but an emptied derived GROUP is dropped — that is just noise', () => {
        const l = layout({ sessions: [s({ id: 'a', state: 'waiting' })], filter: 'needs' });
        expect(l.sections).toEqual([]);
        expect(l.shown).toBe(0);
        expect(l.total).toBe(1);
    });
});

describe('rule 3 — a collapsed section still reports its worst state', () => {
    it('names the state that most wants a human, not the newest row', () => {
        const l = layout({
            sessions: [
                s({ id: 'a', state: 'thinking' }),
                s({ id: 'b', state: 'blocked' }),
                s({ id: 'c', state: 'waiting' }),
            ],
            collapsed: ['p:/home/f/Workspace/joy'],
        });
        expect(l.sections[0].collapsed).toBe(true);
        expect(l.sections[0].worstState).toBe('blocked');
        expect(l.sections[0].total).toBe(3);
    });

    it('reports the worst of what is VISIBLE, not of what the filter removed', () => {
        const l = layout({
            sessions: [s({ id: 'a', state: 'blocked' }), s({ id: 'b', state: 'thinking' })],
            filter: 'working',
            collapsed: ['p:/home/f/Workspace/joy'],
        });
        expect(l.sections[0].worstState).toBe('thinking');
    });

    it('pins are never collapsed, whatever the collapse list says', () => {
        const l = layout({ sessions: [s({ id: 'a' })], pinned: ['a'], collapsed: ['pinned'] });
        expect(l.sections[0].collapsed).toBe(false);
    });
});

describe('rule 4 — the caller can always say what is hidden', () => {
    it('counts what is on screen against what exists', () => {
        const l = layout({
            sessions: [
                s({ id: 'a', state: 'blocked' }),
                s({ id: 'b', state: 'waiting' }),
                s({ id: 'c', state: 'waiting' }),
            ],
            filter: 'needs',
        });
        expect([l.shown, l.total]).toEqual([1, 3]);
    });

    it('a collapsed section still counts as shown — it is compressed, not filtered', () => {
        const l = layout({ sessions: [s({ id: 'a' }), s({ id: 'b' })], collapsed: ['p:/home/f/Workspace/joy'] });
        expect(l.shown).toBe(2);
    });
});

describe('the empty list', () => {
    it('has no sections and no counts', () => {
        expect(layout({})).toEqual({ sections: [], shown: 0, total: 0 });
    });
});
