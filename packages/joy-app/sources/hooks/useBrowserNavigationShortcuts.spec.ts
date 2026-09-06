import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('react-native', () => ({ Platform: { OS: 'web' } }));
vi.mock('expo-router', () => ({ useRouter: () => ({}), usePathname: () => '/', useGlobalSearchParams: () => ({}) }));
vi.mock('@/modal', () => ({ useModal: () => ({ dismissTopModal: () => false }) }));
vi.mock('@/sync/storage', () => ({ storage: { getState: () => ({ localSettings: { zenMode: false }, applyLocalSettings: () => {} }) } }));
vi.mock('@/hooks/useEscapeAbort', () => ({ useEscapeAbort: { getState: () => ({ handler: null }) } }));

import { runForward } from './useBrowserNavigationShortcuts';
import { useOverlayNav } from '@/-session/sessionOverlayNav';
import { useBrowserNavigationStore } from '@/navigation/browserNavigationStore';

describe('runForward (#310)', () => {
    beforeEach(() => {
        useOverlayNav.getState().reset();
        useBrowserNavigationStore.setState({ routeHistory: null, pendingRouteDirection: null });
    });

    it('reopens an overlay closed with Mouse Back before touching route history', () => {
        const forward = vi.fn(() => true);
        useOverlayNav.getState().publish({ canBack: false, canForward: true, back: () => false, forward });
        // Route forward history ALSO exists — the overlay must still win.
        useBrowserNavigationStore.setState({ routeHistory: { stack: ['/', '/settings'], cursor: 0 }, pendingRouteDirection: null });
        const historyForward = vi.fn();
        (globalThis as { window?: unknown }).window = { history: { forward: historyForward } };
        try {
            expect(runForward()).toBe(true);
            expect(forward).toHaveBeenCalledTimes(1);
            expect(historyForward).not.toHaveBeenCalled();
            expect(useBrowserNavigationStore.getState().pendingRouteDirection).toBeNull();
        } finally {
            delete (globalThis as { window?: unknown }).window;
        }
    });

    it('falls back to route forward history when the overlay has nothing to reopen', () => {
        useBrowserNavigationStore.setState({ routeHistory: { stack: ['/', '/settings'], cursor: 0 }, pendingRouteDirection: null });
        const historyForward = vi.fn();
        (globalThis as { window?: unknown }).window = { history: { forward: historyForward } };
        try {
            expect(runForward()).toBe(true);
            expect(historyForward).toHaveBeenCalledTimes(1);
            expect(useBrowserNavigationStore.getState().pendingRouteDirection).toBe('forward');
        } finally {
            delete (globalThis as { window?: unknown }).window;
        }
    });

    it('reports unhandled when neither history can go forward', () => {
        useBrowserNavigationStore.setState({ routeHistory: { stack: ['/'], cursor: 0 }, pendingRouteDirection: null });
        expect(runForward()).toBe(false);
    });
});
