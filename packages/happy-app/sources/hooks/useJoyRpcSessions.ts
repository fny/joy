// Manages joy-tmux sessions via RPC through the relay.
// Mirrors useJoyTmuxSessions but uses machineRPC instead of direct HTTP.
import * as React from 'react';
import { useFocusEffect } from 'expo-router';
import { apiSocket } from '@/sync/apiSocket';
import { JoySession } from '@/hooks/useJoyTmuxSessions';

export type { JoySession };

const POLL_INTERVAL_MS = 5000;

export function useJoyRpcSessions(machineId: string | null) {
    const [sessions, setSessions] = React.useState<JoySession[]>([]);
    const [loading, setLoading] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);
    const mountedRef = React.useRef(true);

    React.useEffect(() => {
        mountedRef.current = true;
        return () => { mountedRef.current = false; };
    }, []);

    const refresh = React.useCallback(async () => {
        if (!machineId) return;
        try {
            const result = await apiSocket.machineRPC<JoySession[], {}>(machineId, 'joy-list-sessions', {});
            if (mountedRef.current) {
                setSessions(Array.isArray(result) ? result : []);
                setError(null);
            }
        } catch (e) {
            if (mountedRef.current) setError(e instanceof Error ? e.message : String(e));
        }
    }, [machineId]);

    React.useEffect(() => {
        setSessions([]);
        if (!machineId) return;
        setLoading(true);
        refresh().finally(() => { if (mountedRef.current) setLoading(false); });
    }, [machineId, refresh]);

    useFocusEffect(React.useCallback(() => {
        if (!machineId) return;
        const id = setInterval(refresh, POLL_INTERVAL_MS);
        return () => clearInterval(id);
    }, [machineId, refresh]));

    const createSession = React.useCallback(async (cwd: string) => {
        if (!machineId) throw new Error('no machine selected');
        await apiSocket.machineRPC(machineId, 'joy-create-session', { cwd });
        await refresh();
    }, [machineId, refresh]);

    const killSession = React.useCallback(async (id: string) => {
        if (!machineId) throw new Error('no machine selected');
        await apiSocket.machineRPC(machineId, 'joy-kill-session', { id });
        await refresh();
    }, [machineId, refresh]);

    const fetchPane = React.useCallback(async (id: string): Promise<string> => {
        if (!machineId) throw new Error('no machine selected');
        const result = await apiSocket.machineRPC<{ ok: boolean; text: string }, { id: string }>(
            machineId, 'joy-pane', { id }
        );
        return result.text ?? '';
    }, [machineId]);

    return { sessions, loading, error, refresh, createSession, killSession, fetchPane };
}
