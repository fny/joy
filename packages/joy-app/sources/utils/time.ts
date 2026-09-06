export async function delay(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Delay before retry number `currentFailureCount` (1-based): ramps linearly
 * from `minDelay` at the first failure to `maxDelay` at `maxFailureCount`
 * failures, with the jitter drawn between `minDelay` and the ramped ceiling.
 * The ceiling used to be `Math.max(count, maxFailureCount)` — always the cap —
 * and the jitter started at 0, so every retry was a uniform 0..maxDelay from
 * the very first failure and the floor was never honoured (#109).
 */
export function exponentialBackoffDelay(currentFailureCount: number, minDelay: number, maxDelay: number, maxFailureCount: number) {
    const failures = Math.max(0, Math.min(currentFailureCount, maxFailureCount));
    const steps = Math.max(1, maxFailureCount);
    const ceiling = minDelay + ((maxDelay - minDelay) / steps) * failures;
    return Math.round(minDelay + Math.random() * Math.max(0, ceiling - minDelay));
}

export type BackoffFunc = <T>(callback: () => Promise<T>) => Promise<T>;

export interface BackoffOptions {
    onError?: (e: any, failuresCount: number) => void;
    minDelay?: number;
    maxDelay?: number;
    maxFailureCount?: number;
    /**
     * Give up (rethrow the last error) after this many failed attempts.
     * Unbounded by default — callers whose UI waits on the result (logout,
     * a settings screen) must set it so the promise always settles (#9).
     */
    maxAttempts?: number;
    /** Return false to rethrow immediately instead of retrying (e.g. a 4xx). */
    shouldRetry?: (e: any) => boolean;
}

export function createBackoff(opts?: BackoffOptions): BackoffFunc {
    return async <T>(callback: () => Promise<T>): Promise<T> => {
        let currentFailureCount = 0;
        let attempts = 0;
        const minDelay = opts && opts.minDelay !== undefined ? opts.minDelay : 250;
        const maxDelay = opts && opts.maxDelay !== undefined ? opts.maxDelay : 1000;
        const maxFailureCount = opts && opts.maxFailureCount !== undefined ? opts.maxFailureCount : 50;
        const maxAttempts = opts?.maxAttempts;
        while (true) {
            try {
                return await callback();
            } catch (e) {
                attempts++;
                if (currentFailureCount < maxFailureCount) {
                    currentFailureCount++;
                }
                if (opts && opts.onError) {
                    opts.onError(e, currentFailureCount);
                }
                if (opts?.shouldRetry && !opts.shouldRetry(e)) {
                    throw e;
                }
                if (maxAttempts !== undefined && attempts >= maxAttempts) {
                    throw e;
                }
                let waitForRequest = exponentialBackoffDelay(currentFailureCount, minDelay, maxDelay, maxFailureCount);
                await delay(waitForRequest);
            }
        }
    };
}

export let backoff = createBackoff({ onError: (e) => { console.warn(e); } });
