/**
 * The session list under `localSettings.sessionListV2`: the list exactly as it
 * reads today, plus two things — sessions you have pinned, and machine
 * sections you can collapse.
 *
 * The active block at the top is untouched, and so are the rows. What changes
 * is that the sessions BELOW it are grouped by machine instead of by date,
 * under the same section headers, with a chevron.
 *
 * Built here rather than in the store because the pins and the collapse set
 * are preferences: a store-side rebuild would have to be re-triggered by every
 * change to either. The placement rules are pure and live in
 * sync/sessionListModel.ts.
 */
import * as React from 'react';
import { storage, sessionRowDataFor, useLocalSetting, useSetting, type SessionListViewItem } from '@/sync/storage';
import { useShallow } from 'zustand/react/shallow';
import { isSessionInActiveGroup } from '@/sync/sessionLiveness';
import { hiddenFromList, liveFacts } from '@/sync/sessionFacts';
import { buildListLayout, partitionForList, type ListSession } from '@/sync/sessionListModel';
import { t } from '@/text';

interface Row extends ListSession { id: string }

export function useSessionListV2(): SessionListViewItem[] | null {
    const enabled = useLocalSetting('sessionListV2');
    const collapsed = useLocalSetting('collapsedSessionGroups');
    const pinned = useSetting('pinnedSessions');
    const hideInactive = useSetting('hideInactiveSessions');

    const sessions = storage(useShallow((state) => (state.isDataReady ? state.sessions : null)));
    const unread = storage(useShallow((state) => state.unreadSessionIds));
    const machines = storage(useShallow((state) => state.machines));

    return React.useMemo(() => {
        if (!enabled || !sessions) return null;

        const all = Object.values(sessions)
            // `joy new --headless`: out of the list until it needs a human.
            .filter((s) => !hiddenFromList(liveFacts(s)));

        // A pin outranks the active block, so a pinned session sits in Pinned
        // whatever it is doing — see partitionForList, which exists because
        // getting this wrong made pinning silently do nothing.
        const rows: Array<Row & { session: (typeof all)[number] }> = all.map((s) => ({
            id: s.id,
            state: sessionRowDataFor(s, unread).state,
            machineId: s.metadata?.machineId ?? null,
            activeAt: s.activeAt,
            createdAt: s.createdAt,
            active: isSessionInActiveGroup(s),
            session: s,
        }));
        const { pins, active, rest } = partitionForList({ sessions: rows, pinned, hideInactive });

        const items: SessionListViewItem[] = [];
        if (active.length > 0) {
            items.push({
                type: 'active-sessions',
                sessions: active
                    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
                    .map((r) => sessionRowDataFor(r.session, unread)),
            });
        }

        const machineName = (id: string | null): string => {
            if (!id) return t('sidebar.noMachine');
            const m = machines[id];
            return m?.metadata?.displayName || m?.metadata?.host || id;
        };

        for (const section of buildListLayout({ sessions: [...pins, ...rest], pinned, collapsed })) {
            items.push({
                type: 'header',
                title: section.kind === 'pinned' ? t('sidebar.pinned') : machineName(section.machineId),
                // Pinned is a label, not a control: no key means no chevron.
                sectionKey: section.kind === 'pinned' ? undefined : section.key,
                count: section.sessions.length,
                collapsed: section.collapsed,
                worstState: section.collapsed ? section.worstState : null,
            });
            if (section.collapsed) continue;
            for (const row of section.sessions) {
                const session = sessions[row.id];
                if (session) items.push({ type: 'session', session: sessionRowDataFor(session, unread) });
            }
        }
        return items;
    }, [enabled, sessions, unread, machines, pinned, collapsed, hideInactive]);
}
