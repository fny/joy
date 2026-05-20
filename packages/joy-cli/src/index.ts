/**
 * joy — operator entrypoint.
 *
 *   joy daemon status | start | stop
 *   joy session list
 *   joy session start [--cwd=DIR]
 *   joy session stop  <sessionId>
 *   joy send          <sessionId> <text...>
 *   joy steer         <sessionId> <turnId> <text...>
 *   joy cancel        <sessionId> [turnId|*]
 *   joy projection    <sessionId>
 *
 * joy-cli is a thin control-client for joy-daemon. It is not an agent and
 * never connects to the relay directly. See docs/joy-cli-spec.md.
 */
import { Command } from 'commander';
import {
    daemonStatus,
    daemonStart,
    daemonStop,
} from './commands/daemon';
import {
    sessionList,
    sessionStart,
    sessionStop,
    sessionSend,
    sessionCancel,
    sessionSteer,
    sessionProjection,
} from './commands/session';

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
    const program = new Command();
    program.name('joy').description('joy: control client for joy-daemon').version('0.0.0');

    const d = program.command('daemon').description('Daemon lifecycle');
    d.command('status').action(async () => { await daemonStatus(); });
    d.command('start').action(async () => { await daemonStart(); });
    d.command('stop').action(async () => { await daemonStop(); });

    const s = program.command('session').description('Session operations');
    s.command('list').action(async () => { await sessionList(); });
    s.command('start')
        .option('--cwd <dir>', 'Working directory for the agent')
        .option('--session-id <id>', 'Adopt an existing sessionId (key auto-loaded from ~/.happy if present)')
        .option('--session-key <b64>', 'Per-session encryption key (base64), 32 bytes')
        .option('--variant <v>', "Encryption variant: 'legacy' or 'dataKey'")
        .action(async (o: { cwd?: string; sessionId?: string; sessionKey?: string; variant?: string }) => {
            const variant = o.variant === 'legacy' || o.variant === 'dataKey' ? o.variant : undefined;
            await sessionStart({ cwd: o.cwd, sessionId: o.sessionId, sessionKeyB64: o.sessionKey, variant });
        });
    s.command('stop <sessionId>').option('--reason <r>').action(async (sessionId: string, o: { reason?: string }) => { await sessionStop(sessionId, o.reason); });

    program
        .command('send <sessionId> <text...>')
        .description('Append a user-message to a session')
        .action(async (sessionId: string, text: string[]) => { await sessionSend(sessionId, text.join(' ')); });

    program
        .command('steer <sessionId> <turnId> <text...>')
        .description('Append a steer (mid-turn input) to a running turn')
        .action(async (sessionId: string, turnId: string, text: string[]) => { await sessionSteer(sessionId, turnId, text.join(' ')); });

    program
        .command('cancel <sessionId> [target]')
        .description('Cancel a session (turn id, or "*"/omitted to cancel current + drain)')
        .action(async (sessionId: string, target?: string) => { await sessionCancel(sessionId, target); });

    program
        .command('projection <sessionId>')
        .description('Print the daemon-folded projection for a session')
        .action(async (sessionId: string) => { await sessionProjection(sessionId); });

    await program.parseAsync(['node', 'joy', ...argv]);
}
