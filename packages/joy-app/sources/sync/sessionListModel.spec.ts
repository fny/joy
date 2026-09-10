import { describe, expect, it } from 'vitest';
import { buildListLayout, stateUrgency, type ListSession } from './sessionListModel';

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
