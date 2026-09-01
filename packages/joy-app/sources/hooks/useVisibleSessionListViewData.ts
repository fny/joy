import * as React from 'react';
import { SessionListViewItem, useSessionListViewData, useSetting } from '@/sync/storage';
import { filterVisibleSessionListViewData } from '@/sync/sessionListVisibility';

export function useVisibleSessionListViewData(): SessionListViewItem[] | null {
    const data = useSessionListViewData();
    const hideInactiveSessions = useSetting('hideInactiveSessions');

    return React.useMemo(() => {
        if (!data) {
            return data;
        }
        return filterVisibleSessionListViewData(data, hideInactiveSessions);
    }, [data, hideInactiveSessions]);
}
