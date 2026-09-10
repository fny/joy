import * as React from 'react';
import { useSessionListV2 } from '@/hooks/useSessionListV2';
import { SessionListViewItem, useSessionListViewData, useLocalSetting, useSetting } from '@/sync/storage';
import { filterVisibleSessionListViewData } from '@/sync/sessionListVisibility';

export function useVisibleSessionListViewData(): SessionListViewItem[] | null {
    const data = useSessionListViewData();
    const hideInactiveSessions = useSetting('hideInactiveSessions');
    const showHeadlessSessions = useLocalSetting('showHeadlessSessions');
    // v2 does its own grouping AND its own archived filtering (an archived
    // session must not colour a section's rollup), so it replaces both.
    const v2 = useSessionListV2();

    const legacy = React.useMemo(() => {
        if (!data) {
            return data;
        }
        return filterVisibleSessionListViewData(data, hideInactiveSessions, showHeadlessSessions);
    }, [data, hideInactiveSessions, showHeadlessSessions]);

    return v2 ?? legacy;
}
