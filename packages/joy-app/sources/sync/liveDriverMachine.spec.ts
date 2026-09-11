import { describe, it, expect } from 'vitest';
import {
    nextLiveDriver, initialLiveDriver, indicatorOf, reconnectDelayMs,
    RECONNECT_MAX_MS, ERROR_AFTER_ATTEMPTS,
    type LiveDriverState, type LiveDriverEvent, type LiveConn,
} from './liveDriverMachine';

type Kind = LiveConn['kind'];
type Type = LiveDriverEvent['type'];
const POLL = 2_500;

const at = (conn: LiveConn, extra: Partial<LiveDriverState> = {}): LiveDriverState =>
    ({ conn, nextGen: 5, lastOkAt: 0, lastFailAt: 0, ...extra });

const STATES: Record<Kind, LiveDriverState> = {
    stopped: at({ kind: 'stopped' }),
    connecting: at({ kind: 'connecting', gen: 3, attempt: 1 }),
    streaming: at({ kind: 'streaming', gen: 3 }),
    polling_reconnect: at({ kind: 'polling_reconnect', gen: 3, attempt: 2, retryAt: 10_000 }),
};
// Events name the CURRENT generation (3); the stale variants are tested below.
const EVENTS: Record<Type, LiveDriverEvent> = {
    start: { type: 'start' },
    stop: { type: 'stop' },
    hello: { type: 'hello', gen: 3, now: 20_000 },
    close: { type: 'close', gen: 3, now: 20_000 },
    retry_due: { type: 'retry_due', gen: 3, now: 20_000 },
    read_ok: { type: 'read_ok', now: 20_000 },
    read_failed: { type: 'read_failed', now: 20_000 },
    poke: { type: 'poke' },
};

const EXPECTED: Record<`${Kind}+${Type}`, Kind> = {
    'stopped+start': 'connecting', 'stopped+stop': 'stopped', 'stopped+hello': 'stopped', 'stopped+close': 'stopped',
    'stopped+retry_due': 'stopped', 'stopped+read_ok': 'stopped', 'stopped+read_failed': 'stopped', 'stopped+poke': 'stopped',
    'connecting+start': 'connecting', 'connecting+stop': 'stopped', 'connecting+hello': 'streaming', 'connecting+close': 'polling_reconnect',
    'connecting+retry_due': 'connecting', 'connecting+read_ok': 'connecting', 'connecting+read_failed': 'connecting', 'connecting+poke': 'connecting',
    'streaming+start': 'streaming', 'streaming+stop': 'stopped', 'streaming+hello': 'streaming', 'streaming+close': 'polling_reconnect',
    'streaming+retry_due': 'streaming', 'streaming+read_ok': 'streaming', 'streaming+read_failed': 'streaming', 'streaming+poke': 'streaming',
    'polling_reconnect+start': 'polling_reconnect', 'polling_reconnect+stop': 'stopped', 'polling_reconnect+hello': 'polling_reconnect',
    'polling_reconnect+close': 'polling_reconnect', 'polling_reconnect+retry_due': 'connecting', 'polling_reconnect+read_ok': 'polling_reconnect',
    'polling_reconnect+read_failed': 'polling_reconnect', 'polling_reconnect+poke': 'polling_reconnect',
};

describe('liveDriverMachine: the transition table is total', () => {
    for (const [kind, s] of Object.entries(STATES) as [Kind, LiveDriverState][]) {
        for (const [type, ev] of Object.entries(EVENTS) as [Type, LiveDriverEvent][]) {
            it(`${kind} + ${type} → ${EXPECTED[`${kind}+${type}`] ?? 'MISSING'}`, () => {
                const want = EXPECTED[`${kind}+${type}`];
                expect(want, `no expectation for ${kind}+${type}`).toBeDefined();
                expect(nextLiveDriver(s, ev).conn.kind).toBe(want);
            });
        }
    }
});

describe('liveDriverMachine: generations (#408)', () => {
    it('a stop/start inside the reconnect window: the old timer cannot open a second stream', () => {
        let s = nextLiveDriver(initialLiveDriver(), { type: 'start' });          // gen 1
        s = nextLiveDriver(s, { type: 'close', gen: 1, now: 0 });                 // reconnect armed for gen 1
        s = nextLiveDriver(s, { type: 'stop' });
        s = nextLiveDriver(s, { type: 'start' });                                 // gen 2, connecting
        const before = s;
        s = nextLiveDriver(s, { type: 'retry_due', gen: 1, now: 99_999 });      // the stale timer fires
        expect(s).toBe(before);                                                    // ignored: nothing to open
        expect(s.conn).toEqual({ kind: 'connecting', gen: 2, attempt: 1 });
    });
    it('a hello or close from a retired stream changes nothing', () => {
        const s = at({ kind: 'connecting', gen: 3, attempt: 1 });
        expect(nextLiveDriver(s, { type: 'hello', gen: 2, now: 1 })).toBe(s);
        expect(nextLiveDriver(s, { type: 'close', gen: 2, now: 1 })).toBe(s);
    });
    it('every attempt mints a new generation; generations never repeat', () => {
        let s = nextLiveDriver(initialLiveDriver(), { type: 'start' });
        const gens = [s.conn.kind === 'connecting' ? s.conn.gen : -1];
        for (let i = 0; i < 4; i++) {
            const gen = (s.conn as { gen: number }).gen;
            s = nextLiveDriver(s, { type: 'close', gen, now: i * 100_000 });
            s = nextLiveDriver(s, { type: 'retry_due', gen, now: i * 100_000 + RECONNECT_MAX_MS });
            gens.push((s.conn as { gen: number }).gen);
        }
        expect(new Set(gens).size).toBe(gens.length);
    });
});

describe('liveDriverMachine: backoff', () => {
    it('doubles from 3 s to a 30 s cap and resets once a stream says hello', () => {
        expect(reconnectDelayMs(1)).toBe(3_000);
        expect(reconnectDelayMs(2)).toBe(6_000);
        expect(reconnectDelayMs(5)).toBe(RECONNECT_MAX_MS);
        let s = nextLiveDriver(initialLiveDriver(), { type: 'start' });
        s = nextLiveDriver(s, { type: 'close', gen: 1, now: 0 });
        expect(s.conn).toMatchObject({ kind: 'polling_reconnect', attempt: 1, retryAt: 3_000 });
        expect(nextLiveDriver(s, { type: 'retry_due', gen: 1, now: 2_999 })).toBe(s); // not yet
        s = nextLiveDriver(s, { type: 'retry_due', gen: 1, now: 3_000 });
        expect(s.conn).toMatchObject({ kind: 'connecting', gen: 2, attempt: 2 });
        s = nextLiveDriver(s, { type: 'close', gen: 2, now: 3_000 });
        expect(s.conn).toMatchObject({ kind: 'polling_reconnect', attempt: 2, retryAt: 9_000 });
        s = nextLiveDriver(s, { type: 'retry_due', gen: 2, now: 9_000 });
        s = nextLiveDriver(s, { type: 'hello', gen: 3, now: 9_100 });
        expect(s.conn).toEqual({ kind: 'streaming', gen: 3 });
        s = nextLiveDriver(s, { type: 'close', gen: 3, now: 50_000 });
        expect(s.conn).toMatchObject({ attempt: 1, retryAt: 53_000 });
    });
});

describe('liveDriverMachine: one indicator', () => {
    it('stopped is disconnected; a cold start is connecting (#11); a recent read is connected whatever the stream does', () => {
        expect(indicatorOf(initialLiveDriver(), 0, POLL)).toBe('disconnected');
        const started = nextLiveDriver(initialLiveDriver(), { type: 'start' });
        expect(indicatorOf(started, 0, POLL)).toBe('connecting');
        // Native: the stream never opens, the poll carries everything.
        let s = nextLiveDriver(started, { type: 'close', gen: 1, now: 0 });
        s = nextLiveDriver(s, { type: 'read_ok', now: 1_000 });
        expect(indicatorOf(s, 2_000, POLL)).toBe('connected');
    });
    it('three polls without a good read AND a failure since = disconnected; a quiet gap with no failure keeps connected', () => {
        let s = nextLiveDriver(initialLiveDriver(), { type: 'start' });
        s = nextLiveDriver(s, { type: 'read_ok', now: 1 });
        expect(indicatorOf(s, 3 * POLL + 2, POLL)).toBe('connected');   // backgrounded, nothing failed
        s = nextLiveDriver(s, { type: 'read_failed', now: 100 });
        expect(indicatorOf(s, 3 * POLL, POLL)).toBe('connected');       // one failure is noise
        expect(indicatorOf(s, 3 * POLL + 2, POLL)).toBe('disconnected');
    });
    it('error: the stream has failed repeatedly on top of failing reads', () => {
        let s = nextLiveDriver(initialLiveDriver(), { type: 'start' });
        s = nextLiveDriver(s, { type: 'read_ok', now: 0 });
        s = nextLiveDriver(s, { type: 'read_failed', now: 1 });
        let now = 1;
        for (let i = 0; i < ERROR_AFTER_ATTEMPTS; i++) {
            const gen = (s.conn as { gen: number }).gen;
            s = nextLiveDriver(s, { type: 'close', gen, now });
            now += RECONNECT_MAX_MS;
            if (i < ERROR_AFTER_ATTEMPTS - 1) s = nextLiveDriver(s, { type: 'retry_due', gen, now });
        }
        expect(s.conn).toMatchObject({ kind: 'polling_reconnect', attempt: ERROR_AFTER_ATTEMPTS });
        expect(indicatorOf(s, now, POLL)).toBe('error');
        // One good read clears it.
        s = nextLiveDriver(s, { type: 'read_ok', now });
        expect(indicatorOf(s, now, POLL)).toBe('connected');
    });
    it('reads in the stopped state are not counted', () => {
        const s = nextLiveDriver(initialLiveDriver(), { type: 'read_ok', now: 5 });
        expect(s.lastOkAt).toBe(0);
    });
});
