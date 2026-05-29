/**
 * Turn state machine on the agent side — comm-layer-spec §17.
 *
 * The boundary is the runtime state signal from the backend:
 *   Claude SDK: session_state_changed:idle (see sdk.d.ts:2702-2705) =
 *               authoritative turn-over signal.
 *   ACP:        PromptResponse.stopReason ∈ end_turn|cancelled|max_*|refusal
 *
 * `result`/prompt-return is advisory only; the turn terminalizes on the
 * state signal, never on `result` alone.
 *
 * This module exposes a tiny helper that takes a sequence of typed signals
 * from any backend adapter and decides which `turn-*` event to emit.
 */

export type StopReasonClaude = 'idle' | 'running' | 'requires_action';
export type StopReasonAcp =
    | 'end_turn'
    | 'max_tokens'
    | 'max_turn_requests'
    | 'refusal'
    | 'cancelled';

export type TurnTerminalKind =
    | { kind: 'completed' }
    | { kind: 'failed'; errorSubtype: string; detail?: unknown }
    | { kind: 'cancelled' }
    | { kind: 'interrupted'; reason: 'crash' | 'interrupt' };

export function terminalFromClaudeIdle(): TurnTerminalKind {
    // `idle` after a normal run = completed. If the agent observed an
    // explicit error subtype (max_turns etc.), the adapter should emit
    // `failed` directly with the precise subtype before idle fires.
    return { kind: 'completed' };
}

export function terminalFromAcp(stop: StopReasonAcp): TurnTerminalKind {
    switch (stop) {
        case 'end_turn':
            return { kind: 'completed' };
        case 'cancelled':
            return { kind: 'cancelled' };
        case 'max_tokens':
            return { kind: 'failed', errorSubtype: 'max_tokens' };
        case 'max_turn_requests':
            return { kind: 'failed', errorSubtype: 'max_turn_requests' };
        case 'refusal':
            return { kind: 'failed', errorSubtype: 'refusal' };
    }
}

/** Claude SDK's `result` carries one of four error subtypes plus success. */
export type ClaudeResultSubtype =
    | 'success'
    | 'error_during_execution'
    | 'error_max_turns'
    | 'error_max_budget_usd'
    | 'error_max_structured_output_retries';

export function terminalFromClaudeResultIfError(sub: ClaudeResultSubtype): TurnTerminalKind | null {
    // `result` is advisory; emit `failed` only for explicit errors. `success`
    // resolves via `session_state_changed:idle`.
    if (sub === 'success') return null;
    return { kind: 'failed', errorSubtype: sub };
}
