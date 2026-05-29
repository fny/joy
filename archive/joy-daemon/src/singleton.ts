/**
 * Machine-scope daemon singleton — comm-layer-spec §4.4 (joy-daemon-spec §4.4).
 *
 * Implementation:
 *   - A pidfile at ${JOY_HOME}/run/daemon.pid that contains JSON
 *       { pid, protocolVersion, startedAt }
 *   - An open Unix domain socket / named pipe at controlSocketPath().
 *
 * Acquisition algorithm:
 *   1. Try to bind the control socket exclusively. If it succeeds we are the
 *      singleton and we write the pidfile. (The socket itself is the lock.)
 *   2. If bind fails (EADDRINUSE), peek at the existing pidfile and protocol
 *      version. The caller (joy-cli) decides whether to ask the existing
 *      daemon to replace itself (newer protocol) or to use it as-is.
 *
 * On startup we also clean up stale sockets when the recorded pid is dead.
 */
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { logger } from './util/log';
import { controlSocketPath, pidFilePath } from './util/paths';

const log = logger('singleton');

export const PROTOCOL_VERSION = 1;

export interface PidFile {
    pid: number;
    protocolVersion: number;
    startedAt: number;
}

export function readPidFile(): PidFile | null {
    const p = pidFilePath();
    if (!existsSync(p)) return null;
    try {
        return JSON.parse(readFileSync(p, 'utf8')) as PidFile;
    } catch {
        return null;
    }
}

export function processAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (e) {
        // ESRCH = no such process; EPERM = exists but not ours (treat as alive).
        return (e as NodeJS.ErrnoException).code === 'EPERM';
    }
}

/**
 * Try to become the singleton. Returns a control server bound to the socket on
 * success. Throws if another live daemon already holds the socket.
 */
export async function bindSingleton(onConnection: (s: Socket) => void): Promise<Server> {
    const sockPath = controlSocketPath();
    // Clean a stale socket if the prior daemon is dead.
    const prior = readPidFile();
    if (prior && !processAlive(prior.pid)) {
        try { unlinkSync(sockPath); } catch { /* ok */ }
    }
    return await new Promise<Server>((resolve, reject) => {
        const srv = createServer(onConnection);
        srv.once('error', (e: NodeJS.ErrnoException) => {
            if (e.code === 'EADDRINUSE') {
                reject(new Error('joy-daemon: another instance is already running'));
            } else {
                reject(e);
            }
        });
        srv.listen(sockPath, () => {
            const pf: PidFile = { pid: process.pid, protocolVersion: PROTOCOL_VERSION, startedAt: Date.now() };
            writeFileSync(pidFilePath(), JSON.stringify(pf));
            log.info('singleton bound', { sockPath, pid: process.pid, protocolVersion: PROTOCOL_VERSION });
            resolve(srv);
        });
    });
}

export function releaseSingleton(): void {
    const sockPath = controlSocketPath();
    try { unlinkSync(sockPath); } catch { /* ok */ }
    try { unlinkSync(pidFilePath()); } catch { /* ok */ }
}
