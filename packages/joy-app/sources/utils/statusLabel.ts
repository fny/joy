/**
 * The words for a session's status — ONE implementation (#652 follow-on).
 *
 * sessionFacts.ts settled which state wins; this settles what it says. The
 * session header (useSessionStatus) and the sidebar row (SessionsList) each had
 * their own chain, and the sidebar's carried a comment recording what happens
 * when they drift: "tasks/compacting/retrying previously fell through to
 * 'online' here while the dot showed the state color — sidebar text contradicted
 * the session." A new state reintroduces that bug in whichever copy forgets it.
 *
 * The background suffix was duplicated the same way: withBg in the header, an
 * open-coded copy in the sidebar. Both are here now.
 */

import { t } from '@/text';
import type { BlockedKind, SessionFacts, SessionState } from '@/sync/sessionFacts';

export interface StatusWords {
    /** The randomised "brewing…" line. Passed in so this module stays pure. */
    vibing: string;
    /** Preformatted "last seen …", which needs the caller's clock and locale. */
    lastSeen: string;
    /** The clock, for durations; defaults to Date.now(). Injectable for tests. */
    now?: number;
}

/** Names the prompt holding the pane, so a blocked row never falls through to "online". */
export function blockedLabel(kind: BlockedKind | null | undefined): string {
    switch (kind) {
        case 'login': return t('status.signInRequired');
        case 'approval': return t('status.approvalRequired');
        default: return t('status.waitingInTerminal');
    }
}

/** What the winning state says, before any background suffix. */
export function statusHeadline(state: SessionState, facts: SessionFacts, words: StatusWords): string {
    switch (state) {
        case 'detached': return t('status.detached');
        case 'disconnected': return words.lastSeen;
        case 'blocked': return blockedLabel(facts.blocked?.kind);
        case 'retrying': return t('status.retrying', facts.retry ?? { attempt: 0, total: 0 });
        case 'compacting': return t('status.compacting');
        case 'stalled': {
            const since = facts.stalled?.since ?? (words.now ?? Date.now());
            return t('status.stalled', { minutes: Math.max(1, Math.round(((words.now ?? Date.now()) - since) / 60_000)) });
        }
        case 'permission_required': return t('status.permissionRequired');
        case 'thinking': return words.vibing;
        case 'agents': return t('status.agentsRunning', facts.agents ?? { done: 0, total: 0 });
        case 'tasks': return t('status.tasksCompleted', facts.tasks ?? { done: 0, total: 0 });
        case 'waiting': return t('status.online');
        case 'unread': return t('status.unread');
    }
}

/**
 * Work running BESIDE the winning state, as text.
 *
 * This suffix is the badge's lossiness showing through: agents, tasks and
 * long-running processes are concurrent with whatever won, so a one-state answer
 * has to hand them back in the string. Skipped for the offline states, whose
 * metadata is a snapshot of a dead session rather than live work, and for the
 * count that is already the headline.
 */
export function backgroundSuffixParts(state: SessionState, facts: SessionFacts): string[] {
    if (state === 'disconnected' || state === 'detached') return [];
    const parts: string[] = [];
    if (facts.agents && state !== 'agents') parts.push(t('status.agentsRunning', facts.agents));
    if (facts.tasks && state !== 'tasks') parts.push(t('status.tasksCompleted', facts.tasks));
    if (facts.longRunning > 0) parts.push(t('status.backgroundProcesses', { count: facts.longRunning }));
    return parts;
}

/** Headline plus suffix, joined the way the two call sites both did. */
export function statusText(state: SessionState, facts: SessionFacts, words: StatusWords): string {
    const headline = statusHeadline(state, facts, words);
    const parts = backgroundSuffixParts(state, facts);
    if (parts.length === 0) return headline;
    // After a trailing ellipsis ("brewing…") a comma reads badly — join with a
    // plain space there; comma elsewhere ("ready, 3 processes").
    const sep = headline.endsWith('…') ? ' ' : ', ';
    return headline + sep + parts.join(', ');
}
