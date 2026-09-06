/**
 * Latest-wins request generations (the #91 pattern from AllFilesDiffView,
 * made reusable). Every async result that lands in state must answer "am I
 * still the request the UI is waiting for?" — a late or cancelled response
 * otherwise overwrites a newer one (another machine's environment, another
 * file's contents, a deleted token row restored).
 *
 *     const gen = nextGen(key);
 *     const data = await fetchSomething();
 *     if (!isLatest(key, gen)) return;   // superseded: drop it
 *     setState(data);
 *
 * `retire(key)` invalidates whatever is outstanding without starting a new
 * request (stop, unmount, "the world changed"). Generations only ever grow,
 * so a request from before a retire can never match a request minted after
 * it. `forget(key)` drops a key that will never be minted again (a
 * per-instance key at unmount) so the registry does not grow with mounts.
 */
import * as React from 'react';

const gens = new Map<string, number>();
let instanceCounter = 0;

/** Start a new request for `key`; everything older is now stale. */
export function nextGen(key: string): number {
    const g = (gens.get(key) ?? 0) + 1;
    gens.set(key, g);
    return g;
}

/** True while `gen` is the newest request for `key`. */
export function isLatest(key: string, gen: number): boolean {
    return gens.get(key) === gen;
}

/**
 * The current generation WITHOUT minting one — for a read that must not
 * supersede in-flight writes (a background poll) but must still be dropped
 * if anything newer happened while it ran.
 */
export function currentGen(key: string): number {
    return gens.get(key) ?? 0;
}

/** Invalidate every outstanding request for `key` without starting one. */
export function retire(key: string): void {
    nextGen(key);
}

/** Drop a key that will never be used again (per-instance keys at unmount). */
export function forget(key: string): void {
    gens.delete(key);
}

/** A unique key for a component instance, retired and forgotten on unmount. */
export function useLatestKey(prefix: string): string {
    const [key] = React.useState(() => `${prefix}#${++instanceCounter}`);
    React.useEffect(() => () => { retire(key); forget(key); }, [key]);
    return key;
}
