import { useEffect, useState } from 'react';
import { AppState, type AppStateStatus } from 'react-native';

export function useElapsedTime(date: Date | number | null | undefined): number {
    const [elapsedSeconds, setElapsedSeconds] = useState(0);

    useEffect(() => {
        // Handle null/undefined dates
        if (!date) {
            setElapsedSeconds(0);
            return;
        }

        // Convert to timestamp if Date object
        const timestamp = date instanceof Date ? date.getTime() : date;

        // Update function to calculate elapsed seconds
        const updateElapsed = () => {
            const now = Date.now();
            const elapsed = Math.max(0, Math.floor((now - timestamp) / 1000));
            setElapsedSeconds(elapsed);
        };

        // Tick every second — but only while the app is foregrounded. A
        // backgrounded/locked device doesn't need a 1s timer keeping the CPU
        // awake; recompute immediately on return so the value stays correct.
        let interval: ReturnType<typeof setInterval> | null = null;
        const start = () => {
            if (interval !== null) return;
            updateElapsed();
            interval = setInterval(updateElapsed, 1000);
        };
        const stop = () => {
            if (interval !== null) { clearInterval(interval); interval = null; }
        };

        if (AppState.currentState === 'active') start(); else updateElapsed();
        const sub = AppState.addEventListener('change', (s: AppStateStatus) => {
            if (s === 'active') start(); else stop();
        });

        return () => {
            stop();
            sub.remove();
        };
    }, [date]);

    return elapsedSeconds;
}