/**
 * OS-conventional paths for joy-daemon state.
 *  - data dir:    ${JOY_HOME:-~/.joy}
 *  - run dir:     ${JOY_HOME:-~/.joy}/run         (pidfile + control socket)
 *  - sessions:    ${JOY_HOME:-~/.joy}/sessions/<id>   (outbox, cursor)
 */
import { homedir } from 'node:os';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export function joyHome(): string {
    return process.env.JOY_HOME ?? join(homedir(), '.joy');
}

export function runDir(): string {
    const d = join(joyHome(), 'run');
    mkdirSync(d, { recursive: true });
    return d;
}

export function pidFilePath(): string {
    return join(runDir(), 'daemon.pid');
}

export function controlSocketPath(): string {
    // Unix domain socket. On Windows this is replaced with a named pipe.
    if (process.platform === 'win32') {
        return '\\\\.\\pipe\\joy-daemon';
    }
    return join(runDir(), 'control.sock');
}

export function sessionDir(sessionId: string): string {
    const d = join(joyHome(), 'sessions', sessionId);
    mkdirSync(d, { recursive: true });
    return d;
}
