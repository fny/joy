// The queue of things the voice agent still has to SAY: "the turn ended",
// "an approval is held", "a question was asked". Prompts wait while the
// agent or the user is talking and while the line is down; a queued prompt is
// what wakes an armed voice. Pure so the retention rules are testable:
//
//   - #22  entries age out; while armed with event wake off nothing drains
//          the queue, and without a bound the next tap replayed hours of
//          stale events as one message (and blocked the idle hang-up).
//   - #341 an approval prompt carries its request id, so when the user
//          answers the request in the app before voice is idle the prompt is
//          dropped instead of asking about an already-completed operation.
//   - #340 entries remember their session, so a reconnect can inject the
//          history of every queued event's session before the agent is told
//          to summarise it.

export interface PendingPrompt {
    text: string;
    sessionId: string;
    /** Set for held-approval prompts; lets a resolution drop the prompt. */
    requestId?: string;
    /** Enqueue time (ms epoch). */
    at: number;
}

/** A prompt older than this is stale news; the agent should not read it out. */
export const PENDING_PROMPT_MAX_AGE_MS = 10 * 60_000;
/** Hard bound on the backlog; the oldest are dropped first. */
export const PENDING_PROMPT_MAX = 20;

export class PendingPromptQueue {
    private items: PendingPrompt[] = [];

    get size(): number {
        return this.items.length;
    }

    /** Enqueue; beyond PENDING_PROMPT_MAX the oldest entries are dropped. */
    push(prompt: Omit<PendingPrompt, 'at'>, now: number = Date.now()): void {
        this.items.push({ ...prompt, at: now });
        if (this.items.length > PENDING_PROMPT_MAX) {
            this.items.splice(0, this.items.length - PENDING_PROMPT_MAX);
        }
    }

    /** The request was approved, denied or cancelled in the app (#341). */
    removeRequest(requestId: string): void {
        this.items = this.items.filter(p => p.requestId !== requestId);
    }

    /**
     * Drop entries that are too old (#22) and approval prompts whose request
     * is no longer pending (#341). `isRequestPending` is consulted for every
     * entry that carries a request id.
     */
    prune(now: number, isRequestPending: (sessionId: string, requestId: string) => boolean): void {
        this.items = this.items.filter(p => {
            if (now - p.at > PENDING_PROMPT_MAX_AGE_MS) return false;
            if (p.requestId !== undefined && !isRequestPending(p.sessionId, p.requestId)) return false;
            return true;
        });
    }

    /** Distinct sessions with something queued, oldest first (#340). */
    sessionIds(): string[] {
        const seen = new Set<string>();
        for (const p of this.items) seen.add(p.sessionId);
        return [...seen];
    }

    /** Take everything, oldest first. */
    drain(): string[] {
        const texts = this.items.map(p => p.text);
        this.items = [];
        return texts;
    }

    clear(): void {
        this.items = [];
    }
}

/**
 * Whether a prompt is worth queueing right now (#22). Queued prompts only
 * ever leave the queue over a live line, so when nothing will bring the line
 * up — hung up AND event wake off — the prompt would sit until the user taps
 * and then be read out stale. 'connecting' counts as live: the flush on
 * connect is imminent.
 */
export function shouldQueuePrompt(input: {
    status: 'disconnected' | 'connecting' | 'connected' | 'error';
    wakeOnEvents: boolean;
}): boolean {
    if (input.status === 'connected' || input.status === 'connecting') return true;
    return input.wakeOnEvents;
}
