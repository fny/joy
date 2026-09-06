/**
 * What the machine page's "Daemon" group shows, derived from the LAST probe,
 * WHICH machine it probed, and the machine's current connectivity.
 *
 * Before (#228) a successful probe was kept as-is when the machine went
 * offline or when the page switched machines: the row kept saying "running"
 * in green under a footer that said "Machine is offline", and a failed probe
 * on machine B still showed machine A's PID and version.
 */
export interface DaemonProbe<T> {
    /** The machine the probe was issued for. */
    machineId: string;
    status: T;
}

export interface DaemonRow<T> {
    /** The probe result to render, or null when it belongs to another machine
     *  or the machine is no longer online. */
    status: T | null;
    /** True only for a current-machine, successful probe while online. */
    running: boolean;
    detail: 'running' | 'unreachable' | 'offline';
    /** Nothing to show yet: a probe for this machine is still pending. */
    loading: boolean;
}

export function resolveDaemonRow<T extends { ok?: boolean }>(args: {
    probe: DaemonProbe<T> | null;
    machineId: string;
    online: boolean;
    failed: boolean;
}): DaemonRow<T> {
    const { probe, machineId, online, failed } = args;
    const current = probe && probe.machineId === machineId ? probe.status : null;
    if (!online) {
        return { status: null, running: false, detail: 'offline', loading: false };
    }
    if (current && current.ok) {
        return { status: current, running: true, detail: 'running', loading: false };
    }
    if (current || failed) {
        return { status: current, running: false, detail: 'unreachable', loading: false };
    }
    return { status: null, running: false, detail: 'unreachable', loading: true };
}

/**
 * How the environment section shows a failed key-list load (#227). Every
 * failure is a visible row with a Retry action — a timeout, an HTTP status or
 * an offline tunnel used to render nothing at all, and the Add row is NOT a
 * retry (it prompts first and reloads only after a successful change).
 *
 *  - `no_key`: the app has no machine key yet (`no_machine_key` from the
 *    daemon, or no machine context on this side) — the section is locked,
 *    but the key may still arrive, so the row stays tappable.
 *  - `failure`: anything else; `detail` is the raw reason for the subtitle.
 */
export type EnvErrorRow = { kind: 'no_key' } | { kind: 'failure'; detail: string };

export function resolveEnvErrorRow(error: string | null): EnvErrorRow | null {
    if (!error) return null;
    if (error === 'no_machine_key' || error === 'no_ctx') return { kind: 'no_key' };
    return { kind: 'failure', detail: error };
}
