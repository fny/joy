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
    //
    // The store selector returns the STABLE sessions map only. Zustand's
    // getSnapshot must return a cached value for unchanged state; selecting
    // a Date.now()-dependent result (a millisecond-varying remaining delay)
    // produced a new snapshot on every read and React threw "Maximum update
    // depth exceeded". Time enters outside the external-store snapshot, at
    // render, and the component tick supplies freshness.
    const [, tick] = React.useReducer((n: number) => n + 1, 0);
    const sessions = storage((state) => state.sessions);
    const now = Date.now();
    const hasOnlineSessionWithPermissions = hasFreshPermissionRequest(Object.values(sessions), now);
    const nextExpiryMs = msUntilNextFreshnessExpiry(Object.values(sessions), now);

    React.useEffect(() => {
        if (nextExpiryMs === null) return;
        const timer = setTimeout(tick, nextExpiryMs + 1);
        return () => clearTimeout(timer);
    }, [sessions, nextExpiryMs]);

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
