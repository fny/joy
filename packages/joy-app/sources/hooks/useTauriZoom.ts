import { useEffect } from 'react';
import { Platform } from 'react-native';
import { isTauri } from '@/utils/isTauri';
import { createTauriZoomController } from './tauriZoomController';

export const DEFAULT_APP_ZOOM = 1.0;
export const BROWSER_APP_ZOOM = 1.0;

const WEB_ZOOM_CLASS = 'joy-app-zoomed';

export function getBrowserAppZoomValue(): string {
    return String(BROWSER_APP_ZOOM);
}

// Cmd/Ctrl+=, Cmd/Ctrl+-, Cmd/Ctrl+0 zoom shortcuts for the Tauri desktop app.
// Uses Tauri's native webview.setZoom — unlike CSS `zoom`, this shrinks the
// layout viewport so matchMedia / window.innerWidth change and responsive
// breakpoints (unistyles etc.) react correctly.
export function useTauriZoom() {
    useEffect(() => {
        if (Platform.OS !== 'web' || typeof window === 'undefined' || typeof document === 'undefined') return;

        const inTauri = isTauri();
        const root = document.documentElement;

        if (!inTauri) {
            root.style.setProperty('--joy-app-zoom', getBrowserAppZoomValue());
            root.classList.add(WEB_ZOOM_CLASS);
            return () => {
                root.classList.remove(WEB_ZOOM_CLASS);
                root.style.removeProperty('--joy-app-zoom');
            };
        }

        root.classList.remove(WEB_ZOOM_CLASS);
        root.style.removeProperty('--joy-app-zoom');

        // The controller owns load/retry/consume decisions (#326): a failed
        // webview import is logged (not an unhandled rejection), the next
        // shortcut retries it, and keys are only consumed once a webview exists.
        const controller = createTauriZoomController({
            load: async () => {
                const { getCurrentWebview } = await import('@tauri-apps/api/webview');
                return getCurrentWebview();
            },
            defaultZoom: DEFAULT_APP_ZOOM,
            onError: (e) => console.error('[useTauriZoom] webview zoom failed:', e),
        });
        void controller.init();

        const onKey = (e: KeyboardEvent) => { controller.handleKey(e); };
        window.addEventListener('keydown', onKey);
        return () => {
            window.removeEventListener('keydown', onKey);
            controller.dispose();
        };
    }, []);
}
