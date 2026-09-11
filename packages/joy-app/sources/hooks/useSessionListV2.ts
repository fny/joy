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
import { automationPlacement, hiddenFromList, liveFacts } from '@/sync/sessionFacts';
import { buildListLayout, partitionForList, stateUrgency, type ListSection, type ListSession } from '@/sync/sessionListModel';
import { projectLabel } from '@/utils/projectLabel';
import { t } from '@/text';

interface Row extends ListSession { id: string }

export function useSessionListV2(): SessionListViewItem[] | null {
    const enabled = useLocalSetting('sessionListV2');
    const collapsed = useLocalSetting('collapsedSessionGroups');
    const pinned = useSetting('pinnedSessions');
    const hideInactive = useSetting('hideInactiveSessions');
    const pinnedSort = useLocalSetting('pinnedSort');
    const showHeadless = useLocalSetting('showHeadlessSessions');
    const showAutomations = useLocalSetting('showAutomationSessions');

    const sessions = storage(useShallow((state) => (state.isDataReady ? state.sessions : null)));
    const unread = storage(useShallow((state) => state.unreadSessionIds));
    const machines = storage(useShallow((state) => state.machines));

    return React.useMemo(() => {
        if (!enabled || !sessions) return null;

        const all = Object.values(sessions);
        const rows: Array<Row & { session: (typeof all)[number] }> = all.map((s) => {
            const facts = liveFacts(s);
            return {
                id: s.id,
                state: sessionRowDataFor(s, unread).state,
                machineId: s.metadata?.machineId ?? null,
                activeAt: s.activeAt,
                createdAt: s.createdAt,
                active: isSessionInActiveGroup(s),
                automation: automationPlacement(facts),
                headless: hiddenFromList(facts),
                // The project as the row shows it — the pinned sort key, so
                // the order matches what you are reading rather than a hidden
                // field.
                project: projectLabel(s.metadata?.path ?? null),
                hasUnread: unread.has(s.id),
                session: s,
            };
        });
        const { pins, active, archived, automationsRunning, automationsFailed, headless } =
            partitionForList({ sessions: rows, pinned });

        const machineName = (id: string | null): string => {
            if (!id) return t('sidebar.noMachine');
            const m = machines[id];
            return m?.metadata?.displayName || m?.metadata?.host || id;
        };

        const items: SessionListViewItem[] = [];
        const emitRows = (rowsIn: typeof rows, compact = false) => {
            for (const row of rowsIn) {
                const session = sessions[row.id];
                if (session) items.push({ type: 'session', session: sessionRowDataFor(session, unread), compact });
            }
        };

        // A failed automation outranks even the section you built by hand.
        // Not a toggle and not collapsible: it is a statement, and it stays
        // until dismissed rather than until something reclaims it unseen.
        if (automationsFailed.length > 0) {
            items.push({
                type: 'header',
                title: t('sidebar.automationFailures'),
                count: automationsFailed.length,
                collapsed: false,
                worstState: null,
            });
            emitRows(automationsFailed);
        }

        // Pinned, above the active block: a pin is the one row whose position
        // you chose yourself, and the active block grows and shrinks on its own.
        if (pins.length > 0) {
            const sorted = buildListLayout({ sessions: pins, pinned, collapsed, pinnedSort })
                .find((x) => x.kind === 'pinned');
            items.push({
                type: 'header',
                title: t('sidebar.pinned'),
                sortMode: pinnedSort,
                count: pins.length,
                collapsed: false,
                worstState: null,
            });
            emitRows((sorted?.sessions ?? pins) as typeof rows, true);
        }

        if (active.length > 0) {
            items.push({
                type: 'active-sessions',
                sessions: active
                    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
                    .map((r) => sessionRowDataFor(r.session, unread)),
            });
        }

        // ── the three toggles, each ABOVE the rows it reveals ────────────────
        //
        // Every one of these is a divider whose contents sit directly beneath
        // it. They used to be filters: flipping one let its sessions appear
        // wherever they would normally have gone — including inside the active
        // block at the top — so a control near the bottom of the list changed
        // what was at the top of it. Now each kind is partitioned out before
        // the active block is filled, and a toggle only decides whether the
        // rows under its own header are drawn.
        const toggle = (
            key: 'archived' | 'automations' | 'headless',
            showing: boolean,
            title: string,
            rowsIn: typeof rows,
            byMachine = false,
        ) => {
            if (rowsIn.length === 0) return;
            items.push({ type: 'section-toggle', key, hidden: !showing, title, count: rowsIn.length });
            if (!showing) return;
            if (!byMachine) { emitRows(rowsIn); return; }
            // Grouped by machine UNDER the divider — the collapsible machine
            // sections, kept, but now inside the thing that reveals them
            // rather than sitting above it.
            for (const section of buildListLayout({ sessions: rowsIn, pinned: [], collapsed })) {
                items.push({
                    type: 'header',
                    title: machineName(section.machineId),
                    sectionKey: section.key,
                    count: section.sessions.length,
                    collapsed: section.collapsed,
                    worstState: section.collapsed ? section.worstState : null,
                });
                if (!section.collapsed) emitRows(section.sessions as typeof rows);
            }
        };

        toggle('archived', !hideInactive, hideInactive ? t('sidebar.showArchived') : t('sidebar.hideArchived'), archived, true);
        toggle('automations', showAutomations, showAutomations ? t('sidebar.hideAutomations') : t('sidebar.showAutomations'), automationsRunning);
        toggle('headless', showHeadless, showHeadless ? t('sidebar.hideHeadless') : t('sidebar.showHeadless'), headless);

        return items;
    }, [enabled, sessions, unread, machines, pinned, collapsed, hideInactive, pinnedSort, showHeadless, showAutomations]);
}
