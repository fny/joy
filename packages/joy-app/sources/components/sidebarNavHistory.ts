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
 * Now a `popstate` (browser back/forward/gesture) is inferred by matching the
 * new pathname against the neighbours of the cursor, and a change to the
 * pathname already under the cursor (mount, replace-in-place) is a no-op.
 */

export type NavDirection = 'back' | 'forward' | 'pop' | null;

export interface NavHistory {
    stack: string[];
    cursor: number;
}

export function createNavHistory(pathname: string): NavHistory {
    return { stack: [pathname], cursor: 0 };
}

export function canNavBack(h: NavHistory): boolean {
    return h.cursor > 0;
}

export function canNavForward(h: NavHistory): boolean {
    return h.cursor < h.stack.length - 1;
}

export function applyNavPathname(h: NavHistory, pathname: string, direction: NavDirection): NavHistory {
    // Same entry (initial mount, replace to an identical path): nothing moved.
    if (h.stack[h.cursor] === pathname) return h;

    const prev = h.cursor - 1;
    const next = h.cursor + 1;
    const matchesPrev = prev >= 0 && h.stack[prev] === pathname;
    const matchesNext = next < h.stack.length && h.stack[next] === pathname;

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

    const stack = h.stack.slice(0, h.cursor + 1);
    stack.push(pathname);
    return { stack, cursor: stack.length - 1 };
}
