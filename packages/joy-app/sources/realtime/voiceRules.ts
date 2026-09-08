// Pure decisions of the voice orchestrator, pulled out of RealtimeSession so
// they can be specified without the ElevenLabs SDK or the store.

export type VoiceStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

/**
 * How a voice conversation lives.
 *
 * 'classic' is the original behaviour: the mic tap opens one conversation
 * and it stays open until the user ends it. Nothing is sent that the agent
 * has to permit — no prompt or first-message override — so it works with an
 * agent straight off the dashboard; the briefing goes over as context after
 * connect. A drop still reconnects.
 *
 * 'standby' hangs up after silence and wakes on session events or sound.
 * Its silent wakes need the first-message override and its briefing the
 * prompt override, both of which the agent must allow (Security tab).
 */
export type VoiceMode = 'classic' | 'standby';

/**
 * Whether the local sound detector should run right now. It listens only
 * while voice is ARMED, hung up, in the foreground and the setting is on.
 *
 * 'error' is deliberately NOT a listening state (#20): a start that failed
 * (revoked key, agent without overrides, no network) used to re-arm the
 * detector, and the next ambient sound re-tried, failed and alerted again —
 * an alert every few seconds until voice was ended. The failure now parks
 * voice in a visible error state; a tap or a session event retries.
 */
export function canListenWhileIdle(input: {
    mode: VoiceMode;
    armed: boolean;
    wakeOnSound: boolean;
    connecting: boolean;
    status: VoiceStatus;
    appState: string | null | undefined;
}): boolean {
    // Classic has no idle: the line is either up, coming back, or ended.
    if (input.mode === 'classic') return false;
    if (!input.armed || !input.wakeOnSound) return false;
    if (input.connecting || input.status !== 'disconnected') return false;
    return input.appState === 'active';
}

/** The shape both ElevenLabs SDKs hand to onDisconnect. */
export interface DisconnectDetails {
    reason: 'error' | 'agent' | 'user';
    message?: string;
    /** A CloseEvent on web; absent on native. Only `type` is inspected. */
    context?: { type?: string } | null;
}

export type DisconnectKind = 'agent-ended' | 'dropped';

/**
 * Was this the agent hanging up on purpose, or a drop?
 *
 * Native (@elevenlabs/react-native 0.5.x): reason 'agent' comes only from the
 * agent participant leaving the LiveKit room — the end_call tool — and
 * carries no context. A room drop is reported as reason 'user' (!), which the
 * orchestrator disambiguates with its own intentional-stop flag.
 *
 * Web (@elevenlabs/client 0.12.x): the end_call tool response ends the
 * session with reason 'agent' and a CloseEvent of type 'end_call'. But a
 * WebRTC room drop ALSO reports reason 'agent' (context type 'close'), and a
 * websocket close code 1000 does too — those must keep reconnecting.
 *
 * Reconnecting after an agent-requested end undid the hang-up the user just
 * asked for and billed another conversation (#343).
 */
export function classifyDisconnect(details: DisconnectDetails | null | undefined): DisconnectKind {
    if (!details || details.reason !== 'agent') return 'dropped';
    const type = details.context?.type;
    if (type === undefined || type === null) return 'agent-ended';
    return type === 'end_call' ? 'agent-ended' : 'dropped';
}

/**
 * A call that dies this soon after coming up, before either side has said a
 * word, was refused by the agent's configuration — an override it does not
 * allow, most commonly — not hung up or dropped.
 *
 * ElevenLabs accepts the room, then closes it (code 1008, "Override for
 * field 'prompt' is not allowed by config") the moment the initiation data
 * arrives. On web the close reason comes through; on native the SDK only
 * reports that the agent participant left, which the orchestrator otherwise
 * reads as the agent hanging up on the user's say-so and quietly stands by —
 * and in standby mode the next sound woke it into the same failure. Every
 * tap looked like "Voice live" for a second, then nothing.
 */
export const REJECTED_AFTER_CONNECT_MS = 8_000;

export function isRejectedAfterConnect(input: {
    /** When the current call came up; null when it never did. */
    connectedAt: number | null;
    /** When the last spoken turn (either side) was recorded; null if none. */
    lastTurnAt: number | null;
    now: number;
}): boolean {
    if (input.connectedAt === null) return false;
    if (input.now - input.connectedAt > REJECTED_AFTER_CONNECT_MS) return false;
    return input.lastTurnAt === null || input.lastTurnAt < input.connectedAt;
}
