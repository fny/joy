import * as React from 'react';
import { AppState } from 'react-native';
import { useFocusEffect } from 'expo-router';

/**
 * Run `fn` on an interval, but ONLY while the screen is focused AND the app is
 * in the foreground (`AppState === 'active'`). The timer is torn down when the
 * app backgrounds or the screen blurs, and restarted (with an immediate call)
 * when it returns — so a locked phone / hidden screen lets the radio + CPU
 * sleep instead of polling the daemon every interval (battery).
 *
 * Pass `enabled = false` to disable entirely (e.g. no machine/session yet).
 */
export function useActiveInterval(fn: () => void, ms: number, enabled = true): void {
    const saved = React.useRef(fn);
    saved.current = fn;

    useFocusEffect(
        React.useCallback(() => {
            if (!enabled) return;
            let id: ReturnType<typeof setInterval> | null = null;
            const stop = () => {
                if (id !== null) { clearInterval(id); id = null; }
            };
            const start = () => {
                if (id !== null) return;
                saved.current();                       // fire immediately on (re)start
                id = setInterval(() => saved.current(), ms);
            };
            if (AppState.currentState === 'active') start();
            const sub = AppState.addEventListener('change', (s) => {
                if (s === 'active') start(); else stop();
            });
            return () => { stop(); sub.remove(); };
        }, [ms, enabled]),
    );
}
