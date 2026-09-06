/**
 * The joy-daemon status of one machine for the machine page, read through
 * the shared probe resource (sync/machineResources.joyStatusSpec) — the same
 * entry the sessions settings screen observes — and folded into the page's
 * Daemon row (components/joyMachineDaemonState).
 *
 * The machine record can come from the local cache (so `online` is already
 * true) before the machine's data key has been decrypted; the resource is
 * `unavailable` for that window. Rather than latch "unreachable" for the life
 * of the page, the probe is re-ensured every CTX_RETRY_MS for up to
 * CTX_WAIT_MS, then gives up — the bounded wait the page always had, now on
 * top of the shared entry instead of a private fetch.
 */
import * as React from 'react';
import { resources } from '@/sync/resource';
import { joyStatusSpec, type JoyStatus } from '@/sync/machineResources';
import { resolveDaemonRowFromResource, type DaemonRow } from '@/components/joyMachineDaemonState';
import { useActiveInterval } from './useActiveInterval';
import { useResource, type ResourceView } from './useResource';

export const CTX_RETRY_MS = 500;
export const CTX_WAIT_MS = 10_000;

export interface DaemonStatusView {
    /** The shared probe entry (last good status, fetching, error, unavailable). */
    probe: ResourceView<JoyStatus>;
    /** What the Daemon group renders. */
    row: DaemonRow<JoyStatus>;
    /** The footer's failure text applies (offline, or the daemon did not answer). */
    failed: boolean;
}

export function useDaemonStatus(machineId: string, online: boolean): DaemonStatusView {
    const spec = React.useMemo(() => joyStatusSpec(machineId), [machineId]);
    const probe = useResource(spec, { enabled: online });

    // Waiting for the machine key: no value yet and the newest request could
    // not be made. Bounded so a key that never arrives ends as "unreachable".
    const waitingForContext = online && !probe.hasData && probe.unavailable !== null;
    const [contextTimedOut, setContextTimedOut] = React.useState(false);
    React.useEffect(() => {
        if (!waitingForContext) { setContextTimedOut(false); return; }
        const timer = setTimeout(() => setContextTimedOut(true), CTX_WAIT_MS);
        return () => clearTimeout(timer);
    }, [waitingForContext, machineId]);
    useActiveInterval(() => { void resources.ensure(spec); }, CTX_RETRY_MS, waitingForContext && !contextTimedOut);

    return React.useMemo(() => {
        const { failed, ...row } = resolveDaemonRowFromResource({ entry: probe, online, contextTimedOut });
        return { probe, row, failed };
    }, [probe, online, contextTimedOut]);
}
