/**
 * Control-channel client. Talks to a running joy-daemon over its Unix domain
 * socket (named pipe on Windows). Newline-delimited JSON; hello/welcome
 * handshake then typed CtlRequest/CtlResponse.
 */
import { randomUUID } from 'node:crypto';
import { connect, type Socket } from 'node:net';
import {
    CONTROL_PROTOCOL_VERSION,
    type CtlOk,
    type CtlErr,
    type CtlNotification,
    type CtlRequest,
    type Hello,
    type Welcome,
} from 'joy-daemon/src/control/protocol';
import { controlSocketPath } from 'joy-daemon/src/util/paths';

export type ResponseListener = (n: CtlNotification) => void;

export interface ConnectResult {
    daemonProtocolVersion: number;
    daemonId: string;
    daemonPid: number;
}

export class ControlClient {
    private sock: Socket | null = null;
    private buf = '';
    private pending = new Map<string, (r: CtlOk | CtlErr) => void>();
    private notifs = new Set<ResponseListener>();
    private welcomePromise: Promise<ConnectResult> | null = null;

    async connect(): Promise<ConnectResult> {
        if (this.welcomePromise) return this.welcomePromise;
        this.welcomePromise = new Promise<ConnectResult>((resolve, reject) => {
            const s = connect(controlSocketPath());
            this.sock = s;
            s.setEncoding('utf8');
            s.on('data', (c: string) => this.onData(c, resolve));
            s.on('error', (e) => reject(e));
            s.on('close', () => {
                for (const r of this.pending.values()) r({ requestId: '', ok: false, error: { code: 'closed', message: 'control socket closed' } });
                this.pending.clear();
            });
            const hello: Hello = { type: 'hello', clientProtocolVersion: CONTROL_PROTOCOL_VERSION };
            s.write(JSON.stringify(hello) + '\n');
        });
        return this.welcomePromise;
    }

    private onData(chunk: string, resolveWelcome: (v: ConnectResult) => void): void {
        this.buf += chunk;
        let idx: number;
        while ((idx = this.buf.indexOf('\n')) >= 0) {
            const line = this.buf.slice(0, idx);
            this.buf = this.buf.slice(idx + 1);
            if (!line.trim()) continue;
            let v: unknown;
            try { v = JSON.parse(line); } catch { continue; }
            if (isWelcome(v)) {
                resolveWelcome({ daemonProtocolVersion: v.daemonProtocolVersion, daemonId: v.daemonId, daemonPid: v.daemonPid });
                continue;
            }
            if (isNotification(v)) {
                for (const l of this.notifs) try { l(v); } catch { /* ignore */ }
                continue;
            }
            if (isResponse(v)) {
                const r = this.pending.get(v.requestId);
                if (r) {
                    this.pending.delete(v.requestId);
                    r(v);
                }
                continue;
            }
        }
    }

    onNotification(cb: ResponseListener): () => void {
        this.notifs.add(cb);
        return () => this.notifs.delete(cb);
    }

    request<R>(method: string, params: unknown = {}): Promise<R> {
        return new Promise((resolve, reject) => {
            if (!this.sock || this.sock.destroyed) return reject(new Error('not connected'));
            const requestId = randomUUID();
            this.pending.set(requestId, (r) => {
                if (r.ok) resolve(r.result as R);
                else reject(new Error(`${r.error.code}: ${r.error.message}`));
            });
            const req: CtlRequest = { requestId, method, params };
            this.sock.write(JSON.stringify(req) + '\n');
        });
    }

    close(): void {
        this.sock?.end();
        this.sock = null;
    }
}

function isWelcome(v: unknown): v is Welcome {
    return typeof v === 'object' && v !== null && (v as { type?: string }).type === 'welcome';
}
function isNotification(v: unknown): v is CtlNotification {
    return typeof v === 'object' && v !== null && (v as { event?: boolean }).event === true;
}
function isResponse(v: unknown): v is CtlOk | CtlErr {
    return typeof v === 'object' && v !== null && typeof (v as { requestId?: string }).requestId === 'string' && 'ok' in (v as object);
}
