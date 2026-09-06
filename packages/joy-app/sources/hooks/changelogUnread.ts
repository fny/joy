/**
 * The changelog "unread" flag as ONE shared store instead of per-hook state.
 *
 * useChangelog used to seed `hasUnread` into a useState per consumer; marking
 * the release read in one place (the banner, the changelog screen) left every
 * other mounted indicator stale until it remounted (#311). Every consumer now
 * reads the same snapshot, derived from the persisted last-viewed title, and
 * is notified whenever that title changes — through this store or through any
 * other writer of the same key (the changelog screen writes it directly).
 *
 * Storage is injected so the derivation is testable without MMKV.
 */
export interface ChangelogUnreadStorage {
    getLastViewedTitle(): string;
    setLastViewedTitle(title: string): void;
    /** True when the pre-title "last viewed version" key exists (migration). */
    hasLegacyViewedKey(): boolean;
    /** Subscribe to writes of the last-viewed title made outside this store. */
    onExternalChange?(listener: () => void): () => void;
}

export interface ChangelogUnreadStore {
    /** The current unread flag for `latestTitle`; stable between changes. */
    getSnapshot(latestTitle: string): boolean;
    subscribe(listener: () => void): () => void;
    markAsRead(latestTitle: string): void;
}

export function createChangelogUnreadStore(storage: ChangelogUnreadStorage): ChangelogUnreadStore {
    const listeners = new Set<() => void>();
    let externalUnsubscribe: (() => void) | null = null;

    const notify = () => { for (const l of [...listeners]) l(); };

    return {
        getSnapshot(latestTitle) {
            if (!latestTitle) return false;
            const lastViewed = storage.getLastViewedTitle();
            if (!lastViewed) {
                // First install (neither key): mark the current release read so
                // a brand-new user is not greeted with a "what's new" banner.
                // An old version key with no title key is the migration from
                // the previous scheme — show the banner once.
                if (!storage.hasLegacyViewedKey()) {
                    storage.setLastViewedTitle(latestTitle);
                    return false;
                }
                return true;
            }
            return latestTitle !== lastViewed;
        },
        subscribe(listener) {
            listeners.add(listener);
            if (listeners.size === 1 && storage.onExternalChange) {
                externalUnsubscribe = storage.onExternalChange(notify);
            }
            return () => {
                listeners.delete(listener);
                if (listeners.size === 0 && externalUnsubscribe) {
                    externalUnsubscribe();
                    externalUnsubscribe = null;
                }
            };
        },
        markAsRead(latestTitle) {
            if (!latestTitle) return;
            if (storage.getLastViewedTitle() === latestTitle) return;
            storage.setLastViewedTitle(latestTitle);
            notify();
        },
    };
}
