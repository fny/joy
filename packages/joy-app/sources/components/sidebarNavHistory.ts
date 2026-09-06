/**
 * The sidebar's own back/forward history model (the browser History API does
 * not expose whether forward entries exist), pure so it can be tested.
 *
 * Before (#240): every pathname change that was not explicitly marked by the
 * sidebar's own buttons was appended as a NEW entry — so the browser Back
 * button (or a swipe) dropped the forward history and disabled Forward even
 * though the browser could still go forward; a replace to the same path was
 * counted twice; and the mount effect pushed the initial pathname on top of
 * the seed entry, enabling Back with nowhere to go.
 *
 * Entries are identified by the browser's OWN entry identity where one
 * exists: expo-router stamps `window.history.state.id` on every pushState
 * (a fresh id) and keeps it across replaceState, and the browser restores
 * it on popstate. Keying on that id makes a multi-entry Back (the history
 * menu, a long-press) land on the right entry with Forward intact, a
 * replace to a different pathname stay one entry, and two entries with the
 * same pathname (query-only changes) stay distinct. Neighbouring-pathname
 * inference remains only as the fallback for entries without an id.
 */

export type NavDirection = 'back' | 'forward' | 'pop' | null;

export interface NavEntry {
    /** Browser entry identity (history.state.id), or null when unknown. */
    key: string | null;
    pathname: string;
}

export interface NavHistory {
    stack: NavEntry[];
    cursor: number;
}

export function createNavHistory(pathname: string, key: string | null = null): NavHistory {
    return { stack: [{ key, pathname }], cursor: 0 };
}

export function canNavBack(h: NavHistory): boolean {
    return h.cursor > 0;
}

export function canNavForward(h: NavHistory): boolean {
    return h.cursor < h.stack.length - 1;
}

function push(h: NavHistory, entry: NavEntry): NavHistory {
    const stack = h.stack.slice(0, h.cursor + 1);
    stack.push(entry);
    return { stack, cursor: stack.length - 1 };
}

export function applyNavEntry(h: NavHistory, entry: NavEntry, direction: NavDirection): NavHistory {
    const current = h.stack[h.cursor];

    if (entry.key !== null) {
        if (current.key === entry.key) {
            // Same browser entry: a replaceState (possibly to another
            // pathname), or the mount effect re-reporting where we are.
            if (current.pathname === entry.pathname) return h;
            const stack = h.stack.slice();
            stack[h.cursor] = entry;
            return { stack, cursor: h.cursor };
        }
        // A known entry anywhere in the stack: the browser moved us there
        // (single or multi-step back/forward). The stack is untouched, so
        // Forward stays available.
        const index = h.stack.findIndex((e) => e.key === entry.key);
        if (index >= 0) return { ...h, cursor: index };
        // A brand-new entry: pushState. Anything ahead of the cursor is gone.
        if (current.key === null && current.pathname === entry.pathname) {
            // The seed entry learns its id from the first report.
            const stack = h.stack.slice();
            stack[h.cursor] = entry;
            return { stack, cursor: h.cursor };
        }
        return push(h, entry);
    }

    // No entry identity: fall back to inferring from neighbouring pathnames.
    if (current.pathname === entry.pathname) return h;

    const prev = h.cursor - 1;
    const next = h.cursor + 1;
    const matchesPrev = prev >= 0 && h.stack[prev].pathname === entry.pathname;
    const matchesNext = next < h.stack.length && h.stack[next].pathname === entry.pathname;

    if (direction === 'back' && matchesPrev) return { ...h, cursor: prev };
    if (direction === 'forward' && matchesNext) return { ...h, cursor: next };
    if (direction === 'pop') {
        // The browser moved us; it does not say which way. Prefer the
        // neighbour that matches — back first, since that is the common
        // gesture — and fall through to a push only when neither does
        // (a history entry created outside this app instance).
        if (matchesPrev) return { ...h, cursor: prev };
        if (matchesNext) return { ...h, cursor: next };
    }

    return push(h, entry);
}

/** Pathname-only form (no browser entry identity available). */
export function applyNavPathname(h: NavHistory, pathname: string, direction: NavDirection): NavHistory {
    return applyNavEntry(h, { key: null, pathname }, direction);
}
