import { describe, it, expect } from 'vitest';
import { nextLogState, fetchBranchOf, SessionLogs, type LogState, type LogEvent } from './sessionLogMachine';

type Kind = LogState['kind'];
type Type = LogEvent['type'];
const G = 3; // the current generation in every sample state
const ANCHORED: Extract<LogState, { kind: 'anchored' }> = { kind: 'anchored', gen: G, lastSeq: 100, oldestSeq: 50, hasMoreOlder: true };

const STATES: Record<Kind, LogState> = {
    cold: { kind: 'cold', gen: G },
    anchoring: { kind: 'anchoring', gen: G },
    anchored: ANCHORED,
    loading_older: { kind: 'loading_older', gen: G, lastSeq: 100, oldestSeq: 50, hasMoreOlder: true },
    evicted: { kind: 'evicted', gen: G, lastSeq: 100 },
    reanchoring: { kind: 'reanchoring', gen: G },
    forgotten: { kind: 'forgotten', gen: G },
};
// The sample page is an ANCHOR page; other page kinds are tested below.
const EVENTS: Record<Type, LogEvent> = {
    fetch_started: { type: 'fetch_started', gen: G, viewing: true },
    fetch_failed: { type: 'fetch_failed', gen: G },
    page_applied: { type: 'page_applied', gen: G, page: 'anchor', minSeq: 80, maxSeq: 120, scannedTo: 75, hasMore: true },
    older_started: { type: 'older_started', gen: G },
    older_failed: { type: 'older_failed', gen: G },
    reset: { type: 'reset', gen: G + 1 },
    evicted: { type: 'evicted' },
    recreated: { type: 'recreated', gen: G + 1 },
    forgotten: { type: 'forgotten', gen: G + 1 },
};

const EXPECTED: Record<`${Kind}+${Type}`, Kind> = {
    'cold+fetch_started': 'anchoring', 'cold+fetch_failed': 'cold', 'cold+page_applied': 'cold', 'cold+older_started': 'cold',
    'cold+older_failed': 'cold', 'cold+reset': 'cold', 'cold+evicted': 'cold', 'cold+recreated': 'cold', 'cold+forgotten': 'forgotten',
    'anchoring+fetch_started': 'anchoring', 'anchoring+fetch_failed': 'cold', 'anchoring+page_applied': 'anchored', 'anchoring+older_started': 'anchoring',
    'anchoring+older_failed': 'anchoring', 'anchoring+reset': 'cold', 'anchoring+evicted': 'anchoring', 'anchoring+recreated': 'anchoring', 'anchoring+forgotten': 'forgotten',
    'anchored+fetch_started': 'anchored', 'anchored+fetch_failed': 'anchored', 'anchored+page_applied': 'anchored', 'anchored+older_started': 'loading_older',
    'anchored+older_failed': 'anchored', 'anchored+reset': 'cold', 'anchored+evicted': 'evicted', 'anchored+recreated': 'anchored', 'anchored+forgotten': 'forgotten',
    'loading_older+fetch_started': 'loading_older', 'loading_older+fetch_failed': 'loading_older', 'loading_older+page_applied': 'anchored',
    'loading_older+older_started': 'loading_older', 'loading_older+older_failed': 'anchored', 'loading_older+reset': 'cold', 'loading_older+evicted': 'evicted',
    'loading_older+recreated': 'loading_older', 'loading_older+forgotten': 'forgotten',
    'evicted+fetch_started': 'reanchoring', 'evicted+fetch_failed': 'evicted', 'evicted+page_applied': 'evicted', 'evicted+older_started': 'evicted',
    'evicted+older_failed': 'evicted', 'evicted+reset': 'cold', 'evicted+evicted': 'evicted', 'evicted+recreated': 'cold', 'evicted+forgotten': 'forgotten',
    'reanchoring+fetch_started': 'reanchoring', 'reanchoring+fetch_failed': 'cold', 'reanchoring+page_applied': 'anchored', 'reanchoring+older_started': 'reanchoring',
    'reanchoring+older_failed': 'reanchoring', 'reanchoring+reset': 'cold', 'reanchoring+evicted': 'reanchoring', 'reanchoring+recreated': 'reanchoring', 'reanchoring+forgotten': 'forgotten',
    'forgotten+fetch_started': 'forgotten', 'forgotten+fetch_failed': 'forgotten', 'forgotten+page_applied': 'forgotten', 'forgotten+older_started': 'forgotten',
    'forgotten+older_failed': 'forgotten', 'forgotten+reset': 'cold', 'forgotten+evicted': 'forgotten', 'forgotten+recreated': 'forgotten', 'forgotten+forgotten': 'forgotten',
};

describe('sessionLogMachine: the transition table is total', () => {
    for (const [kind, s] of Object.entries(STATES) as [Kind, LogState][]) {
        for (const [type, ev] of Object.entries(EVENTS) as [Type, LogEvent][]) {
            it(`${kind} + ${type} → ${EXPECTED[`${kind}+${type}`] ?? 'MISSING'}`, () => {
                const want = EXPECTED[`${kind}+${type}`];
                expect(want, `no expectation for ${kind}+${type}`).toBeDefined();
                expect(nextLogState(s, ev).kind).toBe(want);
            });
        }
    }
    it('every fenced event from another generation is ignored in every state', () => {
        for (const s of Object.values(STATES)) {
            for (const ev of Object.values(EVENTS)) {
                if (!('gen' in ev) || ev.type === 'reset' || ev.type === 'recreated' || ev.type === 'forgotten') continue;
                expect(nextLogState(s, { ...ev, gen: G - 1 })).toBe(s);
            }
        }
    });
});

describe('sessionLogMachine: cursors', () => {
    it('anchoring sets both ends: forward = highest row, backward = oldest bound scanned even when nothing rendered (#4)', () => {
        expect(nextLogState(STATES.anchoring, { type: 'page_applied', gen: G, page: 'anchor', minSeq: 80, maxSeq: 120, scannedTo: 75, hasMore: true }))
            .toEqual({ kind: 'anchored', gen: G, lastSeq: 120, oldestSeq: 75, hasMoreOlder: true });
        expect(nextLogState(STATES.anchoring, { type: 'page_applied', gen: G, page: 'anchor', minSeq: null, maxSeq: null, scannedTo: 40, hasMore: true }))
            .toEqual({ kind: 'anchored', gen: G, lastSeq: 0, oldestSeq: 40, hasMoreOlder: true });
        expect(nextLogState(STATES.anchoring, { type: 'page_applied', gen: G, page: 'anchor', minSeq: null, maxSeq: null, scannedTo: null, hasMore: false }))
            .toEqual({ kind: 'anchored', gen: G, lastSeq: 0, oldestSeq: null, hasMoreOlder: false });
    });
    it('a forward page moves only the forward cursor, in anchored and while loading older', () => {
        const fwd: LogEvent = { type: 'page_applied', gen: G, page: 'forward', minSeq: 101, maxSeq: 130, scannedTo: null, hasMore: false };
        expect(nextLogState(STATES.anchored, fwd)).toMatchObject({ kind: 'anchored', lastSeq: 130, oldestSeq: 50 });
        expect(nextLogState(STATES.loading_older, fwd)).toMatchObject({ kind: 'loading_older', lastSeq: 130, oldestSeq: 50 });
        expect(nextLogState(STATES.anchored, { ...fwd, maxSeq: null })).toMatchObject({ lastSeq: 100 });
    });
    it('an older page moves the backward anchor to the lowest of rows and reader cursor; no progress ends hasMoreOlder (#4)', () => {
        const older = (minSeq: number | null, scannedTo: number | null, hasMore: boolean): LogEvent =>
            ({ type: 'page_applied', gen: G, page: 'older', minSeq, maxSeq: null, scannedTo, hasMore });
        expect(nextLogState(STATES.loading_older, older(30, 25, true))).toEqual({ kind: 'anchored', gen: G, lastSeq: 100, oldestSeq: 25, hasMoreOlder: true });
        expect(nextLogState(STATES.loading_older, older(null, 20, true))).toMatchObject({ oldestSeq: 20, hasMoreOlder: true });
        expect(nextLogState(STATES.loading_older, older(null, null, true))).toMatchObject({ oldestSeq: 50, hasMoreOlder: false });
        expect(nextLogState(STATES.loading_older, older(30, null, false))).toMatchObject({ oldestSeq: 30, hasMoreOlder: false });
    });
    it('older loading is refused at seq 1, with no anchor, or with nothing more', () => {
        expect(nextLogState({ ...ANCHORED, oldestSeq: 1 }, EVENTS.older_started).kind).toBe('anchored');
        expect(nextLogState({ ...ANCHORED, oldestSeq: null }, EVENTS.older_started).kind).toBe('anchored');
        expect(nextLogState({ ...ANCHORED, hasMoreOlder: false }, EVENTS.older_started).kind).toBe('anchored');
    });
});

describe('sessionLogMachine: eviction', () => {
    it('an evicted session off screen is skipped by a fetch; on screen it re-anchors (#2)', () => {
        const off = nextLogState(STATES.evicted, { type: 'fetch_started', gen: G, viewing: false });
        expect(off).toBe(STATES.evicted);
        expect(fetchBranchOf(off)).toBe('skip');
        const on = nextLogState(STATES.evicted, { type: 'fetch_started', gen: G, viewing: true });
        expect(fetchBranchOf(on)).toBe('reanchor');
    });
    it('a send that re-creates an evicted store drops the cursors so the next fetch anchors like a cold open (#12)', () => {
        const s = nextLogState(STATES.evicted, { type: 'recreated', gen: 9 });
        expect(s).toEqual({ kind: 'cold', gen: 9 });
        expect(fetchBranchOf(nextLogState(s, { type: 'fetch_started', gen: 9, viewing: true }))).toBe('anchor');
    });
});

describe('SessionLogs: generations', () => {
    it('a forgotten session makes every token stale, and a re-listed one never revalidates an old fetch (#406)', () => {
        const logs = new SessionLogs();
        const gen = logs.gen('A');
        logs.forget('A');
        expect(logs.isStale('A', gen)).toBe(true);
        const again = logs.gen('A');           // listed again: a fresh entry
        expect(again).not.toBe(gen);
        expect(logs.isStale('A', gen)).toBe(true);
        logs.forget('A');
        expect(logs.isStale('A', gen)).toBe(true);
    });
    it('a reset bumps the generation and a fetch captured before it cannot commit (#407)', () => {
        const logs = new SessionLogs();
        logs.send('A', { type: 'fetch_started', gen: logs.gen('A'), viewing: true });
        const captured = logs.gen('A');
        logs.reset('A');
        expect(logs.isStale('A', captured)).toBe(true);
        expect(logs.send('A', { type: 'page_applied', gen: captured, page: 'anchor', minSeq: 1, maxSeq: 5, scannedTo: 1, hasMore: false }).kind).toBe('cold');
        expect(logs.lastSeq('A')).toBeUndefined();
    });
    it('exposes the cursors only where they mean something', () => {
        const logs = new SessionLogs();
        const g = logs.gen('A');
        logs.send('A', { type: 'fetch_started', gen: g, viewing: true });
        logs.send('A', { type: 'page_applied', gen: g, page: 'anchor', minSeq: 10, maxSeq: 20, scannedTo: 8, hasMore: true });
        expect(logs.lastSeq('A')).toBe(20);
        expect(logs.oldestSeq('A')).toBe(8);
        logs.send('A', { type: 'evicted' });
        expect(logs.lastSeq('A')).toBe(20);
        expect(logs.oldestSeq('A')).toBeUndefined();
        logs.clear();
        expect(logs.lastSeq('A')).toBeUndefined();
    });
});
