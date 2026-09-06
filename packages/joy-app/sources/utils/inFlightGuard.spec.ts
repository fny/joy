import { describe, it, expect } from 'vitest';
import { createInFlightGuard } from './inFlightGuard';

const defer = <T>() => {
    let resolve!: (v: T) => void; let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
};

describe('inFlightGuard — one terminal operation at a time', () => {
    it('a second operation issued while the first is pending is refused without starting', async () => {
        const g = createInFlightGuard();
        const first = defer<string>();
        let secondStarted = false;
        const p1 = g.run(() => first.promise);
        expect(g.busy).toBe(true);
        const r2 = await g.run(async () => { secondStarted = true; return 'B'; });
        expect(r2).toBeNull();
        expect(secondStarted).toBe(false);
        first.resolve('A');
        expect(await p1).toBe('A');
        expect(g.busy).toBe(false);
    });

    it('the guard is held across a chained follow-up (text, THEN Enter) — not just the first step', async () => {
        const g = createInFlightGuard();
        const order: string[] = [];
        const text = defer<void>(); const enter = defer<void>();
        const op = g.run(async () => {
            order.push('A text'); await text.promise;
            order.push('A enter'); await enter.promise;
            return true;
        });
        text.resolve();
        await Promise.resolve();
        // Between A's text and A's Enter, B must not get in.
        expect(await g.run(async () => { order.push('B text'); return true; })).toBeNull();
        enter.resolve();
        expect(await op).toBe(true);
        expect(order).toEqual(['A text', 'A enter']);
    });

    it('same-tick double submit (keyboard Enter + button) admits exactly one', async () => {
        const g = createInFlightGuard();
        let runs = 0;
        const slow = () => new Promise<number>(r => setTimeout(() => r(++runs), 5));
        const [a, b, c] = await Promise.all([g.run(slow), g.run(slow), g.run(slow)]);
        expect([a, b, c].filter(x => x !== null)).toHaveLength(1);
        expect(runs).toBe(1);
    });

    it('a failed operation releases the guard', async () => {
        const g = createInFlightGuard();
        await expect(g.run(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
        expect(g.busy).toBe(false);
        expect(await g.run(async () => 'ok')).toBe('ok');
    });
});
