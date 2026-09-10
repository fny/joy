import { describe, expect, it } from 'vitest';
import { buildListLayout, partitionForList, pinnedStateRank, stateUrgency, type ListSession } from './sessionListModel';

const NOW = 1_800_000_000_000;

const s = (over: Partial<ListSession> & Pick<ListSession, 'id'>): ListSession => ({
    state: 'waiting',
    machineId: 'faraz-vip',
    activeAt: NOW,
    ...over,
});

const layout = (over: Partial<Parameters<typeof buildListLayout>[0]>) =>
    buildListLayout({ sessions: [], pinned: [], collapsed: [], ...over });
const keys = (l: ReturnType<typeof layout>) => l.map((x) => x.key);
const idsIn = (l: ReturnType<typeof layout>, key: string) =>
    l.find((x) => x.key === key)?.sessions.map((x) => x.id) ?? [];

describe('sections', () => {
    it('is empty for an empty list', () => {
        expect(layout({})).toEqual([]);
    });

    it('groups by machine, and has no pinned section until something is pinned', () => {
        const l = layout({
            sessions: [s({ id: 'a', machineId: 'fny' }), s({ id: 'b', machineId: 'boite' })],
        });
        expect(keys(l).sort()).toEqual(['m:boite', 'm:fny']);
    });

    it('puts the busiest machine first by default', () => {
        const l = layout({
            sessions: [
                s({ id: 'a', machineId: 'one' }),
                s({ id: 'b', machineId: 'two' }), s({ id: 'c', machineId: 'two' }),
            ],
        });
        expect(keys(l)).toEqual(['m:two', 'm:one']);
    });

    it('honours an explicit machine order when the caller gives one', () => {
        const l = layout({
            sessions: [
                s({ id: 'a', machineId: 'one' }),
                s({ id: 'b', machineId: 'two' }), s({ id: 'c', machineId: 'two' }),
            ],
            machineOrder: ['one', 'two'],
        });
        expect(keys(l)).toEqual(['m:one', 'm:two']);
    });

    it('sorts newest first inside a section', () => {
        const l = layout({
            sessions: [
                s({ id: 'older', activeAt: NOW - 5000 }),
                s({ id: 'newest', activeAt: NOW }),
                s({ id: 'middle', activeAt: NOW - 100 }),
            ],
        });
        expect(idsIn(l, 'm:faraz-vip')).toEqual(['newest', 'middle', 'older']);
    });

    it('keeps a session with no machine in its own section rather than dropping it', () => {
        const l = layout({ sessions: [s({ id: 'a', machineId: null })] });
        expect(keys(l)).toEqual(['m:']);
        expect(l[0].machineId).toBeNull();
    });
});

describe('rule 1 — a session appears exactly once', () => {
    it('a pin leaves its machine section', () => {
        const l = layout({ sessions: [s({ id: 'a' }), s({ id: 'b' })], pinned: ['a'] });
        expect(keys(l)).toEqual(['pinned', 'm:faraz-vip']);
        expect(idsIn(l, 'pinned')).toEqual(['a']);
        expect(idsIn(l, 'm:faraz-vip')).toEqual(['b']);
    });

    it('a machine whose only session is pinned gets no section of its own', () => {
        const l = layout({ sessions: [s({ id: 'a', machineId: 'fny' })], pinned: ['a'] });
        expect(keys(l)).toEqual(['pinned']);
    });

    it('every session lands somewhere, and nowhere twice', () => {
        const sessions = [
            s({ id: 'a', machineId: 'fny' }),
            s({ id: 'b', machineId: 'boite' }),
            s({ id: 'c', machineId: 'fny' }),
        ];
        const l = layout({ sessions, pinned: ['c'] });
        const seen = l.flatMap((x) => x.sessions.map((y) => y.id));
        expect(seen.slice().sort()).toEqual(['a', 'b', 'c']);
        expect(new Set(seen).size).toBe(seen.length);
    });

    it('a pinned id that is not in the list is simply not a section', () => {
        expect(layout({ sessions: [], pinned: ['ghost'] })).toEqual([]);
    });
});

describe('rule 2 — a collapsed section still reports what is inside', () => {
    it('names the state that most wants a human, not the newest row', () => {
        const l = layout({
            sessions: [
                s({ id: 'a', state: 'thinking' }),
                s({ id: 'b', state: 'blocked' }),
                s({ id: 'c', state: 'waiting' }),
            ],
            collapsed: ['m:faraz-vip'],
        });
        expect(l[0].collapsed).toBe(true);
        expect(l[0].worstState).toBe('blocked');
        expect(l[0].sessions).toHaveLength(3); // the count survives collapse
    });

    it('collapsing one machine leaves the others open', () => {
        const l = layout({
            sessions: [s({ id: 'a', machineId: 'fny' }), s({ id: 'b', machineId: 'boite' })],
            collapsed: ['m:fny'],
        });
        expect(l.find((x) => x.key === 'm:fny')!.collapsed).toBe(true);
        expect(l.find((x) => x.key === 'm:boite')!.collapsed).toBe(false);
    });

    it('pinned never collapses, whatever the collapse list says', () => {
        const l = layout({ sessions: [s({ id: 'a' })], pinned: ['a'], collapsed: ['pinned'] });
        expect(l[0].collapsed).toBe(false);
    });
});

describe('partitionForList — the two ways pinning silently did nothing', () => {
    const part = (over: Partial<Parameters<typeof partitionForList>[0]>) =>
        partitionForList({ sessions: [], pinned: [], hideInactive: false, ...over });
    const ids = (xs: ListSession[]) => xs.map((x) => x.id);

    it('pins a RUNNING session — a pin outranks the active block', () => {
        const p = part({ sessions: [s({ id: 'a', active: true }), s({ id: 'b', active: true })], pinned: ['a'] });
        expect(ids(p.pins)).toEqual(['a']);
        expect(ids(p.active)).toEqual(['b']); // and it is not in both
    });

    it('pins with "hide archived" on, where there is nothing inactive to pin from', () => {
        const p = part({
            sessions: [s({ id: 'a', active: true }), s({ id: 'old' })],
            pinned: ['a'],
            hideInactive: true,
        });
        expect(ids(p.pins)).toEqual(['a']);
        expect(ids(p.rest)).toEqual([]); // the archived one is still hidden
    });

    it('keeps a pinned session even when it is archived and archived are hidden', () => {
        const p = part({ sessions: [s({ id: 'old' })], pinned: ['old'], hideInactive: true });
        expect(ids(p.pins)).toEqual(['old']);
    });

    it('places every session exactly once', () => {
        const sessions = [s({ id: 'a', active: true }), s({ id: 'b' }), s({ id: 'c', active: true })];
        const p = part({ sessions, pinned: ['c'] });
        const seen = [...ids(p.pins), ...ids(p.active), ...ids(p.rest)];
        expect(seen.slice().sort()).toEqual(['a', 'b', 'c']);
        expect(new Set(seen).size).toBe(seen.length);
    });

    it('counts what "hide archived" is hiding, so the toggle can be offered', () => {
        const sessions = [s({ id: 'a', active: true }), s({ id: 'b' }), s({ id: 'c' })];
        expect(part({ sessions, hideInactive: true }).archived).toBe(2);
        expect(part({ sessions, hideInactive: false }).archived).toBe(2);
        expect(part({ sessions: [s({ id: 'a', active: true })] }).archived).toBe(0);
    });

    it('changes nothing when nothing is pinned', () => {
        const p = part({ sessions: [s({ id: 'a', active: true }), s({ id: 'b' })] });
        expect(ids(p.pins)).toEqual([]);
        expect(ids(p.active)).toEqual(['a']);
        expect(ids(p.rest)).toEqual(['b']);
    });
});

describe('the pinned order', () => {
    const pinnedIds = (over: Partial<Parameters<typeof buildListLayout>[0]>) =>
        buildListLayout({ sessions: [], pinned: [], collapsed: [], ...over })
            .find((x) => x.key === 'pinned')?.sessions.map((x) => x.id) ?? [];

    it('is by project name by default, not by recency', () => {
        const ids = pinnedIds({
            sessions: [
                s({ id: 'c', project: '~/work/zebra', activeAt: NOW }),
                s({ id: 'a', project: '~/work/apple', activeAt: NOW - 90_000 }),
                s({ id: 'b', project: '~/work/mango', activeAt: NOW - 1_000 }),
            ],
            pinned: ['a', 'b', 'c'],
        });
        expect(ids).toEqual(['a', 'b', 'c']);
    });

    it('does not reorder itself when a pinned agent speaks', () => {
        const before = [
            s({ id: 'a', project: '~/apple', activeAt: NOW - 50_000 }),
            s({ id: 'b', project: '~/mango', activeAt: NOW - 10_000 }),
        ];
        const after = [
            s({ id: 'a', project: '~/apple', activeAt: NOW }), // just spoke
            s({ id: 'b', project: '~/mango', activeAt: NOW - 10_000 }),
        ];
        expect(pinnedIds({ sessions: before, pinned: ['a', 'b'] }))
            .toEqual(pinnedIds({ sessions: after, pinned: ['a', 'b'] }));
    });

    it('by state: needs-a-decision, then done, then working, then gone', () => {
        const ids = pinnedIds({
            sessions: [
                s({ id: 'gone', state: 'disconnected', project: '~/a' }),
                s({ id: 'working', state: 'thinking', project: '~/a' }),
                s({ id: 'done', state: 'waiting', project: '~/a' }),
                s({ id: 'decide', state: 'permission_required', project: '~/a' }),
            ],
            pinned: ['gone', 'working', 'done', 'decide'],
            pinnedSort: 'state',
        });
        expect(ids).toEqual(['decide', 'done', 'working', 'gone']);
    });

    it('by state: falls back to project name inside a bucket, so it stays stable', () => {
        const ids = pinnedIds({
            sessions: [
                s({ id: 'z', state: 'thinking', project: '~/zebra', activeAt: NOW }),
                s({ id: 'a', state: 'tasks', project: '~/apple', activeAt: NOW - 99_000 }),
                s({ id: 'm', state: 'agents', project: '~/mango' }),
            ],
            pinned: ['z', 'a', 'm'],
            pinnedSort: 'state',
        });
        expect(ids).toEqual(['a', 'm', 'z']);
    });

    it('puts blocked with permission_required — both are stopped until you answer', () => {
        expect(pinnedStateRank('blocked')).toBe(pinnedStateRank('permission_required'));
        expect(pinnedStateRank('permission_required')).toBeLessThan(pinnedStateRank('waiting'));
        expect(pinnedStateRank('waiting')).toBeLessThan(pinnedStateRank('thinking'));
        expect(pinnedStateRank('thinking')).toBeLessThan(pinnedStateRank('disconnected'));
    });

    it('keeps amber out of the answer-me bucket — stalled is not a question', () => {
        expect(pinnedStateRank('stalled')).toBe(pinnedStateRank('thinking'));
        expect(pinnedStateRank('retrying')).toBe(pinnedStateRank('thinking'));
    });

    it('sorts an unknown state last rather than to the front', () => {
        expect(pinnedStateRank('something-new')).toBe(pinnedStateRank('disconnected'));
    });

    it('machine sections are still newest-first — only pins are by project', () => {
        const l = buildListLayout({
            sessions: [
                s({ id: 'old', project: '~/apple', activeAt: NOW - 5_000 }),
                s({ id: 'new', project: '~/zebra', activeAt: NOW }),
            ],
            pinned: [],
            collapsed: [],
        });
        expect(l[0].sessions.map((x) => x.id)).toEqual(['new', 'old']);
    });
});

describe('stateUrgency', () => {
    it('ranks waiting-on-a-human above anything merely running', () => {
        expect(stateUrgency('blocked')).toBeGreaterThan(stateUrgency('thinking'));
        expect(stateUrgency('permission_required')).toBeGreaterThan(stateUrgency('agents'));
        expect(stateUrgency('thinking')).toBeGreaterThan(stateUrgency('waiting'));
    });

    it('gives an unknown state the bottom rank rather than throwing', () => {
        expect(stateUrgency('something-new')).toBe(0);
    });
});
