export interface DebounceOptions<T> {
    delay: number;
    immediateCount?: number;
    reducer?: (previous: T, current: T) => T;
}

/**
 * Shared trailing-edge state. `fire` takes the pending args and clears the
 * pending state and timer reference BEFORE invoking the callback: a callback
 * that synchronously queues another update through the same debouncer must
 * see a clean slate, otherwise the old timer's tail wiped the newly queued
 * args and timer and that update was lost (#429).
 */
function createTrailing<T>(fn: (args: T) => void, delay: number, reducer?: (previous: T, current: T) => T) {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    // "Is a call pending" is tracked apart from its argument: `null` used to
    // double as the no-pending-call sentinel, so a nullable T queued as null
    // (a state-clearing update) was never delivered, not even on flush (#428).
    let pending = false;
    let pendingArgs: T | undefined = undefined;

    const clearTimer = () => {
        if (timeoutId) {
            clearTimeout(timeoutId);
            timeoutId = null;
        }
    };

    const fire = () => {
        clearTimer();
        if (!pending) return;
        const args = pendingArgs as T;
        pending = false;
        pendingArgs = undefined;
        fn(args);
    };

    return {
        queue(args: T): void {
            pendingArgs = pending && reducer ? reducer(pendingArgs as T, args) : args;
            pending = true;
            clearTimer();
            timeoutId = setTimeout(fire, delay);
        },
        cancel(): void {
            clearTimer();
            pending = false;
            pendingArgs = undefined;
        },
        flush: fire,
    };
}

export function createCustomDebounce<T>(
    fn: (args: T) => void,
    options: DebounceOptions<T>
): (args: T) => void {
    const { delay, immediateCount = 2, reducer } = options;

    let callCount = 0;
    const trailing = createTrailing(fn, delay, reducer);

    return function debouncedFunction(args: T): void {
        // First few calls execute immediately
        if (callCount < immediateCount) {
            callCount++;
            fn(args);
            return;
        }

        // After immediate calls, apply debouncing
        trailing.queue(args);
    };
}

export function createAdvancedDebounce<T>(
    fn: (args: T) => void,
    options: DebounceOptions<T>
): {
    debounced: (args: T) => void;
    cancel: () => void;
    reset: () => void;
    flush: () => void;
} {
    const { delay, immediateCount = 2, reducer } = options;

    let callCount = 0;
    const trailing = createTrailing(fn, delay, reducer);

    const cancel = () => trailing.cancel();

    const reset = () => {
        cancel();
        callCount = 0;
    };

    const flush = () => trailing.flush();

    const debounced = function(args: T): void {
        // First few calls execute immediately
        if (callCount < immediateCount) {
            callCount++;
            fn(args);
            return;
        }

        // After immediate calls, apply debouncing
        trailing.queue(args);
    };

    return { debounced, cancel, reset, flush };
}
