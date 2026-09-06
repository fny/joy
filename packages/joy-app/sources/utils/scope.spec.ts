import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createScope } from './scope';

describe('scope — timers, cleanups and signals die with their owner', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it('a timeout started in the scope does not fire after cancel', () => {
        const scope = createScope();
        const fn = vi.fn();
        scope.timeout(fn, 1500);
        scope.cancel();
        vi.advanceTimersByTime(2000);
        expect(fn).not.toHaveBeenCalled();
        expect(scope.cancelled).toBe(true);
        expect(scope.signal.aborted).toBe(true);
    });

    it('a timeout fires normally while the scope lives, and can be cleared early', () => {
        const scope = createScope();
        const a = vi.fn();
        const b = vi.fn();
        scope.timeout(a, 100);
        const clearB = scope.timeout(b, 100);
        clearB();
        vi.advanceTimersByTime(100);
        expect(a).toHaveBeenCalledTimes(1);
        expect(b).not.toHaveBeenCalled();
    });

    it('deferred cleanups run once on cancel, newest first; a later defer runs at once', () => {
        const scope = createScope();
        const order: string[] = [];
        scope.defer(() => order.push('first'));
        scope.defer(() => order.push('second'));
        scope.cancel();
        scope.cancel();
        expect(order).toEqual(['second', 'first']);
        scope.defer(() => order.push('late'));
        expect(order).toEqual(['second', 'first', 'late']);
    });

    it('after cancel a timeout schedules nothing', () => {
        const scope = createScope();
        scope.cancel();
        const fn = vi.fn();
        scope.timeout(fn, 10);
        vi.advanceTimersByTime(10);
        expect(fn).not.toHaveBeenCalled();
    });

    it('a cleanup that throws does not stop the others', () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const scope = createScope();
        const ran = vi.fn();
        scope.defer(ran);
        scope.defer(() => { throw new Error('boom'); });
        scope.cancel();
        expect(ran).toHaveBeenCalledTimes(1);
    });
});
