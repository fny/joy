import { useModal } from '@/modal';
import { useOverlayNav } from '@/-session/sessionOverlayNav';
import {
    canRouteForward,
    canUseRouteBack,
    getNavigatorCanGoBack,
    getKeyboardNavigationDirection,
    getMouseNavigationDirection,
    isSessionChatPath,
} from '@/navigation/browserNavigation';
import { useEscapeAbort } from '@/hooks/useEscapeAbort';
import { useBrowserNavigationStore } from '@/navigation/browserNavigationStore';
import { storage } from '@/sync/storage';
import { useGlobalSearchParams, usePathname, useRouter } from 'expo-router';
import * as React from 'react';
import { Platform } from 'react-native';

function runRouteBack(router: ReturnType<typeof useRouter>): boolean {
    const nav = useBrowserNavigationStore.getState();
    if (!nav.routeHistory || !canUseRouteBack(nav.routeHistory, getNavigatorCanGoBack(router))) {
        return false;
    }
    nav.markRouteBack();
    router.back();
    return true;
}

function runRouteForward(): boolean {
    const nav = useBrowserNavigationStore.getState();
    if (!nav.routeHistory || !canRouteForward(nav.routeHistory)) {
        return false;
    }
    if (typeof window === 'undefined') {
        return false;
    }
    nav.markRouteForward();
    window.history.forward();
    return true;
}

/**
 * Mouse Forward mirrors Mouse Back: the intra-session overlay stack (file
 * diff / file view) is consulted FIRST, then browser route history. Before,
 * Forward only knew route history, so an overlay closed with Mouse Back could
 * not be reopened with Mouse Forward — and if route forward history existed
 * the shortcut left the session instead (#310). Exported for tests.
 */
export function runForward(): boolean {
    if (useOverlayNav.getState().forward()) return true;
    return runRouteForward();
}

function exitZenMode(): boolean {
    const state = storage.getState();
    if (!state.localSettings.zenMode) {
        return false;
    }
    state.applyLocalSettings({ zenMode: false });
    return true;
}

export function useBrowserNavigationShortcuts() {
    const router = useRouter();
    const pathname = usePathname();
    const searchParams = useGlobalSearchParams();
    const { dismissTopModal } = useModal();
    const syncRoutePathname = useBrowserNavigationStore((state) => state.syncRoutePathname);
    const mouseNavigationHandledRef = React.useRef(false);
    const routeKey = React.useMemo(() => {
        if (Platform.OS === 'web' && typeof window !== 'undefined') {
            return `${window.location.pathname}${window.location.search}`;
        }
        return pathname;
    }, [pathname, searchParams]);

    React.useEffect(() => {
        syncRoutePathname(routeKey);
    }, [routeKey, syncRoutePathname]);

    const runBack = React.useCallback((options: { exitZen: boolean; allowRouteBack?: boolean }) => {
        if (dismissTopModal()) return true;
        if (options.exitZen && exitZenMode()) return true;
        if (useOverlayNav.getState().back()) return true;
        // Esc on the session chat screen: abort the running turn if there is
        // one, otherwise swallow the key — never navigate away from a chat.
        // (Mouse back-button passes allowRouteBack !== false and still leaves.)
        if (options.allowRouteBack === false) {
            useEscapeAbort.getState().handler?.();
            return true;
        }
        return runRouteBack(router);
    }, [dismissTopModal, router]);

    React.useEffect(() => {
        if (Platform.OS !== 'web' || typeof window === 'undefined') {
            return;
        }

        const onKeyDown = (event: KeyboardEvent) => {
            if (getKeyboardNavigationDirection(event) !== 'back') {
                return;
            }
            const allowRouteBack = !isSessionChatPath(window.location.pathname);
            if (runBack({ exitZen: true, allowRouteBack })) {
                event.preventDefault();
                event.stopPropagation();
            }
        };

        const onMouseUp = (event: MouseEvent) => {
            const direction = getMouseNavigationDirection(event);
            if (!direction) {
                return;
            }

            const handled = direction === 'back'
                ? runBack({ exitZen: false })
                : runForward();
            if (handled) {
                mouseNavigationHandledRef.current = true;
                event.preventDefault();
                event.stopPropagation();
            } else {
                mouseNavigationHandledRef.current = false;
            }
        };

        const onAuxClick = (event: MouseEvent) => {
            if (getMouseNavigationDirection(event) && mouseNavigationHandledRef.current) {
                mouseNavigationHandledRef.current = false;
                event.preventDefault();
                event.stopPropagation();
            }
        };

        window.addEventListener('keydown', onKeyDown);
        window.addEventListener('mouseup', onMouseUp, true);
        window.addEventListener('auxclick', onAuxClick, true);
        return () => {
            window.removeEventListener('keydown', onKeyDown);
            window.removeEventListener('mouseup', onMouseUp, true);
            window.removeEventListener('auxclick', onAuxClick, true);
        };
    }, [runBack]);
}

export function BrowserNavigationShortcuts() {
    useBrowserNavigationShortcuts();
    return null;
}
