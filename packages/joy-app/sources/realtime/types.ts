export interface VoiceSessionConfig {
    sessionId: string;
    /**
     * Session briefing handed over as the `initialConversationContext` dynamic
     * variable, for a dashboard prompt that references it (the original joy
     * setup). Dynamic variables need no override permission.
     */
    initialContext?: string;
    /** System-prompt OVERRIDE. Only sent when set; the agent must allow it. */
    systemPrompt?: string;
    /** First-message OVERRIDE; empty string = the agent waits for the user
     *  (event-driven wakes). Only sent when set; the agent must allow it. */
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
