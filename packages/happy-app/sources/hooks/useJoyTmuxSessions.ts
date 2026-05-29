// Polls the joy-tmux server for sessions; provides create and kill actions.
import * as React from 'react';
import { useFocusEffect } from 'expo-router';

export interface JoySession {
    id: string;
    cwd: string;
    status: 'starting' | 'active' | 'ended';
    relay_session_id?: string;
    claude_session_id?: string;
    started_at: number;
    tmux_window: string;
}

const POLL_INTERVAL_MS = 5000;

export function useJoyTmuxSessions(serverUrl: string) {
    const [sessions, setSessions] = React.useState<JoySession[]>([]);
    const [loading, setLoading] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);
    const mountedRef = React.useRef(true);

    const normalizedUrl = serverUrl.replace(/\/$/, '');

    const refresh = React.useCallback(async () => {
        try {
            const res = await fetch(`${normalizedUrl}/sessions`, {
                signal: AbortSignal.timeout(5000),
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json() as JoySession[];
            if (mountedRef.current) {
                setSessions(data);
                setError(null);
            }
        } catch (e) {
            if (mountedRef.current) {
                setError(e instanceof Error ? e.message : String(e));
            }
        }
    }, [normalizedUrl]);

    React.useEffect(() => {
        mountedRef.current = true;
        return () => { mountedRef.current = false; };
    }, []);

    React.useEffect(() => {
        setLoading(true);
        refresh().finally(() => {
            if (mountedRef.current) setLoading(false);
        });
    }, [refresh]);

    useFocusEffect(React.useCallback(() => {
        const id = setInterval(refresh, POLL_INTERVAL_MS);
        return () => clearInterval(id);
    }, [refresh]));

    const createSession = React.useCallback(async (cwd: string) => {
        const res = await fetch(`${normalizedUrl}/sessions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cwd }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        await refresh();
    }, [normalizedUrl, refresh]);

    const killSession = React.useCallback(async (id: string) => {
        const res = await fetch(`${normalizedUrl}/sessions/${encodeURIComponent(id)}`, {
            method: 'DELETE',
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        await refresh();
    }, [normalizedUrl, refresh]);

    return { sessions, loading, error, refresh, createSession, killSession };
}
