/**
 * Exponential backoff with full jitter, bounded between base and cap.
 * Returns delay in ms.
 */
export function backoffMs(attempt: number, base: number, cap: number): number {
    const exp = Math.min(cap, base * Math.pow(2, attempt));
    return Math.floor(Math.random() * exp);
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
        const t = setTimeout(resolve, ms);
        if (signal) {
            const onAbort = () => {
                clearTimeout(t);
                resolve();
            };
            if (signal.aborted) onAbort();
            else signal.addEventListener('abort', onAbort, { once: true });
        }
    });
}
