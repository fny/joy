/**
 * Which status line the home header shows, kept pure for tests.
 *
 * The condensed machine count ("1/1 connected") is derived from CACHED
 * machine records, so it kept showing green after the relay connection was
 * lost (#222). The transport state therefore wins whenever it is not healthy:
 * disconnected / connecting / error are shown as such, and the machine count
 * is only presented as current while the relay connection is 'connected'.
 */

export type SocketStatusKind = 'connected' | 'connecting' | 'disconnected' | 'error' | (string & {});

export type HomeHeaderStatusSource =
    | { kind: 'machines'; online: number; total: number }
    | { kind: 'socket'; status: SocketStatusKind };

export function pickHomeHeaderStatus(
    socketStatus: SocketStatusKind,
    machines: ReadonlyArray<{ active: boolean }>,
): HomeHeaderStatusSource {
    if (socketStatus !== 'connected' || machines.length === 0) {
        return { kind: 'socket', status: socketStatus };
    }
    return {
        kind: 'machines',
        total: machines.length,
        online: machines.filter((m) => m.active).length,
    };
}
