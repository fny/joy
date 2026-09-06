import { describe, expect, it, vi } from 'vitest';
import { createTauriZoomController, zoomActionForKey, type ZoomWebview } from './tauriZoomController';

const key = (k: string, mods: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean }> = { ctrlKey: true }) => ({
    key: k,
    metaKey: mods.metaKey ?? false,
    ctrlKey: mods.ctrlKey ?? false,
    altKey: mods.altKey ?? false,
    preventDefault: vi.fn(),
});

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

describe('tauri zoom controller (#326)', () => {
    it('a failed webview load is reported, does not consume shortcuts, and is retried', async () => {
        const onError = vi.fn();
        const webview: ZoomWebview = { setZoom: vi.fn().mockResolvedValue(undefined) };
        const load = vi.fn<() => Promise<ZoomWebview>>()
            .mockRejectedValueOnce(new Error('module load failed'))
            .mockResolvedValueOnce(webview);
        const c = createTauriZoomController({ load, defaultZoom: 1, onError });

        await c.init();
        expect(onError).toHaveBeenCalledTimes(1);
        expect(c.ready).toBe(false);

        // Shortcut while unusable: not consumed (browser default intact) and the load is retried.
        const e1 = key('=');
        expect(c.handleKey(e1)).toBe(false);
        expect(e1.preventDefault).not.toHaveBeenCalled();
        await flush();
        expect(load).toHaveBeenCalledTimes(2);
        expect(c.ready).toBe(true);

        // Now shortcuts are active.
        const e2 = key('=');
        expect(c.handleKey(e2)).toBe(true);
        expect(e2.preventDefault).toHaveBeenCalled();
        expect(c.zoom).toBeCloseTo(1.1);
        expect(webview.setZoom).toHaveBeenLastCalledWith(1.1);
    });

    it('does not start a second load while one is pending', async () => {
        let resolve!: (w: ZoomWebview) => void;
        const load = vi.fn(() => new Promise<ZoomWebview>((r) => { resolve = r; }));
        const c = createTauriZoomController({ load, defaultZoom: 1 });
        void c.init();
        c.handleKey(key('-'));
        c.handleKey(key('0'));
        expect(load).toHaveBeenCalledTimes(1);
        resolve({ setZoom: vi.fn().mockResolvedValue(undefined) });
        await flush();
        expect(c.ready).toBe(true);
    });

    it('a load that completes after dispose is not published', async () => {
        let resolve!: (w: ZoomWebview) => void;
        const load = vi.fn(() => new Promise<ZoomWebview>((r) => { resolve = r; }));
        const c = createTauriZoomController({ load, defaultZoom: 1 });
        void c.init();
        c.dispose();
        const setZoom = vi.fn().mockResolvedValue(undefined);
        resolve({ setZoom });
        await flush();
        expect(c.ready).toBe(false);
        expect(setZoom).not.toHaveBeenCalled();
    });

    it('clamps zoom and resets to the default', async () => {
        const setZoom = vi.fn().mockResolvedValue(undefined);
        const c = createTauriZoomController({ load: async () => ({ setZoom }), defaultZoom: 1 });
        await c.init();
        for (let i = 0; i < 30; i++) c.handleKey(key('+', { metaKey: true }));
        expect(c.zoom).toBe(2.5);
        c.handleKey(key('0', { metaKey: true }));
        expect(c.zoom).toBe(1);
    });

    it('ignores keys that are not zoom chords', () => {
        expect(zoomActionForKey({ key: '=', metaKey: false, ctrlKey: false, altKey: false })).toBeNull();
        expect(zoomActionForKey({ key: '=', metaKey: true, ctrlKey: false, altKey: true })).toBeNull();
        expect(zoomActionForKey({ key: 'k', metaKey: true, ctrlKey: false, altKey: false })).toBeNull();
        expect(zoomActionForKey({ key: '_', metaKey: false, ctrlKey: true, altKey: false })).toBe('out');
    });
});
