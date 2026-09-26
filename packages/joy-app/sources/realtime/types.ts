export interface VoiceSessionConfig {
    sessionId: string;
    systemPrompt: string;
    firstMessage?: string;
}

/** Joy's conversation boundary; speech and model providers stay behind it. */
export interface VoiceSession {
    startSession(config: VoiceSessionConfig): Promise<string | null>;
    endSession(): Promise<void>;
    sendTextMessage(message: string): void;
    sendContextualUpdate(update: string): void;
}

export type ConversationStatus = 'disconnected' | 'connecting' | 'connected' | 'error';
export type ConversationMode = 'idle' | 'agent-speaking' | 'user-speaking';

export interface SpeechOutput {
    prepare(): Promise<void>;
    play(wav: Uint8Array, signal: AbortSignal): Promise<void>;
    dispose(): void | Promise<void>;
}
