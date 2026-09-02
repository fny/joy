export interface VoiceSessionConfig {
    sessionId: string;
    systemPrompt?: string;
    /** Empty string = the agent waits for the user (used on event-driven wakes). */
    firstMessage?: string;
    /** WebRTC conversation token minted with the user's key (private agents). */
    conversationToken?: string;
    /** Bare agent id (public agents, no key). */
    agentId?: string;
}

export interface VoiceSession {
    startSession(config: VoiceSessionConfig): Promise<string | null>;
    endSession(): Promise<void>;
    sendTextMessage(message: string): void;
    sendContextualUpdate(update: string): void;
}

export type ConversationStatus = 'disconnected' | 'connecting' | 'connected' | 'error';
export type ConversationMode = 'idle' | 'agent-speaking' | 'user-speaking';
