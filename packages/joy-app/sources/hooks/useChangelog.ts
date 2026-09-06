import { useCallback, useSyncExternalStore } from 'react';
import { MMKV } from 'react-native-mmkv';
import {
    getLastViewedTitle,
    setLastViewedTitle,
    getLatestTitle
} from '@/changelog';
import { createChangelogUnreadStore } from './changelogUnread';

const mmkv = new MMKV();
const LAST_VIEWED_KEY = 'changelog-last-viewed-title';

// One store for every mounted consumer (#311): marking the changelog read in
// the banner, or opening the changelog screen (which writes the title
// directly), updates every unread indicator at once. The MMKV listener catches
// the direct writes; markAsRead notifies synchronously.
const store = createChangelogUnreadStore({
    getLastViewedTitle,
    setLastViewedTitle,
    hasLegacyViewedKey: () => mmkv.contains('changelog-last-viewed-version'),
    onExternalChange: (listener) => {
        const sub = mmkv.addOnValueChangedListener((key) => {
            if (key === LAST_VIEWED_KEY) listener();
        });
        return () => sub.remove();
    },
});

export function useChangelog() {
    const latestTitle = getLatestTitle();

    const hasUnread = useSyncExternalStore(
        store.subscribe,
        () => store.getSnapshot(latestTitle),
        () => store.getSnapshot(latestTitle),
    );

    const markAsRead = useCallback(() => {
        store.markAsRead(latestTitle);
    }, [latestTitle]);

    return {
        hasUnread,
        latestTitle,
        markAsRead
    };
}
