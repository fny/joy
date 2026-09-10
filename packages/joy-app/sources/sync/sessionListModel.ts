/**
 * Two additions to the session list, and nothing else: sessions you have
 * pinned, and machine sections you can collapse.
 *
 * An earlier version of this put a grouping-axis switcher, filter chips,
 * saved views and a count line into the sidebar. That was a different visual
 * language from the list it replaced, which is a cost the features did not
 * justify. This keeps the list exactly as it reads today — the active block,
 * plain section headers, the same rows — and changes only what it groups by.
 *
 * Two rules are worth stating because they are where the two features meet:
 *
 *   1. A session appears ONCE. A pinned session leaves its machine section;
 *      one session in two places is worse than either placement.
 *   2. A collapsed section still reports how many sessions are inside and
 *      whether any of them needs a human, so collapsing compresses the list
 *      without concealing the thing you would want to act on.
 */

/** The part of a session this model reads. Structural, so specs need no store. */
export interface ListSession {
    id: string;
    /** The status badge, already resolved by sessionFacts.statusState. */
    state: string;
    machineId?: string | null;
    activeAt?: number;
    createdAt?: number;
    /** In the active block at the top of the list. */
    active?: boolean;
    /** The project, as it is shown on the row — the pinned sort key. */
    project?: string | null;
}

/** How the pinned section is ordered. */
export type PinnedSort = 'project' | 'state';

/**
 * The four things a pinned session can be, in the order you want to deal with
 * them. This is deliberately coarser than stateUrgency, which ranks eleven
 * states for a collapsed header's single dot; here the ranking IS the reading
 * order, and four groups you can name beat eleven you cannot.
 *
 *   0  needs a decision  — yellow. It is stopped until you answer.
 *   1  done              — green. It finished and is waiting for you.
 *   2  working           — blue/teal/pink/purple/orange. It needs nothing.
 *   3  gone              — grey and red. Nothing is running behind it.
 *
 * Amber (stalled, retrying) sits with working rather than with needs-a-
 * decision: something is off, but nothing is asking you a question, and a
 * bucket that cries wolf stops meaning "answer me".
 */
const STATE_BUCKET: Record<string, number> = {
    permission_required: 0,
    blocked: 0,
    waiting: 1,
    thinking: 2,
    tasks: 2,
    agents: 2,
    compacting: 2,
    retrying: 2,
    stalled: 2,
    detached: 3,
    disconnected: 3,
};

/** Unknown states sort last rather than jumping the queue. */
export function pinnedStateRank(state: string): number {
    return STATE_BUCKET[state] ?? 3;
}

/**
 * Who goes where, before any grouping: the pinned section, the active block,
 * and everything left over.
 *
 * This is separated out because getting it wrong is invisible. The first cut
 * built the pinned section from the NON-ACTIVE sessions only — so pinning a
 * running session did nothing at all, and with "hide archived" on there was
 * nothing to pin from and the section never appeared. Pinning simply did not
 * work, and nothing failed.
 *
 * A pin outranks the active block: a pinned session appears in Pinned and
 * nowhere else, so it is always in the same place whatever it is doing. The
 * alternative — leaving it in the active block — means a pin moves your
 * session around depending on whether it happens to be running.
 */
export function partitionForList<T extends ListSession>(input: {
    sessions: T[];
    pinned: string[];
    /** "Hide archived": drop everything that is not in the active block. */
    hideInactive: boolean;
}): { pins: T[]; active: T[]; rest: T[]; archived: number } {
    const isPinned = new Set(input.pinned);
    const pins: T[] = [];
    const active: T[] = [];
    const rest: T[] = [];
    let archived = 0;
    for (const s of input.sessions) {
        if (isPinned.has(s.id)) { pins.push(s); continue; }
        if (s.active) { active.push(s); continue; }
        archived++;
        if (!input.hideInactive) rest.push(s);
    }
    // Counted whether or not they were kept: the caller needs to know they
    // exist in order to offer the toggle that brings them back.
    return { pins, active, rest, archived };
}

export interface ListSection<T extends ListSession = ListSession> {
    /** Stable across renders — the collapse key. 'pinned', else `m:<id>`. */
    key: string;
    kind: 'pinned' | 'machine';
    /** Machine id for the caller to resolve to a display name; null for pins. */
    machineId: string | null;
    sessions: T[];
    collapsed: boolean;
    /** The most urgent state inside, for a collapsed section's dot. */
    worstState: string | null;
}

/**
 * How much a state deserves attention. Only the ORDER matters: it decides
 * which state a collapsed header reports, so anything waiting on a human
 * outranks anything merely running.
 */
const URGENCY: Record<string, number> = {
    blocked: 100,
    permission_required: 95,
    detached: 80,
    stalled: 70,
    retrying: 60,
    compacting: 40,
    thinking: 30,
    agents: 25,
    tasks: 24,
    waiting: 10,
    disconnected: 1,
};

export function stateUrgency(state: string): number {
    return URGENCY[state] ?? 0;
}

export interface ListLayoutInput<T extends ListSession = ListSession> {
    /** Sessions to place — the caller has already excluded the active block. */
    sessions: T[];
    pinned: string[];
    /** Section keys the user has collapsed. */
    collapsed: string[];
    /** Machine ids in the order the caller wants their sections to appear. */
    machineOrder?: string[];
    /** Pinned order. Default 'project'. */
    pinnedSort?: PinnedSort;
}

/**
 * Pins are ordered by PROJECT, not by recency.
 *
 * Every other section is newest-first, because you are scanning for what just
 * happened. A pinned list is the opposite: you put things in it so you could
 * find them again, and a list that reorders itself whenever an agent speaks is
 * one you have to re-read every time. Project name is stable and it is what
 * you remember the session by.
 *
 * Sorting by state gives that up on purpose — it answers "what needs me" — so
 * it still falls back to project name inside a bucket, which keeps the order
 * stable for everything that is in the same condition.
 */
function pinnedComparator<T extends ListSession>(sort: PinnedSort) {
    const byProject = (a: T, b: T) =>
        (a.project ?? '').localeCompare(b.project ?? '') || a.id.localeCompare(b.id);
    if (sort === 'state') {
        return (a: T, b: T) => (pinnedStateRank(a.state) - pinnedStateRank(b.state)) || byProject(a, b);
    }
    return byProject;
}

/**
 * Pinned first, then one section per machine.
 *
 * Machines are ordered by `machineOrder` when the caller supplies one (so the
 * sidebar can match whatever order it shows machines elsewhere), otherwise by
 * how many sessions each has, then by id — busiest first, so the machine you
 * are working on rises.
 */
export function buildListLayout<T extends ListSession>(input: ListLayoutInput<T>): ListSection<T>[] {
    const isCollapsed = (key: string) => input.collapsed.indexOf(key) !== -1;
    const sections: ListSection<T>[] = [];

    const worstOf = (items: T[]): string | null => {
        let worst: string | null = null;
        for (const s of items) {
            if (worst === null || stateUrgency(s.state) > stateUrgency(worst)) worst = s.state;
        }
        return worst;
    };
    // Newest first inside every section, matching the list's existing sort.
    const byRecency = (a: T, b: T) => (b.activeAt ?? b.createdAt ?? 0) - (a.activeAt ?? a.createdAt ?? 0);

    // Pinned: never collapsed. A pin is a statement that you want it in front
    // of you, so its header is a label rather than a control.
    const pins = input.sessions.filter((s) => input.pinned.indexOf(s.id) !== -1);
    if (pins.length > 0) {
        sections.push({
            key: 'pinned',
            kind: 'pinned',
            machineId: null,
            sessions: [...pins].sort(pinnedComparator(input.pinnedSort ?? 'project')),
            collapsed: false,
            worstState: worstOf(pins),
        });
    }

    // Everything else, by machine. A pinned session is already placed (rule 1).
    const buckets = new Map<string, T[]>();
    for (const s of input.sessions) {
        if (input.pinned.indexOf(s.id) !== -1) continue;
        const id = s.machineId ?? '';
        const bucket = buckets.get(id) ?? [];
        bucket.push(s);
        buckets.set(id, bucket);
    }

    const order = [...buckets.keys()].sort((a, b) => {
        if (input.machineOrder && input.machineOrder.length > 0) {
            const ia = input.machineOrder.indexOf(a);
            const ib = input.machineOrder.indexOf(b);
            if (ia !== ib) return (ia < 0 ? Number.MAX_SAFE_INTEGER : ia) - (ib < 0 ? Number.MAX_SAFE_INTEGER : ib);
        }
        const na = buckets.get(a)!.length, nb = buckets.get(b)!.length;
        if (na !== nb) return nb - na;
        return a.localeCompare(b);
    });

    for (const id of order) {
        const items = buckets.get(id)!;
        const key = `m:${id}`;
        sections.push({
            key,
            kind: 'machine',
            machineId: id || null,
            sessions: [...items].sort(byRecency),
            collapsed: isCollapsed(key),
            worstState: worstOf(items),
        });
    }

    return sections;
}
