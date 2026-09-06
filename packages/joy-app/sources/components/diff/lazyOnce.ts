/**
 * Memoize an async loader so concurrent callers share one attempt — but
 * FORGET a rejected attempt, so the next call tries again.
 *
 * The @pierre/diffs chunks used to be memoized as a bare promise: one failed
 * fetch (offline, chunk error) stayed cached for the life of the app, and
 * every web diff afterwards sat on the skeleton forever (#253).
 */
export function lazyOnce<T>(load: () => Promise<T>): () => Promise<T> {
    let pending: Promise<T> | null = null;
    return () => {
        if (!pending) {
            pending = load().catch((e) => {
                pending = null; // a rejection is not a result: the next caller retries
                throw e;
            });
        }
        return pending;
    };
}
