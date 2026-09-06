/**
 * The zoom-shortcut state machine behind useTauriZoom, kept free of DOM and
 * Tauri imports so it can be tested.
 *
 * Before (#326): the webview import ran in a detached async IIFE; when it
 * failed the rejection was unhandled, `webview` stayed null forever, and every
 * Cmd/Ctrl +/-/0 was still preventDefault-ed — the shortcuts were dead AND
 * swallowed, with no second load attempt. Now a failed load is reported,
 * the next shortcut retries the load, and a key is only consumed when a usable
 * webview exists. A load that completes after `dispose()` is discarded.
 */
export interface ZoomWebview {
    setZoom(zoom: number): Promise<void>;
}

export interface ZoomKeyEvent {
    metaKey: boolean;
    ctrlKey: boolean;
    altKey: boolean;
    key: string;
    preventDefault(): void;
}

export interface TauriZoomController {
    /** True once a webview is loaded and shortcuts are active. */
    readonly ready: boolean;
    readonly zoom: number;
    /** Kick off (or retry) loading the webview. Never rejects. */
    init(): Promise<void>;
    /** Handle a keydown; returns true when the key was consumed. */
    handleKey(event: ZoomKeyEvent): boolean;
    dispose(): void;
}

export const MIN_APP_ZOOM = 0.5;
export const MAX_APP_ZOOM = 2.5;
export const ZOOM_STEP = 0.1;

export const clampZoom = (zoom: number) => Math.max(MIN_APP_ZOOM, Math.min(MAX_APP_ZOOM, zoom));

type ZoomAction = 'in' | 'out' | 'reset' | null;

export function zoomActionForKey(event: Pick<ZoomKeyEvent, 'metaKey' | 'ctrlKey' | 'altKey' | 'key'>): ZoomAction {
    if ((!event.metaKey && !event.ctrlKey) || event.altKey) return null;
    if (event.key === '=' || event.key === '+') return 'in';
    if (event.key === '-' || event.key === '_') return 'out';
    if (event.key === '0') return 'reset';
    return null;
}

export function createTauriZoomController(options: {
    load: () => Promise<ZoomWebview>;
    defaultZoom: number;
    onError?: (error: unknown) => void;
}): TauriZoomController {
    const { load, defaultZoom } = options;
    const onError = options.onError ?? (() => {});
    let webview: ZoomWebview | null = null;
    let loading: Promise<void> | null = null;
    let disposed = false;
    let zoom = defaultZoom;

    const apply = (next: number) => {
        zoom = clampZoom(next);
        if (!webview) return;
        webview.setZoom(zoom).catch(onError);
    };

    const init = (): Promise<void> => {
        if (disposed || webview) return Promise.resolve();
        if (loading) return loading;
        loading = (async () => {
            try {
                const loaded = await load();
                if (disposed) return; // effect already cleaned up; do not publish
                webview = loaded;
                apply(zoom);
            } catch (e) {
                onError(e); // retried on the next shortcut
            } finally {
                loading = null;
            }
        })();
        return loading;
    };

    return {
        get ready() { return webview !== null; },
        get zoom() { return zoom; },
        init,
        handleKey(event) {
            const action = zoomActionForKey(event);
            if (!action) return false;
            if (!webview) {
                // Not usable yet (or the load failed): retry the load and let
                // the key fall through instead of swallowing it.
                void init();
                return false;
            }
            event.preventDefault();
            if (action === 'in') apply(zoom + ZOOM_STEP);
            else if (action === 'out') apply(zoom - ZOOM_STEP);
            else apply(defaultZoom);
            return true;
        },
        dispose() {
            disposed = true;
            webview = null;
        },
    };
}
