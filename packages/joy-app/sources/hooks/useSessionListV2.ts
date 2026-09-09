/**
 * The session list under `localSettings.sessionListV2`: pins, custom groups,
 * a switchable grouping axis, collapsible sections and preset filters.
 *
 * Built HERE rather than in the store, deliberately. The axis, the filter and
 * the collapse set are device-local preferences; a store-side rebuild would
 * have to be re-triggered by every one of them, and the store's list builder
 * takes only sessions. The rules themselves are pure and live in
 * sync/sessionListModel.ts — this hook is the wiring: read the preferences,
 * hand the model the sessions, flatten its sections into list items.
 */
import * as React from 'react';
import { storage, sessionRowDataFor, useLocalSetting, useSetting, type SessionListViewItem } from '@/sync/storage';
import { useShallow } from 'zustand/react/shallow';
import { isSessionInActiveGroup } from '@/sync/sessionLiveness';
import { buildListLayout, type ListSession } from '@/sync/sessionListModel';
import { hiddenFromList, liveFacts } from '@/sync/sessionFacts';
import { t } from '@/text';

/** The model's view of a session, straight off the store row. */
interface Row extends ListSession { id: string }

export function useSessionListV2(): SessionListViewItem[] | null {
    const enabled = useLocalSetting('sessionListV2');
    const axis = useLocalSetting('sessionGroupBy');
    const filter = useLocalSetting('sessionFilter');
    const collapsed = useLocalSetting('collapsedSessionGroups');
    const pinned = useSetting('pinnedSessions');
    const views = useSetting('sessionViews');
    const hideInactive = useSetting('hideInactiveSessions');

    // The raw sessions and the unread set. Selected shallowly so this
    // re-runs on the same cadence the store's own list rebuild did.
    const sessions = storage(useShallow((state) => (state.isDataReady ? state.sessions : null)));
    const unread = storage(useShallow((state) => state.unreadSessionIds));

    return React.useMemo(() => {
        if (!enabled || !sessions) return null;

        const all = Object.values(sessions);
        // "Hide archived" is a visibility filter, not a grouping question:
        // apply it before the model so an archived session cannot hold a
        // section open or colour its rollup.
        const shown = all.filter((s) => !hiddenFromList(liveFacts(s)));
        const visible = hideInactive ? shown.filter((s) => isSessionInActiveGroup(s)) : shown;

        const rows: Row[] = visible.map((s) => ({
            id: s.id,
            state: sessionRowDataFor(s, unread).state,
            machineId: s.metadata?.machineId ?? null,
            path: s.metadata?.path ?? null,
            flavor: s.metadata?.flavor ?? null,
            hasUnread: unread.has(s.id),
            createdAt: s.createdAt,
            activeAt: s.activeAt,
        }));

        const layout = buildListLayout({
            sessions: rows,
            pinned,
            views,
            axis,
            filter,
            collapsed,
            pinnedTitle: t('sidebar.pinned'),
        });

        const items: SessionListViewItem[] = [{ type: 'list-controls' }];
        for (const section of layout.sections) {
            items.push({
                type: 'group-header',
                sectionKey: section.key,
                title: section.title,
                kind: section.kind,
                count: section.sessions.length,
                hiddenByFilter: section.hiddenByFilter,
                collapsed: section.collapsed,
                worstState: section.worstState,
            });
            if (section.collapsed) continue;
            for (const row of section.sessions) {
                const session = sessions[row.id];
                if (session) items.push({ type: 'session', session: sessionRowDataFor(session, unread) });
            }
        }
        items.push({ type: 'list-tally', shown: layout.shown, total: layout.total });
        return items;
    }, [enabled, sessions, unread, pinned, views, axis, filter, collapsed, hideInactive]);
}
