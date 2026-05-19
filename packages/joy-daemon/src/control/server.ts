/**
 * Local control-channel server (the daemon side). One server, many clients.
 *
 * Each client connection performs a hello/welcome handshake (protocol-version
 * gated), then sends CtlRequests; the server responds. The server may also
 * push CtlNotifications (e.g. projection updates while a client is "tail"ing).
 */
import { type Socket } from 'node:net';
import { logger } from '../util/log';
import { PROTOCOL_VERSION } from '../singleton';
import {
    CONTROL_PROTOCOL_VERSION,
    type CtlNotification,
    type CtlOk,
    type CtlErr,
    type CtlRequest,
    type DaemonStatusResult,
    type SessionStartParams,
    type SessionStopParams,
    type AttachInputParams,
    type AttachInputResult,
    type ProjectionGetResult,
    type SessionStartResult,
    type Welcome,
    type Hello,
} from './protocol';
import { b64decode } from '../relay/encryption';
import type { SessionManager } from '../sessionManager';
import { AnyEventSchema, type AnyEvent } from '../protocol/events';

const log = logger('control');

export interface ControlServerOpts {
    sessionManager: SessionManager;
    daemonId: string;
    daemonPid: number;
}

export class ControlServer {
    private clients = new Set<Client>();
    private readonly opts: ControlServerOpts;

    constructor(opts: ControlServerOpts) {
        this.opts = opts;
    }

    accept(sock: Socket): void {
        const c = new Client(sock, this);
        this.clients.add(c);
        sock.on('close', () => this.clients.delete(c));
    }

    broadcast(name: string, payload: unknown): void {
        const n: CtlNotification = { event: true, name, payload };
        for (const c of this.clients) c.write(n);
    }

    async dispatch(req: CtlRequest): Promise<CtlOk | CtlErr> {
        const err = (code: string, message: string): CtlErr => ({ requestId: req.requestId, ok: false, error: { code, message } });
        try {
            switch (req.method) {
                case 'daemon.status': {
                    const r: DaemonStatusResult = {
                        daemonId: this.opts.daemonId,
                        pid: this.opts.daemonPid,
                        protocolVersion: PROTOCOL_VERSION,
                        startedAt: Date.now(),
                        sessions: this.opts.sessionManager.list(),
                    };
                    return { requestId: req.requestId, ok: true, result: r };
                }
                case 'session.list':
                    return { requestId: req.requestId, ok: true, result: { sessions: this.opts.sessionManager.list() } };
                case 'session.start': {
                    const p = req.params as SessionStartParams;
                    if (!p?.sessionId || !p?.sessionKeyB64 || !p?.variant || !p?.agentBin) {
                        return err('invalid-params', 'session.start requires sessionId, sessionKeyB64, variant, agentBin');
                    }
                    const s = await this.opts.sessionManager.start({
                        sessionId: p.sessionId,
                        sessionKey: b64decode(p.sessionKeyB64),
                        variant: p.variant,
                        agentBin: p.agentBin,
                        agentArgs: p.agentArgs,
                        agentEnv: p.agentEnv,
                    });
                    const r: SessionStartResult = { sessionId: s.sessionId, daemonId: s.daemonId };
                    return { requestId: req.requestId, ok: true, result: r };
                }
                case 'session.stop': {
                    const p = req.params as SessionStopParams;
                    await this.opts.sessionManager.stop(p.sessionId, p.reason ?? 'cli-stop');
                    return { requestId: req.requestId, ok: true, result: { sessionId: p.sessionId } };
                }
                case 'session.attachInput': {
                    const p = req.params as AttachInputParams;
                    const parsed = AnyEventSchema.safeParse(p.event);
                    if (!parsed.success) return err('invalid-event', 'attachInput: event failed validation');
                    const eventId = this.opts.sessionManager.attachInput(p.sessionId, parsed.data satisfies AnyEvent);
                    if (!eventId) return err('no-such-session', `session ${p.sessionId} not hosted`);
                    const r: AttachInputResult = { eventId };
                    return { requestId: req.requestId, ok: true, result: r };
                }
                case 'session.projection': {
                    const p = req.params as { sessionId: string };
                    const proj = this.opts.sessionManager.getProjection(p.sessionId);
                    if (!proj) return err('no-such-session', `session ${p.sessionId} not hosted`);
                    const r: ProjectionGetResult = { sessionId: p.sessionId, projection: proj };
                    return { requestId: req.requestId, ok: true, result: r };
                }
                default:
                    return err('unknown-method', `unknown method '${req.method}'`);
            }
        } catch (e) {
            log.error('dispatch threw', { method: req.method, e: String(e) });
            return err('internal', String(e));
        }
    }
}

class Client {
    private buf = '';
    private welcomed = false;
    constructor(private sock: Socket, private srv: ControlServer) {
        sock.setEncoding('utf8');
        sock.on('data', (chunk: string) => this.onData(chunk));
        sock.on('error', (e) => log.debug('client socket error', { e: String(e) }));
    }

    write(obj: unknown): void {
        if (this.sock.destroyed) return;
        this.sock.write(JSON.stringify(obj) + '\n');
    }

    private async onData(chunk: string): Promise<void> {
        this.buf += chunk;
        let idx: number;
        while ((idx = this.buf.indexOf('\n')) >= 0) {
            const line = this.buf.slice(0, idx);
            this.buf = this.buf.slice(idx + 1);
            if (!line.trim()) continue;
            let frame: unknown;
            try { frame = JSON.parse(line); } catch { continue; }
            if (!this.welcomed) {
                if (isHello(frame)) {
                    if (frame.clientProtocolVersion !== CONTROL_PROTOCOL_VERSION) {
                        // Reject mismatched clients; they should restart the daemon
                        // or upgrade.
                        const e: CtlErr = { requestId: 'hello', ok: false, error: { code: 'version-mismatch', message: `client v${frame.clientProtocolVersion} != daemon v${CONTROL_PROTOCOL_VERSION}` } };
                        this.write(e);
                        this.sock.end();
                        return;
                    }
                    const welcome: Welcome = { type: 'welcome', daemonProtocolVersion: CONTROL_PROTOCOL_VERSION, daemonId: '__daemon__', daemonPid: process.pid };
                    this.write(welcome);
                    this.welcomed = true;
                    continue;
                }
                continue; // ignore anything else until hello
            }
            if (isRequest(frame)) {
                const res = await (this.srv as unknown as { dispatch: (r: CtlRequest) => Promise<CtlOk | CtlErr> }).dispatch(frame);
                this.write(res);
            }
        }
    }
}

function isHello(v: unknown): v is Hello {
    return typeof v === 'object' && v !== null && (v as { type?: string }).type === 'hello';
}
function isRequest(v: unknown): v is CtlRequest {
    return typeof v === 'object' && v !== null && typeof (v as { requestId?: string }).requestId === 'string' && typeof (v as { method?: string }).method === 'string';
}
