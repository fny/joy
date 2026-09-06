/**
 * A cancellation scope for work that must not outlive its owner: timers,
 * animation loops, retry workers, an in-flight request. One `cancel()` clears
 * every timer started through the scope, aborts its `signal`, and runs the
 * cleanups registered with `defer` (newest first). After cancel the scope is
 * inert: `timeout` schedules nothing and `defer` runs the cleanup at once.
 *
 *     // effect-local
 *     React.useEffect(() => {
 *         const scope = createScope();
 *         scope.timeout(tick, 1500);
 *         scope.defer(() => loop.stop());
 *         return () => scope.cancel();
 *     }, []);
 *
 *     // component-local (cancelled on unmount)
 *     const scope = useScope();
 *     scope.timeout(() => Modal.alert(...), 1500);
 */
import * as React from 'react';

export interface Scope {
    readonly cancelled: boolean;
    /** Aborted on cancel — pass to fetch and other AbortSignal consumers. */
    readonly signal: AbortSignal;
    /** setTimeout that is cleared on cancel. Returns a function that clears it early. */
    timeout(fn: () => void, ms: number): () => void;
    /** Register a cleanup to run on cancel. Runs immediately if already cancelled. */
    defer(cleanup: () => void): void;
    cancel(): void;
}

export function createScope(): Scope {
    const controller = new AbortController();
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const cleanups: (() => void)[] = [];
    let cancelled = false;

    const runSafely = (fn: () => void) => {
        try { fn(); } catch (e) { console.error('[scope] cleanup threw:', e); }
    };

    return {
        get cancelled() { return cancelled; },
        get signal() { return controller.signal; },
        timeout(fn, ms) {
            if (cancelled) return () => {};
            const handle = setTimeout(() => {
                timers.delete(handle);
                if (!cancelled) fn();
            }, ms);
            timers.add(handle);
            return () => { clearTimeout(handle); timers.delete(handle); };
        },
        defer(cleanup) {
            if (cancelled) { runSafely(cleanup); return; }
            cleanups.push(cleanup);
        },
        cancel() {
            if (cancelled) return;
            cancelled = true;
            for (const handle of timers) clearTimeout(handle);
            timers.clear();
            controller.abort();
            while (cleanups.length > 0) runSafely(cleanups.pop()!);
        },
    };
}

/** A scope owned by the component instance, cancelled when it unmounts. */
export function useScope(): Scope {
    // A stable facade over a replaceable inner scope: React StrictMode (and
    // Fast Refresh) run the effect cleanup and then set up again on the SAME
    // component instance, so a scope cancelled by that cleanup must be
    // replaced, not kept — otherwise every later timeout is a no-op (Astra
    // on d53685b4).
    const inner = React.useRef<Scope | null>(null);
    if (inner.current === null || inner.current.cancelled) inner.current = createScope();
    React.useEffect(() => {
        if (inner.current === null || inner.current.cancelled) inner.current = createScope();
        const s = inner.current;
        return () => s.cancel();
    }, []);
    const facade = React.useMemo<Scope>(() => ({
        get cancelled() { return inner.current?.cancelled ?? true; },
        get signal() { return (inner.current ?? createScope()).signal; },
        timeout: (fn, ms) => (inner.current ?? createScope()).timeout(fn, ms),
        defer: (cleanup) => (inner.current ?? createScope()).defer(cleanup),
        cancel: () => { inner.current?.cancel(); },
    }), []);
    return facade;
}
