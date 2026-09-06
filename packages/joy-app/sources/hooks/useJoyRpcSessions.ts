// Manages joy-tmux sessions via RPC through the relay.
// Mirrors useJoyTmuxSessions but uses machineRPC instead of direct HTTP.
import * as React from 'react';
import { machineListSessions } from '@/sync/v2/machine';
import type { JoySession } from '@/joy/types';
import { useActiveInterval } from './useActiveInterval';
import { sync } from '@/sync/sync';
import { v2SpawnAndWait } from '@/sync/v2/spawn';
import { machineKillSession, machinePane } from '@/sync/v2/machine';

const POLL_INTERVAL_MS = 5000;

// tunnelJson returns the daemon's HTTP status WITHOUT throwing, so every call
// here validates status + payload shape. Before this, a daemon 500 during a
// poll replaced the known session list with [] and cleared the error, made
// killSession "succeed", and made fetchPane return an empty terminal (#322).
function daemonError(op: string, res: { status: number; data: unknown }): Error {
    const body = res.data as { error?: unknown } | null;
    const detail = typeof body?.error === 'string' ? body.error : `HTTP ${res.status}`;
    return new Error(`${op} failed: ${detail}`);
}

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
            const lctx = sync.machineOnlyCtx(machineId);
            if (!lctx) throw new Error('no machine context');
            const res = await machineListSessions(lctx);
            const list = res.data?.sessions;
            if (res.status !== 200 || !Array.isArray(list)) throw daemonError('list sessions', res);
            if (mountedRef.current) {
                setSessions(list as unknown as JoySession[]);
                setError(null);
            }
        } catch (e) {
            // Keep the last good list; only the error changes.
            if (mountedRef.current) setError(e instanceof Error ? e.message : String(e));
        }
    }, [machineId]);

    React.useEffect(() => {
        setSessions([]); // a different machine: its list is genuinely unknown
        setError(null);
        if (!machineId) return;
        setLoading(true);
        refresh().finally(() => { if (mountedRef.current) setLoading(false); });
    }, [machineId, refresh]);

    // Poll only while focused AND foregrounded (battery — see useActiveInterval).
    useActiveInterval(refresh, POLL_INTERVAL_MS, !!machineId);

    const createSession = React.useCallback(async (cwd: string) => {
        if (!machineId) throw new Error('no machine selected');
        await v2SpawnAndWait(machineId, { cwd });
        await refresh();
    }, [machineId, refresh]);

    const killSession = React.useCallback(async (id: string) => {
        if (!machineId) throw new Error('no machine selected');
        const kctx = sync.machineCtxFor(machineId, id);
        if (!kctx) throw new Error('no machine context');
        const res = await machineKillSession(kctx);
        if (res.status !== 200 || !res.data?.ok) throw daemonError('kill session', res);
        await refresh();
    }, [machineId, refresh]);

    const fetchPane = React.useCallback(async (id: string): Promise<string> => {
        if (!machineId) throw new Error('no machine selected');
        const pctx = sync.machineCtxFor(machineId, id);
        if (!pctx) throw new Error('no machine context');
        const res = await machinePane(pctx);
        const text = res.data?.text;
        if (res.status !== 200 || res.data?.ok === false || typeof text !== 'string') throw daemonError('read pane', res);
        return text;
    }, [machineId]);

    return { sessions, loading, error, refresh, createSession, killSession, fetchPane };
}
