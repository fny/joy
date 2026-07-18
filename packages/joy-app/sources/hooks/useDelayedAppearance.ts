import * as React from 'react';

/**
 * Gates items behind a minimum age: an item only becomes visible once it has
 * been continuously present for `delayMs`. Age is measured from when THIS
 * device first saw the item — not from any daemon/server timestamp — so clock
 * skew between machine and device can neither defeat nor inflate the gate.
 *
 * Why it exists (JoyQueueStrip): every app send transits the daemon's durable
 * dispatch queue for ~a second even when the agent is idle (enqueue →
 * joy__queue metadata round trip → drain tick → dispatch), and rendering that
 * in-flight state flashed the user's own message as "queued" on every send.
 * Anything still pending after the gate is genuinely held (busy agent, stuck
 * dispatch) and appears. `bypass` (e.g. queue paused — a real fault state)
 * shows everything immediately.
 */
export function useDelayedAppearance<T extends { id: string }>(
    items: T[],
    delayMs: number,
    bypass: boolean,
): T[] {
    const firstSeen = React.useRef(new Map<string, number>());
    const [, bump] = React.useReducer((n: number) => n + 1, 0);

    const now = Date.now();
    const present = new Set(items.map((i) => i.id));
    for (const id of Array.from(firstSeen.current.keys())) {
        if (!present.has(id)) firstSeen.current.delete(id);
    }
    for (const i of items) {
        if (!firstSeen.current.has(i.id)) firstSeen.current.set(i.id, now);
    }

    const immature = bypass
        ? []
        : items.filter((i) => now - (firstSeen.current.get(i.id) ?? now) < delayMs);

    // Re-arm a wake-up for the oldest still-hidden item crossing the gate.
    // Deliberately no dep array: presence can change on any render and a
    // setTimeout is cheap to re-arm; without the wake-up a maturing item
    // would stay hidden until some unrelated re-render.
    React.useEffect(() => {
        if (immature.length === 0) return;
        const oldest = Math.min(...immature.map((i) => firstSeen.current.get(i.id) ?? now));
        const timer = setTimeout(bump, Math.max(0, delayMs - (Date.now() - oldest)) + 15);
        return () => clearTimeout(timer);
    });

    if (bypass || immature.length === 0) return items;
    return items.filter((i) => now - (firstSeen.current.get(i.id) ?? now) >= delayMs);
}
