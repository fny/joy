import * as React from 'react';
import { useSetting } from '@/sync/storage';

// Mod 06 (`joy__doubleTapEnabled`) requires every commit-style press on
// LLM-presented choice options to be a deliberate double tap. The first tap
// arms a key; the second tap on the same key within DOUBLE_TAP_TIMEOUT_MS
// commits. Tapping a different key re-arms. After the timeout the arm is
// cleared automatically.
const DOUBLE_TAP_TIMEOUT_MS = 2000;

export function useDoubleTap() {
    const enabled = !!useSetting('joy__doubleTapEnabled');
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
