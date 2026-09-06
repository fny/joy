import React from 'react';
import { Platform } from 'react-native';
import { storage } from '@/sync/storage';
import { updateFaviconWithNotification, resetFavicon } from '@/utils/web/faviconGenerator';
import { hasFreshPermissionRequest, msUntilNextFreshnessExpiry } from './faviconPermission';

/**
 * Component that monitors all sessions and updates the favicon
 * when any online session has pending permissions
 */
export const FaviconPermissionIndicator = React.memo(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined' || typeof document === 'undefined') {
        return null;
    }

    // `presence` is only recomputed when a session update lands, so a
    // session whose daemon went silent stayed 'online' and kept the alert
    // favicon lit (#299). The predicate re-checks the heartbeat window, and
    // the tick below re-renders when the earliest lit session goes stale.
    const [, tick] = React.useReducer((n: number) => n + 1, 0);
    const hasOnlineSessionWithPermissions = storage((state) =>
        hasFreshPermissionRequest(Object.values(state.sessions), Date.now()));
    const nextExpiryMs = storage((state) =>
        msUntilNextFreshnessExpiry(Object.values(state.sessions), Date.now()));

    React.useEffect(() => {
        if (nextExpiryMs === null) return;
        const timer = setTimeout(tick, nextExpiryMs + 1);
        return () => clearTimeout(timer);
    }, [nextExpiryMs]);

    React.useLayoutEffect(() => {
        if (hasOnlineSessionWithPermissions) {
            updateFaviconWithNotification();
        } else {
            resetFavicon();
        }
    }, [hasOnlineSessionWithPermissions]);

    React.useLayoutEffect(() => {
        return () => {
            resetFavicon();
        };
    }, []);

    return null;
});

FaviconPermissionIndicator.displayName = 'FaviconPermissionIndicator';
