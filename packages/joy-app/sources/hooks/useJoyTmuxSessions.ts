// Polls the joy-tmux server for sessions; provides create and kill actions.
import * as React from 'react';
import type { JoySession } from '@/joy/types';
import { useActiveInterval } from './useActiveInterval';

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

    // Poll only while focused AND foregrounded (battery — see useActiveInterval).
    useActiveInterval(refresh, POLL_INTERVAL_MS);

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

    const fetchPane = React.useCallback(async (id: string): Promise<string> => {
        const res = await fetch(`${normalizedUrl}/sessions/${encodeURIComponent(id)}/pane`, {
            signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json() as { ok: boolean; text: string };
        return data.text ?? '';
    }, [normalizedUrl]);

    return { sessions, loading, error, refresh, createSession, killSession, fetchPane };
}
