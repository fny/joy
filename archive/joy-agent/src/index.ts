/**
 * joy-agent — entry. One process per session, supervised by joy-daemon.
 *
 * Communicates with the daemon over stdio JSON (see ./link.ts). Picks a
 * backend per session (Claude is first; Codex/ACP/Gemini wrappers can be
 * added behind the seam). Drives the turn state machine and the cancel
 * ladder; emits §9 events upstream.
 *
 * Environment:
 *   JOY_SESSION_ID — set by joy-daemon when spawning this process.
 *   JOY_AGENT_BACKEND — 'claude' (default) | 'codex' | 'acp' | 'gemini'
 *   JOY_CWD — working directory for the agent (defaults to process.cwd())
 */
import { stdioLink, type Link, type AgentDown } from './link';
import { ClaudeBackend } from './backends/claude';
import type { AnyEvent } from 'joy-daemon/src/protocol';
import { runLadder } from './cancelLadder';

export type { AgentBackend, AgentUp, EphemeralPartial, TurnStart } from './seam';

export async function main(): Promise<void> {
    const link: Link = stdioLink();
    const log = (level: 'debug' | 'info' | 'warn' | 'error', msg: string, ctx?: unknown) =>
        link.up({ kind: 'log', level, msg, ctx });

    const emit = (event: AnyEvent) => link.up({ kind: 'event', event });
    const partial = (messageId: string, deltaText: string) => link.up({ kind: 'partial', messageId, deltaText });
    const heartbeat = (turnId: string, hbCounter: number) => link.up({ kind: 'heartbeat', turnId, hbCounter });

    let backend: ClaudeBackend | null = null;
    let initialized = false;

    link.onDown((m: AgentDown) => {
        if (m.kind === 'init') {
            if (initialized) return;
            initialized = true;
            backend = new ClaudeBackend({
                sessionId: m.sessionId,
                cwd: process.env.JOY_CWD ?? process.cwd(),
                anchor: m.turnAnchor?.messageId ?? null,
                emit,
                partial,
                heartbeat,
            });
            backend.start();
            log('info', 'joy-agent ready', { sessionId: m.sessionId, backend: process.env.JOY_AGENT_BACKEND ?? 'claude' });
            return;
        }
        if (m.kind === 'input') {
            if (!backend) return;
            const ev = m.event;
            switch (ev.type) {
                case 'user-message': {
                    const text = typeof ev.payload.content === 'string' ? ev.payload.content : JSON.stringify(ev.payload.content);
                    backend.pushUserMessage(text, ev.payload.messageId);
                    return;
                }
                case 'steer': {
                    const text = typeof ev.payload.content === 'string' ? ev.payload.content : JSON.stringify(ev.payload.content);
                    backend.pushSteer(text);
                    return;
                }
                case 'cancel':
                case 'interrupt': {
                    if (!backend) return;
                    const live = backend.liveTaskIds();
                    void runLadder({ stopper: backend.stopper(), liveTaskIds: live });
                    return;
                }
                case 'permission-response': {
                    // The backend's MCP/permission handler picks this up from the
                    // daemon-side resolution; the agent does not consult it
                    // directly in v1 (joy-daemon owns the permission lifecycle
                    // and forwards the resolved answer to the SDK callback).
                    return;
                }
                case 'mode-change':
                    // Future: forward to setPermissionMode/setModel on the Query.
                    return;
                default:
                    return;
            }
        }
        if (m.kind === 'shutdown') {
            // The daemon expects us to exit; closing stdin will end consumption.
            link.close();
            process.exit(0);
        }
    });
}
