/**
 * The session list under `localSettings.sessionListV2`: the list exactly as it
 * reads today, plus two things — sessions you have pinned, and machine
 * sections you can collapse.
 *
 * The active block and the rows themselves are untouched. What changes is
 * that Pinned sits above the active block, and the sessions below it are
 * grouped by machine instead of by date, under the same section headers,
 * with a chevron.
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
import { buildListLayout, partitionForList, type ListSection, type ListSession } from '@/sync/sessionListModel';
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
        const { pins, active, rest, archived } = partitionForList({ sessions: rows, pinned, hideInactive });

        const machineName = (id: string | null): string => {
            if (!id) return t('sidebar.noMachine');
            const m = machines[id];
            return m?.metadata?.displayName || m?.metadata?.host || id;
        };

        const items: SessionListViewItem[] = [];
        const emit = (section: ListSection<Row>) => {
            items.push({
                type: 'header',
                title: section.kind === 'pinned' ? t('sidebar.pinned') : machineName(section.machineId),
                // Pinned is a label, not a control: no key means no chevron.
                sectionKey: section.kind === 'pinned' ? undefined : section.key,
                count: section.sessions.length,
                collapsed: section.collapsed,
                worstState: section.collapsed ? section.worstState : null,
            });
            if (section.collapsed) return;
            for (const row of section.sessions) {
                const session = sessions[row.id];
                if (session) items.push({ type: 'session', session: sessionRowDataFor(session, unread) });
            }
        };

        // Pinned goes ABOVE the active block, not below it. A pin is the one
        // thing in this list whose position you chose yourself; anything that
        // can push it down — and the active block grows and shrinks on its
        // own — means the pin no longer answers "where is it".
        const sections = buildListLayout({ sessions: [...pins, ...rest], pinned, collapsed });
        for (const section of sections) {
            if (section.kind === 'pinned') emit(section);
        }

        if (active.length > 0) {
            items.push({
                type: 'active-sessions',
                sessions: active
                    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
                    .map((r) => sessionRowDataFor(r.session, unread)),
            });
        }

        // The archive toggle, exactly where the old list puts it. Without it
        // "hide archived" is a one-way door: it empties every machine section,
        // and nothing in the list can bring them back.
        if (archived > 0) items.push({ type: 'archive-toggle', hidden: hideInactive });

        for (const section of sections) {
            if (section.kind !== 'pinned') emit(section);
        }
        return items;
    }, [enabled, sessions, unread, machines, pinned, collapsed, hideInactive]);
}
