import * as React from 'react';
import { Platform } from 'react-native';
import { useSetting } from '@/sync/storage';
import { isTouchWeb } from '@/utils/isTouchWeb';

// Mod 06 (`joy__doubleTapEnabled`) requires every commit-style press on
// LLM-presented choice options to be a deliberate double tap. The first tap
// arms a key; the second tap on the same key within DOUBLE_TAP_TIMEOUT_MS
// commits. Tapping a different key re-arms. After the timeout the arm is
// cleared automatically.
//
// Touch only. The double tap guards against a finger landing on an option
// while scrolling; a pointer does not have that problem, and a second click
// on a desktop just reads as a stuck button. The setting is synced, so it
// still means something on desktop — it controls your phone — but it never
// applies to the device you are pointing a mouse at. "Touch" is the app on
// iOS/Android, or a browser whose primary pointer is coarse (a phone or
// tablet), never a UA guess: see utils/isTouchWeb.ts.
const DOUBLE_TAP_TIMEOUT_MS = 2000;
const TOUCH_DEVICE = Platform.OS !== 'web' || isTouchWeb;

export function useDoubleTap() {
    const enabled = !!useSetting('joy__doubleTapEnabled') && TOUCH_DEVICE;
    const [armedKey, setArmedKey] = React.useState<string | null>(null);
    const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

    const requireDoubleTap = React.useCallback((key: string, action: () => void) => {
        if (!enabled) {
            action();
            return;
        }
        if (timerRef.current) clearTimeout(timerRef.current);
        if (armedKey === key) {
            setArmedKey(null);
            action();
        } else {
            setArmedKey(key);
            timerRef.current = setTimeout(() => setArmedKey(null), DOUBLE_TAP_TIMEOUT_MS);
        }
    }, [enabled, armedKey]);

    React.useEffect(() => () => {
        if (timerRef.current) clearTimeout(timerRef.current);
    }, []);

    return { enabled, armedKey, requireDoubleTap };
}
