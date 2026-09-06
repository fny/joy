import { describe, expect, it, vi } from 'vitest';
import { createChangelogUnreadStore, type ChangelogUnreadStorage } from './changelogUnread';

function fakeStorage(initial: { lastViewed?: string; legacy?: boolean } = {}) {
    let lastViewed = initial.lastViewed ?? '';
    const external = new Set<() => void>();
    const storage: ChangelogUnreadStorage & { writeExternally(title: string): void } = {
        getLastViewedTitle: () => lastViewed,
        setLastViewedTitle: (t) => { lastViewed = t; },
        hasLegacyViewedKey: () => initial.legacy ?? false,
        onExternalChange: (l) => { external.add(l); return () => external.delete(l); },
        writeExternally(title) { lastViewed = title; for (const l of external) l(); },
    };
    return storage;
}

describe('changelog unread store (#311)', () => {
    it('is unread when the latest title differs from the last viewed one', () => {
        const store = createChangelogUnreadStore(fakeStorage({ lastViewed: 'v1' }));
        expect(store.getSnapshot('v2')).toBe(true);
        expect(store.getSnapshot('v1')).toBe(false);
    });

    it('marking read in one consumer notifies every subscriber', () => {
        const store = createChangelogUnreadStore(fakeStorage({ lastViewed: 'v1' }));
        const a = vi.fn();
        const b = vi.fn();
        store.subscribe(a);
        store.subscribe(b);
        expect(store.getSnapshot('v2')).toBe(true);
        store.markAsRead('v2');
        expect(a).toHaveBeenCalledTimes(1);
        expect(b).toHaveBeenCalledTimes(1);
        // Both consumers read the same snapshot afterwards.
        expect(store.getSnapshot('v2')).toBe(false);
    });

    it('a direct write to the persisted title (changelog screen) also notifies', () => {
        const storage = fakeStorage({ lastViewed: 'v1' });
        const store = createChangelogUnreadStore(storage);
        const listener = vi.fn();
        const unsubscribe = store.subscribe(listener);
        storage.writeExternally('v2');
        expect(listener).toHaveBeenCalledTimes(1);
        expect(store.getSnapshot('v2')).toBe(false);
        unsubscribe();
        storage.writeExternally('v3');
        expect(listener).toHaveBeenCalledTimes(1);
    });

    it('first install marks the current release read; a legacy key shows the banner once', () => {
        const fresh = createChangelogUnreadStore(fakeStorage());
        expect(fresh.getSnapshot('v2')).toBe(false);
        const migrated = createChangelogUnreadStore(fakeStorage({ legacy: true }));
        expect(migrated.getSnapshot('v2')).toBe(true);
        migrated.markAsRead('v2');
        expect(migrated.getSnapshot('v2')).toBe(false);
    });

    it('markAsRead is a no-op (no notification) when already read', () => {
        const store = createChangelogUnreadStore(fakeStorage({ lastViewed: 'v2' }));
        const listener = vi.fn();
        store.subscribe(listener);
        store.markAsRead('v2');
        expect(listener).not.toHaveBeenCalled();
    });
});
