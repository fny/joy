/**
 * How the session list is organised: pins, custom views, grouping and filters
 * — as one model rather than four features that meet in a renderer.
 *
 * The list has had exactly one axis since it was written: time. Active
 * sessions in a block, then Today / Yesterday / N days ago. That is the least
 * useful axis for anything older than yesterday — "12 days ago" says nothing
 * about what is in it — so here time becomes the SORT and the grouping axis is
 * a choice: project (how you think about work), machine (which of three boxes)
 * or date (when you are looking for something you did rather than something
 * you own).
 *
 * The other three features collapse into one object. A filter is a query used
 * to REPLACE the list; a custom group is the same query used to SECTION it;
 * and Pinned is a group whose rule is "these particular sessions". So there is
 * one `SessionView` type with an optional rule and an optional hand-picked
 * membership, and pinning is the built-in view rather than a parallel
 * mechanism.
 *
 * Four rules keep them from becoming a puzzle where they meet, and they are
 * the reason this is a module and not a `useMemo`:
 *
 *   1. A session appears ONCE. Views are ordered and the first to claim a
 *      session takes it out of the derived grouping entirely — one session in
 *      two places is worse than either placement.
 *   2. Filters apply to views, and the view SAYS what it lost, rather than
 *      quietly shrinking.
 *   3. A collapsed section still reports its count and its worst state, so
 *      collapsing compresses and never conceals something waiting on you.
 *   4. The caller can always say how much is hidden — `shown` / `total`.
 */

export type GroupAxis = 'project' | 'machine' | 'date';
export type FilterKey = 'all' | 'needs' | 'working' | 'unread';

/** The part of a row this model reads. Structural so specs need no store. */
export interface ListSession {
    id: string;
    /** The status badge, already resolved by sessionFacts.statusState. */
    state: string;
    machineId?: string | null;
    path?: string | null;
    /** Harness flavour, for a view that scopes to one agent. */
    flavor?: string | null;
    hasUnread?: boolean;
    createdAt?: number;
    activeAt?: number;
}

/**
 * A saved view: a custom group and a saved filter are the same object, used
 * two ways. Every present rule field must match (AND), and `ids` is a further
 * predicate ORed on top — so a view can be "everything on fny, plus this one
 * straggler", which neither a pure rule nor pure hand-filing expresses.
 */
export interface SessionView {
    id: string;
    name: string;
    /** Hand-picked members. Pinned is exactly this and nothing else. */
    ids?: string[];
    machineId?: string | null;
    /** Matched as a prefix, so a view can scope to a directory tree. */
    path?: string | null;
    flavor?: string | null;
    filter?: FilterKey | null;
}

export interface ListSection<T extends ListSession = ListSession> {
    /** Stable across renders and axis changes — the collapse key. */
    key: string;
    title: string;
    kind: 'pinned' | 'view' | 'group';
    /** Members that survived the active filter, in display order. */
    sessions: T[];
    /** Members before the filter. */
    total: number;
    /** total − sessions.length, so the header can say what it lost (rule 2). */
    hiddenByFilter: number;
    collapsed: boolean;
    /** The most urgent state among the VISIBLE members (rule 3). */
    worstState: string | null;
}

export interface ListLayout<T extends ListSession = ListSession> {
    sections: ListSection<T>[];
    /** Sessions on screen, and in the list at all, for the "7 of 18" line. */
    shown: number;
    total: number;
}

/**
 * How much a state deserves attention. Only the ORDER matters — it decides
 * which state a collapsed header reports, so anything that wants a human
 * outranks anything that is merely running.
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

/** States that mean a human is holding the session up. */
export function needsAttention(s: ListSession): boolean {
    return s.state === 'blocked' || s.state === 'permission_required';
}

/** States that mean something is running right now. */
export function isWorking(s: ListSession): boolean {
    return s.state === 'thinking' || s.state === 'agents' || s.state === 'tasks'
        || s.state === 'compacting' || s.state === 'retrying';
}

export function matchesFilter(s: ListSession, filter: FilterKey): boolean {
    switch (filter) {
        case 'needs': return needsAttention(s);
        case 'working': return isWorking(s);
        case 'unread': return s.hasUnread === true;
        default: return true;
    }
}

/** Does this view claim this session? An empty view claims nothing. */
export function viewClaims(view: SessionView, s: ListSession): boolean {
    if (view.ids && view.ids.indexOf(s.id) !== -1) return true;
    const hasRule = !!(view.machineId || view.path || view.flavor || (view.filter && view.filter !== 'all'));
    if (!hasRule) return false;
    if (view.machineId && s.machineId !== view.machineId) return false;
    if (view.path && !(s.path ?? '').startsWith(view.path)) return false;
    if (view.flavor && (s.flavor ?? 'claude') !== view.flavor) return false;
    if (view.filter && view.filter !== 'all' && !matchesFilter(s, view.filter)) return false;
    return true;
}

/** Relative day bucket for the date axis. */
export function dayBucket(createdAt: number, now: number): string {
    const startOf = (ms: number) => {
        const d = new Date(ms);
        return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    };
    const days = Math.round((startOf(now) - startOf(createdAt)) / 86_400_000);
    if (days <= 0) return 'Today';
    if (days === 1) return 'Yesterday';
    if (days < 7) return `${days} days ago`;
    return 'Earlier';
}

/** The group a session falls into on the chosen axis, and its display name. */
export function groupOf(s: ListSession, axis: GroupAxis, now: number): { key: string; title: string } {
    if (axis === 'machine') {
        const id = s.machineId ?? 'unknown';
        return { key: `m:${id}`, title: id };
    }
    if (axis === 'date') {
        const bucket = dayBucket(s.createdAt ?? now, now);
        return { key: `d:${bucket}`, title: bucket };
    }
    const path = s.path ?? '';
    return { key: `p:${path}`, title: path ? (path.split(/[/\\]/).filter(Boolean).pop() ?? path) : 'No project' };
}

/** Date buckets read in time order; everything else by size then name. */
const DATE_ORDER = ['Today', 'Yesterday', 'Earlier'];
function dateRank(title: string): number {
    const fixed = DATE_ORDER.indexOf(title);
    if (fixed === 0) return 0;
    if (fixed === 1) return 1;
    if (fixed === 2) return 99;
    const n = parseInt(title, 10);
    return Number.isFinite(n) ? n : 98;
}

export interface ListLayoutInput<T extends ListSession = ListSession> {
    sessions: T[];
    /** Hand-picked pins — the built-in view, always first, never collapsed. */
    pinned: string[];
    /** Custom groups, in the order the user put them. */
    views: SessionView[];
    axis: GroupAxis;
    filter: FilterKey;
    /** Section keys the user has collapsed. */
    collapsed: string[];
    now?: number;
    /** Label for the pinned section (translated by the caller). */
    pinnedTitle?: string;
}

function sectionFrom<T extends ListSession>(
    key: string,
    title: string,
    kind: ListSection['kind'],
    members: T[],
    filter: FilterKey,
    collapsed: boolean,
): ListSection<T> {
    const visible = members.filter((s) => matchesFilter(s, filter));
    let worst: string | null = null;
    for (const s of visible) {
        if (worst === null || stateUrgency(s.state) > stateUrgency(worst)) worst = s.state;
    }
    return {
        key,
        title,
        kind,
        sessions: visible,
        total: members.length,
        hiddenByFilter: members.length - visible.length,
        collapsed,
        worstState: worst,
    };
}

/**
 * The whole list, sectioned. Sections with no visible member are dropped —
 * except a view that HAD members and lost them all to the filter, which stays
 * so it can report that (rule 2); an empty group would just be noise.
 */
export function buildListLayout<T extends ListSession>(input: ListLayoutInput<T>): ListLayout<T> {
    const now = input.now ?? Date.now();
    const isCollapsed = (key: string) => input.collapsed.indexOf(key) !== -1;
    const claimed = new Set<string>();
    const sections: ListSection<T>[] = [];

    // Pinned: the built-in view. Never collapsed — a pin is a statement that
    // you want it in front of you.
    const pins = input.sessions.filter((s) => input.pinned.indexOf(s.id) !== -1);
    pins.forEach((s) => claimed.add(s.id));
    if (pins.length > 0) {
        sections.push(sectionFrom('pinned', input.pinnedTitle ?? 'Pinned', 'pinned', pins, input.filter, false));
    }

    // Custom views, in order. First claim wins (rule 1).
    for (const view of input.views) {
        const members = input.sessions.filter((s) => !claimed.has(s.id) && viewClaims(view, s));
        members.forEach((s) => claimed.add(s.id));
        if (members.length === 0) continue;
        sections.push(sectionFrom(`v:${view.id}`, view.name, 'view', members, input.filter, isCollapsed(`v:${view.id}`)));
    }

    // Everything else, on the chosen axis.
    const buckets = new Map<string, { title: string; members: T[] }>();
    for (const s of input.sessions) {
        if (claimed.has(s.id)) continue;
        const g = groupOf(s, input.axis, now);
        const bucket = buckets.get(g.key) ?? { title: g.title, members: [] };
        bucket.members.push(s);
        buckets.set(g.key, bucket);
    }

    const groups: ListSection<T>[] = [];
    for (const [key, bucket] of buckets) {
        const section = sectionFrom(key, bucket.title, 'group', bucket.members, input.filter, isCollapsed(key));
        if (section.sessions.length === 0) continue; // an empty group is noise
        groups.push(section);
    }
    groups.sort((a, b) => {
        if (input.axis === 'date') return dateRank(a.title) - dateRank(b.title);
        // Busiest first, so the project you are working in rises to the top.
        if (a.sessions.length !== b.sessions.length) return b.sessions.length - a.sessions.length;
        return a.title.localeCompare(b.title);
    });
    sections.push(...groups);

    // Newest first inside every section — time is the sort, not the grouping.
    for (const section of sections) {
        section.sessions.sort((a, b) => (b.activeAt ?? b.createdAt ?? 0) - (a.activeAt ?? a.createdAt ?? 0));
    }

    let shown = 0;
    for (const section of sections) shown += section.sessions.length;
    return { sections, shown, total: input.sessions.length };
}
