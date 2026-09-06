// Manages joy-tmux sessions via RPC through the relay.
// Mirrors useJoyTmuxSessions but uses machineRPC instead of direct HTTP.
import * as React from 'react';
import { machineListSessions } from '@/sync/v2/machine';
import type { JoySession } from '@/joy/types';
import { useActiveInterval } from './useActiveInterval';
import { sync } from '@/sync/sync';
import { v2SpawnAndWait } from '@/sync/v2/spawn';
import { machineKillSession, machinePane } from '@/sync/v2/machine';
import { isLatest, nextGen, retire, useLatestKey } from '@/utils/latest';

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

export type LatestResult<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Latest-wins refresh: mints a request generation on `key` and hands the
 * outcome to `commit` only while it is still the newest request. A list from
 * an earlier poll (or an earlier machine) that lands after a newer one is
 * dropped instead of overwriting it. Resolves true when committed.
 */
export async function refreshLatest<T>(
    key: string,
    load: () => Promise<T>,
    commit: (result: LatestResult<T>) => void,
): Promise<boolean> {
    const gen = nextGen(key);
    let result: LatestResult<T>;
    try {
        result = { ok: true, value: await load() };
    } catch (e) {
        result = { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    if (!isLatest(key, gen)) return false;
    commit(result);
    return true;
}

export function useJoyRpcSessions(machineId: string | null) {
    const [sessions, setSessions] = React.useState<JoySession[]>([]);
    const [loading, setLoading] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);
    // Every list request (initial load, poll, after create/kill) is a
    // generation on this instance's key; only the newest may land. Retired
    // on unmount, so nothing lands on an unmounted hook either.
    const listKey = useLatestKey('joy-rpc-sessions');

    const refresh = React.useCallback(async () => {
        if (!machineId) return;
        await refreshLatest(listKey, async () => {
            const lctx = sync.machineOnlyCtx(machineId);
            if (!lctx) throw new Error('no machine context');
            const res = await machineListSessions(lctx);
            const list = res.data?.sessions;
            if (res.status !== 200 || !Array.isArray(list)) throw daemonError('list sessions', res);
            return list as unknown as JoySession[];
        }, (result) => {
            if (result.ok) {
                setSessions(result.value);
                setError(null);
            } else {
                // Keep the last good list; only the error changes.
                setError(result.error);
            }
        });
    }, [machineId, listKey]);

    React.useEffect(() => {
        retire(listKey); // the previous machine's in-flight list must not land here
        setSessions([]); // a different machine: its list is genuinely unknown
        setError(null);
        if (!machineId) return;
        let stale = false;
        setLoading(true);
        refresh().finally(() => { if (!stale) setLoading(false); });
        return () => { stale = true; };
    }, [machineId, refresh, listKey]);

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
