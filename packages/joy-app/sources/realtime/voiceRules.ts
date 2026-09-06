// Pure decisions of the voice orchestrator, pulled out of RealtimeSession so
// they can be specified without the ElevenLabs SDK or the store.

export type VoiceStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

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
    armed: boolean;
    wakeOnSound: boolean;
    connecting: boolean;
    status: VoiceStatus;
    appState: string | null | undefined;
}): boolean {
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
