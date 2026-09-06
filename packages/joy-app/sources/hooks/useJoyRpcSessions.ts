// Manages joy-tmux sessions via RPC through the relay.
// The list is a RESOURCE keyed by machine (sync/machineResources): rendered
// from cache, polled while the screen is focused and foregrounded, and never
// overwritten by an older request or another machine's answer — request
// order per key decides what lands, not the mounted lifetime (#179, #322).
import * as React from 'react';
import type { JoySession } from '@/joy/types';
import { sync } from '@/sync/sync';
import { v2SpawnInteractive } from '@/sync/v2/spawn';
import { machineKillSession, machinePane } from '@/sync/v2/machine';
import { joySessionsSpec } from '@/sync/machineResources';
import { useResource } from './useResource';

const POLL_INTERVAL_MS = 5000;
const NO_SESSIONS: JoySession[] = [];

function daemonError(op: string, res: { status: number; data: unknown }): Error {
    const body = res.data as { error?: unknown } | null;
    const detail = typeof body?.error === 'string' ? body.error : `HTTP ${res.status}`;
    return new Error(`${op} failed: ${detail}`);
}

export function useJoyRpcSessions(machineId: string | null) {
    const spec = React.useMemo(() => (machineId ? joySessionsSpec(machineId) : null), [machineId]);
    // Poll only while focused AND foregrounded (battery — see useActiveInterval).
    const list = useResource(spec, { refetchInterval: POLL_INTERVAL_MS, refetchOnScreenFocus: 'always' });

    const refresh = React.useCallback(async () => { await list.refresh(); }, [list.refresh]);

    const createSession = React.useCallback(async (cwd: string) => {
        if (!machineId) throw new Error('no machine selected');
        // Interactive (#417): an unanswered creation offers a Retry that
        // re-drives this very action under the same creation intent, so the
        // relay replays rather than accepting a second session. A declined
        // retry (null) is a quiet bail, like a declined directory prompt.
        if (await v2SpawnInteractive(machineId, { cwd }) === null) return;
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

    return {
        // The last good list; a failed poll keeps it and only the error changes.
        sessions: list.data ?? NO_SESSIONS,
        loading: list.isLoading,
        error: list.error ?? list.unavailable,
        refresh,
        createSession,
        killSession,
        fetchPane,
    };
}
