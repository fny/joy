/**
 * AgentHost — spawns and supervises one joy-agent process per session (1:1).
 *
 * Channel to joy-agent is stdio JSON: newline-delimited JSON objects on
 * stdin (down: input events) and stdout (up: typed messages — either
 * a wire `event` to append, or an ephemeral `partial`, or a `heartbeat-hint`).
 *
 * Down messages (daemon → agent):
 *   { kind: 'init',  sessionId, turnAnchor?: { messageId } }
 *   { kind: 'input', event: AnyEvent }   // user-message/steer/cancel/interrupt/mode-change/permission-response
 *   { kind: 'shutdown' }
 *
 * Up messages (agent → daemon):
 *   { kind: 'event',   event: AnyEvent }       // becomes an envelope appended to the log
 *   { kind: 'partial', messageId, deltaText }  // ephemeral; daemon may broadcast as a poke side-channel
 *   { kind: 'heartbeat', turnId, hbCounter }   // daemon emits a `heartbeat` event on its behalf
 *   { kind: 'log', level, msg, ctx? }
 *
 * Crash policy:
 *  - On unexpected exit, the supervisor calls back with `{reason:'crash'}`.
 *    The caller (Session) is responsible for §18 recovery (emit
 *    `turn-interrupted{reason:'crash'}` for any non-terminal running turn,
 *    cursor-discipline guards on restart).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { logger } from './util/log';
import type { AnyEvent } from './protocol/events';

const log = logger('agentHost');

export interface AgentInputInit {
    kind: 'init';
    sessionId: string;
    turnAnchor?: { messageId: string };
}
export interface AgentInputEvent {
    kind: 'input';
    event: AnyEvent;
}
export interface AgentInputShutdown {
    kind: 'shutdown';
}
export type AgentDown = AgentInputInit | AgentInputEvent | AgentInputShutdown;

export interface AgentUpEvent {
    kind: 'event';
    event: AnyEvent;
}
export interface AgentUpPartial {
    kind: 'partial';
    messageId: string;
    deltaText: string;
}
export interface AgentUpHeartbeat {
    kind: 'heartbeat';
    turnId: string;
    hbCounter: number;
}
export interface AgentUpLog {
    kind: 'log';
    level: 'debug' | 'info' | 'warn' | 'error';
    msg: string;
    ctx?: unknown;
}
export type AgentUp = AgentUpEvent | AgentUpPartial | AgentUpHeartbeat | AgentUpLog;

export interface AgentHostOpts {
    sessionId: string;
    /** Absolute path to the joy-agent entry shim (bin/joy-agent.mjs). */
    agentBin: string;
    /** Extra args to pass to the agent process. */
    args?: string[];
    env?: Record<string, string>;
    onUp: (m: AgentUp) => void;
    onExit: (exit: { code: number | null; signal: NodeJS.Signals | null; reason: 'clean' | 'crash' }) => void;
}

export class AgentHost {
    private child: ChildProcess | null = null;
    private stdoutBuf = '';
    private readonly opts: AgentHostOpts;

    constructor(opts: AgentHostOpts) {
        this.opts = opts;
    }

    start(initial: AgentInputInit): void {
        if (this.child) return;
        const env = { ...process.env, ...this.opts.env, JOY_SESSION_ID: this.opts.sessionId };
        const c = spawn(process.execPath, [this.opts.agentBin, ...(this.opts.args ?? [])], {
            stdio: ['pipe', 'pipe', 'pipe'],
            env,
        });
        this.child = c;
        c.stdout!.setEncoding('utf8');
        c.stdout!.on('data', (chunk: string) => this.onStdout(chunk));
        c.stderr!.setEncoding('utf8');
        c.stderr!.on('data', (chunk: string) => log.debug('agent stderr', { sessionId: this.opts.sessionId, line: chunk.trim() }));
        c.on('exit', (code, signal) => {
            const reason: 'clean' | 'crash' = code === 0 ? 'clean' : 'crash';
            log.info('agent exited', { sessionId: this.opts.sessionId, code, signal, reason });
            this.child = null;
            this.opts.onExit({ code, signal, reason });
        });
        c.on('error', (e) => {
            log.error('agent spawn error', { sessionId: this.opts.sessionId, e: String(e) });
        });
        this.send(initial);
    }

    send(m: AgentDown): void {
        if (!this.child?.stdin || this.child.stdin.destroyed) return;
        this.child.stdin.write(JSON.stringify(m) + '\n');
    }

    async stop(timeoutMs = 5_000): Promise<void> {
        const c = this.child;
        if (!c) return;
        this.send({ kind: 'shutdown' });
        const exited = new Promise<void>((resolve) => c.once('exit', () => resolve()));
        const timer = setTimeout(() => {
            try { c.kill('SIGTERM'); } catch { /* ok */ }
            setTimeout(() => { try { c.kill('SIGKILL'); } catch { /* ok */ } }, 2_000);
        }, timeoutMs);
        await exited;
        clearTimeout(timer);
    }

    private onStdout(chunk: string): void {
        this.stdoutBuf += chunk;
        let idx: number;
        while ((idx = this.stdoutBuf.indexOf('\n')) >= 0) {
            const line = this.stdoutBuf.slice(0, idx);
            this.stdoutBuf = this.stdoutBuf.slice(idx + 1);
            if (!line.trim()) continue;
            try {
                const m = JSON.parse(line) as AgentUp;
                this.opts.onUp(m);
            } catch (e) {
                log.warn('agent stdout: bad JSON line', { line, e: String(e) });
            }
        }
    }
}
