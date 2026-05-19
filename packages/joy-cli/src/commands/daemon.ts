import { ControlClient } from '../control/client';
import { ensureDaemon } from '../ensureDaemon';
import type { DaemonStatusResult } from 'joy-daemon/src/control/protocol';
import { readPidFile, processAlive } from 'joy-daemon/src/singleton';

export async function daemonStatus(): Promise<void> {
    const pf = readPidFile();
    if (!pf) {
        process.stdout.write('joy-daemon: not running\n');
        return;
    }
    if (!processAlive(pf.pid)) {
        process.stdout.write(`joy-daemon: stale pidfile (pid ${pf.pid} dead)\n`);
        return;
    }
    try {
        const c = new ControlClient();
        await c.connect();
        const r = await c.request<DaemonStatusResult>('daemon.status');
        c.close();
        process.stdout.write(JSON.stringify(r, null, 2) + '\n');
    } catch (e) {
        process.stdout.write(`joy-daemon: pid ${pf.pid} alive but unresponsive: ${String(e)}\n`);
    }
}

export async function daemonStart(): Promise<void> {
    const r = await ensureDaemon();
    process.stdout.write(`joy-daemon: ${r.started ? 'started' : 'already running'} pid=${r.connect.daemonPid}\n`);
}

export async function daemonStop(): Promise<void> {
    const pf = readPidFile();
    if (!pf || !processAlive(pf.pid)) {
        process.stdout.write('joy-daemon: not running\n');
        return;
    }
    try { process.kill(pf.pid, 'SIGTERM'); } catch (e) {
        process.stdout.write(`joy-daemon stop failed: ${String(e)}\n`);
        return;
    }
    process.stdout.write(`joy-daemon: SIGTERM sent to pid ${pf.pid}\n`);
}
