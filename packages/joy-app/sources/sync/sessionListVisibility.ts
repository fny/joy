// Dependency-free (type-only import) so it can be unit-tested without loading
// the store; the hook in hooks/useVisibleSessionListViewData.ts wraps it.
import type { SessionListViewItem } from './storage';
import { hiddenFromList } from './sessionFacts';
import type { SessionRowData } from './storage';

/**
 * Is this row a headless session that is currently keeping quiet?
 *
 * Guarded on `facts` being there at all: this filter runs over every row in
 * the sidebar, and a row that reached it without facts would throw and take
 * the whole list with it. A row we cannot ask is treated as ordinary, which
 * is the answer that shows it rather than hides it.
 */
function isQuietHeadless(session: SessionRowData | undefined): boolean {
    return !!session?.facts && hiddenFromList(session.facts);
}

/**
 * Pure half of the hook: the archive toggle + hide-archived filtering over the
 * grouped list. Trusts the grouping — every `session` item is history by
 * construction (active ones are inside the `active-sessions` item), and
 * SessionRowData.active is stamped from the SAME predicate the grouping used
 * (isSessionInActiveGroup), so a row can never be grouped as history and then
 * filtered out here as "active" (which showed date headers with nothing under
 * them).
 */
export function filterVisibleSessionListViewData(
    data: SessionListViewItem[],
    hideInactiveSessions: boolean,
    showHeadlessSessions = false,
): SessionListViewItem[] {
    const result: SessionListViewItem[] = [];
    let hasInactive = false;
    let hasHeadless = false;

    // `joy new --headless` sessions are in the built list; whether they are
    // SHOWN is this function's business. A headless session that is blocked or
    // waiting on a permission is never hidden — hiddenFromList says so — so
    // the toggle only ever affects the quiet ones.
    const headlessHidden = (item: SessionListViewItem): boolean => {
        if (item.type !== 'session') return false;
        if (!isQuietHeadless(item.session)) return false;
        hasHeadless = true;
        return !showHeadlessSessions;
    };

    // First pass: add active sessions group and check if inactive sessions exist
    for (const item of data) {
        if (item.type === 'active-sessions') {
            const sessions = item.sessions.filter((s) => {
                if (!isQuietHeadless(s)) return true;
                hasHeadless = true;
                return showHeadlessSessions;
            });
            // Pushed even when the filter emptied it: the store already emits
            // an empty active-sessions item and the list's contract keeps it.
            result.push({ ...item, sessions });
        } else if (item.type === 'session' && !item.session.active && !headlessHidden(item)) {
            hasInactive = true;
        }
    }

    // Insert archive toggle if there are inactive sessions
    if (hasInactive) {
        result.push({ type: 'archive-toggle', hidden: hideInactiveSessions });
    }
    // And a headless toggle, on the same rule: only when there is something to
    // reveal. Emitted even while they are shown, or there would be no way back.
    if (hasHeadless) {
        result.push({ type: 'headless-toggle', hidden: !showHeadlessSessions });
    }

    // If not hiding, add all remaining items (headers, project groups, inactive sessions)
    if (!hideInactiveSessions) {
        let pendingProjectGroup: SessionListViewItem | null = null;
        // The date header waits for a row too, for the same reason the project
        // group does. It used to be emitted on sight, which was safe while
        // every row under it was guaranteed to survive the filter — hiding
        // headless sessions broke that guarantee, and a date group whose only
        // session was headless left the header stranded over nothing. That is
        // the orphan header this file was written to prevent.
        let pendingHeader: SessionListViewItem | null = null;

        for (const item of data) {
            if (item.type === 'active-sessions') {
                continue; // already added
            }

            if (item.type === 'project-group') {
                pendingProjectGroup = item;
                continue;
            }

            if (item.type === 'session') {
                if (!item.session.active && !(isQuietHeadless(item.session) && !showHeadlessSessions)) {
                    if (pendingHeader) {
                        result.push(pendingHeader);
                        pendingHeader = null;
                    }
                    if (pendingProjectGroup) {
                        result.push(pendingProjectGroup);
                        pendingProjectGroup = null;
                    }
                    result.push(item);
                }
                continue;
            }

            pendingProjectGroup = null;

            if (item.type === 'header') {
                pendingHeader = item;
            }
        }
    }

    return result;
}
