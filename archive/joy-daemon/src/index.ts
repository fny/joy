/**
 * joy-daemon — entry.
 *
 * Lifecycle:
 *   1. Acquire machine singleton (bindSingleton — pidfile + control socket).
 *   2. Load credentials, open RelayClient.
 *   3. Start SessionManager; accept session.start over the control channel.
 *   4. On shutdown signals: stop all sessions, close relay, release singleton.
 */
import { logger } from './util/log';
import { bindSingleton, releaseSingleton, PROTOCOL_VERSION } from './singleton';
import { newDaemonId } from './lease';
import { ControlServer } from './control/server';
import { SessionManager } from './sessionManager';
import { loadCredentials } from './relay/credentials';
import { RelayClient } from './relay/relayClient';

const log = logger('daemon');

export * as Protocol from './protocol';
export * from './control/protocol';

export async function main(): Promise<void> {
    log.info('starting', { pid: process.pid, protocolVersion: PROTOCOL_VERSION });

    const creds = loadCredentials();
    const relay = new RelayClient(creds);
    const sessions = new SessionManager(relay);
    const daemonId = newDaemonId();

    const control = new ControlServer({
        sessionManager: sessions,
        relay,
        daemonId,
        daemonPid: process.pid,
    });

    const server = await bindSingleton((sock) => control.accept(sock));

    const shutdown = async (reason: string) => {
        log.info('shutting down', { reason });
        try {
            await sessions.stopAll(reason);
            relay.close();
            await new Promise<void>((resolve) => server.close(() => resolve()));
            releaseSingleton();
        } catch (e) {
            log.error('shutdown error', { e: String(e) });
        }
        process.exit(0);
    };
    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));

    log.info('ready', { daemonId, sockPath: server.address() });
    // Daemon runs until shutdown signal.
    await new Promise(() => undefined);
}
