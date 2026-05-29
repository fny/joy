/**
 * Claude Agent SDK backend behind the agent-agnostic seam.
 *
 * Streaming-input mode: one persistent `query()` per session. We push every
 * inbound `user-message`/`steer` onto the SDK's async-iterable input. The
 * turn boundary is driven by `session_state_changed: idle` (NOT `result`),
 * per comm-layer-spec §17.
 *
 * SDK references (versions current to packages/happy-cli/node_modules):
 *   - query()                  sdk.d.ts:1856
 *   - SDKMessage union         sdk.d.ts:2467
 *   - SDKSessionStateChanged   sdk.d.ts:2702-2705
 *   - Query.interrupt()        sdk.d.ts:1674
 *   - Query.close()            sdk.d.ts:1853
 *   - stopTask(taskId)         ~sdk.d.ts:1841
 *
 * Implementation notes:
 *  - Outputs go through `shouldEmit` (SuppressMode) so SDK-replayed history
 *    on `resume` is dropped (§18 anchor-then-emit).
 *  - Partial deltas: when `includePartialMessages` is enabled the SDK emits
 *    `SDKPartialAssistantMessage`s; we surface those as ephemeral partials.
 *  - Background tasks: `task_started/progress/notification` map directly to
 *    `bg-*` events.
 */
import { randomUUID } from 'node:crypto';
import { query, type Query, type Options, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AnyEvent } from 'joy-daemon/src/protocol';
import { SuppressMode } from '../recovery';
import type { Stopper } from '../cancelLadder';
import { terminalFromClaudeResultIfError } from '../turnMachine';

export interface ClaudeBackendOpts {
    sessionId: string;
    cwd: string;
    /** SDK resume session id, if recovering. */
    resume?: string;
    /** Anchor: messageId of the last logged agent message; agent suppresses
     * replay up to and including this id. */
    anchor?: string | null;
    /** Emit a wire event upstream. */
    emit: (ev: AnyEvent) => void;
    /** Emit an ephemeral partial. */
    partial: (messageId: string, deltaText: string) => void;
    /** Emit a heartbeat hint (turnId, monotonic counter). */
    heartbeat: (turnId: string, hbCounter: number) => void;
}

interface PendingTurn {
    turnId: string;
    requestEventId: string;
    state: 'starting' | 'running';
    hbCounter: number;
    hbTimer: NodeJS.Timeout | null;
    failedSubtype?: string;
}

export class ClaudeBackend {
    private q: Query | null = null;
    private input: SDKUserMessageInputQueue | null = null;
    private suppress: SuppressMode;
    private current: PendingTurn | null = null;
    private readonly bgTasks = new Set<string>();
    private stoppedFlag = false;
    private readonly opts: ClaudeBackendOpts;

    constructor(opts: ClaudeBackendOpts) {
        this.opts = opts;
        this.suppress = new SuppressMode(opts.anchor ?? null);
    }

    /** Start the persistent query() loop. */
    start(): void {
        if (this.q) return;
        this.input = new SDKUserMessageInputQueue();
        const options: Options = {
            cwd: this.opts.cwd,
            ...(this.opts.resume ? { resume: this.opts.resume } : {}),
            // includePartialMessages is opt-in; default false. Adapter could
            // expose a setting to enable partial deltas.
        } as Options;
        this.q = query({ prompt: this.input.iterable(), options });
        void this.consume();
    }

    /** Push a user turn into the live stream. Creates a new turn. */
    pushUserMessage(content: string, requestEventId: string): string {
        const turnId = requestEventId;
        this.current = {
            turnId,
            requestEventId,
            state: 'starting',
            hbCounter: 0,
            hbTimer: null,
        };
        this.opts.emit({ type: 'turn-started', payload: { turnId, requestEventId } });
        this.startHeartbeat();
        const m: SDKUserMessage = { type: 'user', message: { role: 'user', content } } as unknown as SDKUserMessage;
        this.input?.push(m);
        return turnId;
    }

    /** Push a steer (mid-turn input) into the live stream. */
    pushSteer(content: string): void {
        const m: SDKUserMessage = { type: 'user', message: { role: 'user', content } } as unknown as SDKUserMessage;
        this.input?.push(m);
    }

    stopper(): Stopper {
        return {
            interrupt: async () => { try { await this.q?.interrupt(); } catch { /* ok */ } },
            abort: async () => { try { await this.q?.interrupt(); } catch { /* ok */ } },
            close: async () => { try { this.q?.close(); } catch { /* ok */ } this.stoppedFlag = true; },
            stopTask: async (taskId: string) => {
                const qWith = this.q as unknown as { stopTask?: (id: string) => Promise<void> };
                try { await qWith.stopTask?.(taskId); } catch { /* ok */ }
            },
            isStopped: () => this.stoppedFlag || !this.current,
        };
    }

    private startHeartbeat(): void {
        if (!this.current) return;
        this.stopHeartbeat();
        this.current.hbTimer = setInterval(() => {
            if (!this.current) return;
            this.current.hbCounter += 1;
            this.opts.heartbeat(this.current.turnId, this.current.hbCounter);
        }, 5_000);
    }

    private stopHeartbeat(): void {
        if (this.current?.hbTimer) {
            clearInterval(this.current.hbTimer);
            this.current.hbTimer = null;
        }
    }

    private async consume(): Promise<void> {
        if (!this.q) return;
        try {
            for await (const m of this.q) {
                this.onSdkMessage(m);
            }
        } catch (e) {
            // Aborted or fatal — surface as a turn-failed if a turn was running.
            if (this.current) {
                this.opts.emit({ type: 'turn-failed', payload: { turnId: this.current.turnId, errorSubtype: 'sdk-error', detail: String(e) } });
                this.endTurn();
            }
        }
    }

    private endTurn(): void {
        this.stopHeartbeat();
        this.current = null;
    }

    private onSdkMessage(m: SDKMessage): void {
        const anyM = m as unknown as { type: string; subtype?: string; uuid?: string };

        // Anchor-then-emit suppression for resume replay.
        if (this.suppress.inSuppress()) {
            const id = (m as unknown as { uuid?: string }).uuid ?? null;
            if (!this.suppress.shouldEmit(id)) return;
        }

        // session_state_changed: the authoritative turn-over signal (§17).
        if (anyM.type === 'system' && anyM.subtype === 'session_state_changed') {
            const state = (m as unknown as { state?: 'idle' | 'running' | 'requires_action' }).state;
            if (state === 'idle' && this.current) {
                // If we already emitted a failure earlier, don't override with completed.
                if (!this.current.failedSubtype) {
                    this.opts.emit({ type: 'turn-completed', payload: { turnId: this.current.turnId } });
                }
                this.endTurn();
                return;
            }
            if (state === 'running' && this.current && this.current.state === 'starting') {
                this.current.state = 'running';
                return;
            }
            return;
        }

        // result: advisory; only emit `turn-failed` for explicit error subtypes.
        if (anyM.type === 'result') {
            const sub = (m as unknown as { subtype: string }).subtype as Parameters<typeof terminalFromClaudeResultIfError>[0];
            const term = terminalFromClaudeResultIfError(sub);
            if (term && term.kind === 'failed' && this.current) {
                this.current.failedSubtype = term.errorSubtype;
                this.opts.emit({ type: 'turn-failed', payload: { turnId: this.current.turnId, errorSubtype: term.errorSubtype } });
            }
            return;
        }

        // Background tasks (§16).
        if (anyM.type === 'system' && anyM.subtype === 'task_started') {
            const p = (m as unknown as { task_id: string }).task_id;
            this.bgTasks.add(p);
            this.opts.emit({ type: 'bg-started', payload: { taskId: p, turnId: this.current?.turnId ?? '', label: '' } });
            return;
        }
        if (anyM.type === 'system' && anyM.subtype === 'task_progress') {
            const p = (m as unknown as { task_id: string }).task_id;
            this.opts.emit({ type: 'bg-progress', payload: { taskId: p } });
            return;
        }
        if (anyM.type === 'system' && anyM.subtype === 'task_notification') {
            const x = m as unknown as { task_id: string; status: 'completed' | 'failed' | 'stopped' };
            this.bgTasks.delete(x.task_id);
            this.opts.emit({ type: 'bg-notification', payload: { taskId: x.task_id, status: x.status } });
            return;
        }

        // Partial deltas — ephemeral.
        if (anyM.type === 'stream_event') {
            const sx = m as unknown as { uuid?: string; event?: { delta?: { text?: string } } };
            const text = sx.event?.delta?.text;
            if (text && sx.uuid) this.opts.partial(sx.uuid, text);
            return;
        }

        // Committed assistant message → turn-output.
        if (anyM.type === 'assistant') {
            const a = m as unknown as { uuid?: string; message?: { content?: unknown } };
            const messageId = a.uuid ?? randomUUID();
            if (this.current) {
                this.opts.emit({ type: 'turn-output', payload: { turnId: this.current.turnId, messageId, content: a.message?.content } });
            }
            return;
        }

        // tool_use / tool_result inside the assistant/user messages: surface
        // as tool-call/tool-result. The SDK packs them inside content arrays;
        // a thorough adapter unpacks each. For v1 we only surface the high-
        // level events. Future commits enrich this.
        // Other types (compact_boundary, api_retry, hooks, etc.) are not
        // load-bearing for the comm layer's correctness; they will land as
        // explicit events in subsequent commits.
    }

    liveTaskIds(): string[] {
        return Array.from(this.bgTasks);
    }
}

/** A tiny push-driven AsyncIterable used to feed the SDK with streamed input. */
class SDKUserMessageInputQueue {
    private buffer: SDKUserMessage[] = [];
    private waiters: Array<(v: IteratorResult<SDKUserMessage, void>) => void> = [];
    private closed = false;

    iterable(): AsyncIterable<SDKUserMessage> {
        const self = this;
        return {
            [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage, void> {
                return {
                    next(): Promise<IteratorResult<SDKUserMessage, void>> {
                        if (self.buffer.length > 0) {
                            return Promise.resolve({ value: self.buffer.shift()!, done: false });
                        }
                        if (self.closed) return Promise.resolve({ value: undefined, done: true });
                        return new Promise((resolve) => self.waiters.push(resolve));
                    },
                };
            },
        };
    }

    push(m: SDKUserMessage): void {
        if (this.waiters.length > 0) {
            this.waiters.shift()!({ value: m, done: false });
        } else {
            this.buffer.push(m);
        }
    }

    close(): void {
        this.closed = true;
        while (this.waiters.length > 0) this.waiters.shift()!({ value: undefined, done: true });
    }
}
