// Dependency-free (type-only import) so it can be unit-tested without loading
// the store; the hook in hooks/useVisibleSessionListViewData.ts wraps it.
import type { SessionListViewItem } from './storage';

/**
 * Pure half of the hook: the archive toggle + hide-archived filtering over the
 * grouped list. Trusts the grouping — every `session` item is history by
 * construction (active ones are inside the `active-sessions` item), and
 * SessionRowData.active is stamped from the SAME predicate the grouping used
 * (isSessionInActiveGroup), so a row can never be grouped as history and then
 * filtered out here as "active" (which showed date headers with nothing under
 * them).
 */
export function filterVisibleSessionListViewData(data: SessionListViewItem[], hideInactiveSessions: boolean): SessionListViewItem[] {
    const result: SessionListViewItem[] = [];
    let hasInactive = false;

    // First pass: add active sessions group and check if inactive sessions exist
    for (const item of data) {
        if (item.type === 'active-sessions') {
            result.push(item);
        } else if (item.type === 'session' && !item.session.active) {
            hasInactive = true;
        }
    }

    // Insert archive toggle if there are inactive sessions
    if (hasInactive) {
        result.push({ type: 'archive-toggle', hidden: hideInactiveSessions });
    }

    // If not hiding, add all remaining items (headers, project groups, inactive sessions)
    if (!hideInactiveSessions) {
        let pendingProjectGroup: SessionListViewItem | null = null;

        for (const item of data) {
            if (item.type === 'active-sessions') {
                continue; // already added
            }

            if (item.type === 'project-group') {
                pendingProjectGroup = item;
                continue;
            }

            if (item.type === 'session') {
                if (!item.session.active) {
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
                result.push(item);
            }
        }
    }

    return result;
}
