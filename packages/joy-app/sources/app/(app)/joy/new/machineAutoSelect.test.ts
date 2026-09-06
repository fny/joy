/**
 * New-session machine auto-selection (E4 sweep residual): the decision is
 * derived from the discovery resource of the CURRENT online set, so a
 * machine set that changes mid-probe restarts discovery instead of being
 * latched out by a "probed once" flag.
 */
import { describe, it, expect } from 'vitest';
import { ResourceStore, type ResourceEntry, type ResourceSpec } from '@/sync/resource';
import { onlineMachineIds, planMachineAutoSelect, type DiscoveryView } from './machineAutoSelect';

type M = { id: string; online: boolean };
const isOnline = (m: M) => m.online;
const pending: DiscoveryView = { data: undefined, failed: false };

describe('planMachineAutoSelect', () => {
    it('keeps an explicit selection', () => {
        expect(planMachineAutoSelect({ selectedMachineId: 'X', allMachines: [{ id: 'A', online: true }], isOnline, recent: undefined, keepPath: false, discovery: pending }))
            .toEqual({ kind: 'keep' });
    });

    it('prefers the last-used machine when online, with its folder unless a path was passed in', () => {
        const machines: M[] = [{ id: 'A', online: true }, { id: 'B', online: true }];
        expect(planMachineAutoSelect({ selectedMachineId: null, allMachines: machines, isOnline, recent: { machineId: 'B', path: '~/p' }, keepPath: false, discovery: pending }))
            .toEqual({ kind: 'select', machineId: 'B', path: '~/p' });
        expect(planMachineAutoSelect({ selectedMachineId: null, allMachines: machines, isOnline, recent: { machineId: 'B', path: '~/p' }, keepPath: true, discovery: pending }))
            .toEqual({ kind: 'select', machineId: 'B' });
        // Offline recent: fall through to discovery.
        expect(planMachineAutoSelect({ selectedMachineId: null, allMachines: [{ id: 'A', online: true }, { id: 'B', online: false }], isOnline, recent: { machineId: 'B' }, keepPath: false, discovery: pending }))
            .toEqual({ kind: 'probing' });
    });

    it('with nothing online selects the first machine, or nothing', () => {
        expect(planMachineAutoSelect({ selectedMachineId: null, allMachines: [{ id: 'A', online: false }], isOnline, recent: undefined, keepPath: false, discovery: pending }))
            .toEqual({ kind: 'select', machineId: 'A' });
        expect(planMachineAutoSelect({ selectedMachineId: null, allMachines: [], isOnline, recent: undefined, keepPath: false, discovery: pending }))
            .toEqual({ kind: 'keep' });
    });

    it('selects the first online machine that answered the probe, the first online one when none did or the probe failed', () => {
        const machines: M[] = [{ id: 'A', online: true }, { id: 'B', online: true }];
        expect(planMachineAutoSelect({ selectedMachineId: null, allMachines: machines, isOnline, recent: undefined, keepPath: false, discovery: { data: ['B'], failed: false } }))
            .toEqual({ kind: 'select', machineId: 'B' });
        expect(planMachineAutoSelect({ selectedMachineId: null, allMachines: machines, isOnline, recent: undefined, keepPath: false, discovery: { data: [], failed: false } }))
            .toEqual({ kind: 'select', machineId: 'A' });
        expect(planMachineAutoSelect({ selectedMachineId: null, allMachines: machines, isOnline, recent: undefined, keepPath: false, discovery: { data: undefined, failed: true } }))
            .toEqual({ kind: 'select', machineId: 'A' });
    });
});

describe('discovery keyed by the online set (the reviewer\'s sequence)', () => {
    /** The screen's binding, minus React: subscribed to the entry of the
     *  current set's key, ensuring it whenever the key changes. */
    function screen(store: ResourceStore, fetches: Record<string, () => Promise<string[]>>) {
        const started: string[] = [];
        const spec = (ids: string[]): ResourceSpec<string[]> => {
            const key = 'joy-machines:' + ids.join(',');
            return { key, fetch: async () => { started.push(key); return { kind: 'ok', data: await fetches[key]() }; } };
        };
        let machines: M[] = [];
        let selected: string | null = null;
        let current: ResourceSpec<string[]> | null = null;
        let unsubscribe = () => { };
        const derive = () => {
            const entry: ResourceEntry<string[]> = current ? store.peek(current.key) : store.peek('');
            const d = planMachineAutoSelect({
                selectedMachineId: selected, allMachines: machines, isOnline, recent: undefined, keepPath: false,
                discovery: { data: entry.data, failed: !entry.fetching && !entry.hasData && (entry.error !== null || entry.unavailable !== null) },
            });
            if (d.kind === 'select') selected = d.machineId;
        };
        const setMachines = (next: M[]) => {
            machines = next;
            const ids = onlineMachineIds(machines, isOnline);
            const nextSpec = ids.length ? spec(ids) : null;
            if (nextSpec?.key !== current?.key) {
                unsubscribe();
                current = nextSpec;
                unsubscribe = current ? store.subscribe(current.key, derive) : () => { };
                if (current && !selected) void store.ensure(current);
            }
            derive();
        };
        return { setMachines, started, get selected() { return selected; } };
    }

    it('A probing, machines become B, A settles → B is probed and selected (A never selected)', async () => {
        const store = new ResourceStore();
        let resolveA!: (ids: string[]) => void;
        let resolveB!: (ids: string[]) => void;
        const s = screen(store, {
            'joy-machines:A': () => new Promise<string[]>(r => { resolveA = r; }),
            'joy-machines:B': () => new Promise<string[]>(r => { resolveB = r; }),
        });
        s.setMachines([{ id: 'A', online: true }]);
        expect(s.started).toEqual(['joy-machines:A']);
        expect(s.selected).toBeNull();

        s.setMachines([{ id: 'B', online: true }]);
        expect(s.started).toEqual(['joy-machines:A', 'joy-machines:B']); // B is probed, no latch
        resolveA(['A']);
        await new Promise(r => setTimeout(r, 0));
        expect(s.selected).toBeNull(); // A's answer belongs to A's key, not to the current set

        resolveB(['B']);
        await new Promise(r => setTimeout(r, 0));
        expect(s.selected).toBe('B');
    });

    it('a set that changes back to a set already probed reuses that answer at once', async () => {
        const store = new ResourceStore();
        const s = screen(store, {
            'joy-machines:A': async () => ['A'],
            'joy-machines:B': () => new Promise<string[]>(() => { }),
        });
        s.setMachines([{ id: 'A', online: true }]);
        await new Promise(r => setTimeout(r, 0));
        expect(s.selected).toBe('A');
    });
});
