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

import { STATUS_PALETTE } from '@/utils/statusPalette';
import type { SessionState } from './sessionFacts';

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
    /** Unread is a STATE now (`state === 'unread'`, green); this flag is the
     *  raw per-device fact the rows still read for the draft pencil. */
    hasUnread?: boolean;
    /** An automation run: 'running' while it works, 'failed' until dismissed. */
    automation?: 'failed' | 'running' | null;
}

/** How the pinned section is ordered. */
export type PinnedSort = 'project' | 'state';

/**
 * Order by the COLOUR the row is showing, top to bottom:
 *
 *   0  amber   — needs permission, or needs intervention
 *   1  green   — unread
 *   2  blue    — thinking, or otherwise working (these pulse)
 *   3  grey    — read and idle; you have already seen it
 *
 * Keyed on the dot's colour rather than on a private list of state names,
 * because the order has to be the one you can SEE. An earlier version ranked
 * eleven state names into four buckets nobody could read off the screen, and
 * put `waiting` in "done" while unread — the thing that actually turns a row
 * green — was not considered at all.
 *
 * STATUS_PALETTE is the authority for what colour a state is; this maps
 * colour → position, so a state that changes colour changes position with it
 * and nothing here has to be remembered. A palette colour with no entry here
 * fails the spec rather than silently sorting last.
 */
const COLOUR_RANK: Record<string, number> = {
    '#FFCC00': 0, // amber — permission_required, blocked (a login, a dialog): stopped until you answer
    '#34C759': 1, // green — unread: finished work you have not seen
    '#007AFF': 2, // active — thinking
    '#30B0C7': 2, // active — tasks
    '#FF2D95': 2, // active — agents
    '#AF52DE': 2, // active — compacting
    '#8E8E93': 3, // read — online and idle; you have already seen it
    '#FF9500': 4, // error — stalled, retrying
    '#FF3B30': 4, // error — detached: the agent is gone
    '#C7C7CC': 5, // offline
};

/**
 * The dot a row shows, by the same rule the rows themselves use: the state's
 * palette colour, unless the row is unread, which overrides to green.
 */
export function pinnedDotColour(state: string): string {
    return STATUS_PALETTE[state as SessionState]?.dotColor ?? '#C7C7CC';
}

/** Unknown colours sort last rather than jumping the queue. */
export function pinnedStateRank(state: string): number {
    return COLOUR_RANK[pinnedDotColour(state)] ?? 5;
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
}): { pins: T[]; active: T[]; rest: T[]; archived: number; automationsRunning: T[]; automationsFailed: T[] } {
    const isPinned = new Set(input.pinned);
    const pins: T[] = [];
    const active: T[] = [];
    const rest: T[] = [];
    const automationsRunning: T[] = [];
    const automationsFailed: T[] = [];
    let archived = 0;
    for (const s of input.sessions) {
        // Automation runs are placed FIRST, ahead of pins and the active
        // block, because a run appears in exactly ONE place: one that also
        // sat in the active block would be in the list twice while working,
        // which is the thing the pinned rule already refuses.
        if (s.automation === 'failed') { automationsFailed.push(s); continue; }
        if (s.automation === 'running') { automationsRunning.push(s); continue; }
        if (isPinned.has(s.id)) { pins.push(s); continue; }
        if (s.active) { active.push(s); continue; }
        archived++;
        if (!input.hideInactive) rest.push(s);
    }
    // `archived` is counted whether or not they were kept: the caller needs to
    // know they exist in order to offer the toggle that brings them back.
    return { pins, active, rest, archived, automationsRunning, automationsFailed };
}

export interface ListSection<T extends ListSession = ListSession> {
    /** Stable across renders — the collapse key. 'pinned', 'automations',
     *  'automation-failures', else `m:<id>`. */
    key: string;
    kind: 'pinned' | 'machine' | 'automations' | 'automation-failures';
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
    // The same order as the pinned section, top to bottom: amber, unread,
    // active, read, error, offline.
    blocked: 100,
    permission_required: 95,
    unread: 90,
    compacting: 40,
    thinking: 30,
    agents: 25,
    tasks: 24,
    waiting: 10,
    detached: 8,
    stalled: 7,
    retrying: 6,
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
    /** Pinned order. Default 'state'. */
    pinnedSort?: PinnedSort;
}

/**
 * Pins are ordered by STATE by default — what needs you, first.
 *
 * Neither option is recency, which is what every other section uses. You put
 * things in this list so you could find them again, and a list that reorders
 * itself whenever an agent speaks is one you have to re-read every time.
 *
 * State wins the default because a pinned session is one you are actually
 * waiting on: the top of the list should be the one that stopped for you. It
 * falls back to project name inside a bucket, so everything in the same
 * condition holds a stable order and the list only moves when a session's
 * colour actually changes.
 *
 * 'project' orders the whole list that way instead — nothing moves unless you
 * pin or unpin something, which is the right choice if you use the pinned
 * section as a fixed set of bookmarks rather than as a queue.
 */
function pinnedComparator<T extends ListSession>(sort: PinnedSort) {
    const byProject = (a: T, b: T) =>
        (a.project ?? '').localeCompare(b.project ?? '') || a.id.localeCompare(b.id);
    if (sort === 'state') {
        return (a: T, b: T) =>
            (pinnedStateRank(a.state) - pinnedStateRank(b.state)) || byProject(a, b);
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
        sessions: [...pins].sort(pinnedComparator(input.pinnedSort ?? 'state')),
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
