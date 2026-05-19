/**
 * Link to joy-daemon — stdio JSON channel.
 *
 * Wire matches joy-daemon/agentHost.ts:
 *   Down (daemon → agent): {kind:'init'|'input'|'shutdown', ...}
 *   Up   (agent → daemon): {kind:'event'|'partial'|'heartbeat'|'log', ...}
 */
import { Buffer } from 'node:buffer';
import type { AnyEvent } from 'joy-daemon/src/protocol';

export interface AgentInputInit { kind: 'init'; sessionId: string; turnAnchor?: { messageId: string }; }
export interface AgentInputEvent { kind: 'input'; event: AnyEvent; }
export interface AgentInputShutdown { kind: 'shutdown'; }
export type AgentDown = AgentInputInit | AgentInputEvent | AgentInputShutdown;

export interface AgentUpEvent { kind: 'event'; event: AnyEvent; }
export interface AgentUpPartial { kind: 'partial'; messageId: string; deltaText: string; }
export interface AgentUpHeartbeat { kind: 'heartbeat'; turnId: string; hbCounter: number; }
export interface AgentUpLog { kind: 'log'; level: 'debug' | 'info' | 'warn' | 'error'; msg: string; ctx?: unknown; }
export type AgentUp = AgentUpEvent | AgentUpPartial | AgentUpHeartbeat | AgentUpLog;

export interface Link {
    onDown(cb: (m: AgentDown) => void): () => void;
    up(m: AgentUp): void;
    close(): void;
}

/** Create the link bound to process stdin/stdout. */
export function stdioLink(): Link {
    const listeners = new Set<(m: AgentDown) => void>();
    let buf = '';
    process.stdin.setEncoding('utf8');
    const onData = (chunk: string | Buffer) => {
        buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        let idx: number;
        while ((idx = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, idx);
            buf = buf.slice(idx + 1);
            if (!line.trim()) continue;
            try {
                const m = JSON.parse(line) as AgentDown;
                for (const cb of listeners) try { cb(m); } catch { /* ignore */ }
            } catch {
                // ignore malformed
            }
        }
    };
    process.stdin.on('data', onData);

    return {
        onDown(cb) {
            listeners.add(cb);
            return () => listeners.delete(cb);
        },
        up(m) {
            process.stdout.write(JSON.stringify(m) + '\n');
        },
        close() {
            process.stdin.off('data', onData);
            listeners.clear();
        },
    };
}
