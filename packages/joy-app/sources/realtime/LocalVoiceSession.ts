import { requestMicrophonePermission } from '@/utils/microphonePermissions';
import { createPocketSpeech } from './pocket/speech';
import { resetPocketProgress } from './pocket/progress';
import { createSpeechOutput } from './speechOutput';
import { createSpeechInput, type SpeechRecording } from './speechInput';
import { transcribe, type TranscriptionConfig } from './transcription';
import { VoiceConversation } from './voiceConversation';
import type { VoiceModelConfig } from './conversationApi';
import { realtimeClientTools, voiceToolDefinitions } from './realtimeClientTools';
import { recordVoiceMessage } from './voiceTranscript';
import { speechText } from './speechText';
import type { ConversationMode, VoiceSession, VoiceSessionConfig } from './types';

export class VoicePermissionError extends Error {
    constructor(public canAskAgain?: boolean) { super('Microphone permission denied.'); }
}

interface Callbacks {
    mode(mode: ConversationMode): void;
    idle(): void;
    wake(): void;
    ended(): void;
    failed(error: unknown): void;
}

/** Replaces the provider SDK behind Joy's existing conversation boundary. */
export class LocalVoiceSession implements VoiceSession {
    private output = createSpeechOutput();
    private speech: ReturnType<typeof createPocketSpeech> | null = null;
    private input: ReturnType<typeof createSpeechInput>;
    private conversation: VoiceConversation | null = null;
    private disposed = false;
    private paused = false;
    private hearing = false;
    private turn = new AbortController();
    private serial: Promise<void> = Promise.resolve();
    private startup: Promise<void> | null = null;
    private preparing = false;
    private generating = false;
    constructor(private model: VoiceModelConfig, private stt: TranscriptionConfig, private voice: string, private callbacks: Callbacks, private retired: Promise<void> = Promise.resolve()) {
        this.input = createSpeechInput({
            onSpeechStart: () => {
                if (this.disposed) return;
                if (this.paused) { this.paused = false; this.callbacks.wake(); }
                this.hearing = true;
                this.interrupt();
                callbacks.mode('user-speaking');
            },
            onRecording: recording => {
                if (this.disposed || this.paused) { void recording.dispose(); return; }
                this.hearing = false;
                this.schedule(async signal => {
                    try {
                        const text = await transcribe(this.stt, recording, signal);
                        if (text && !signal.aborted) {
                            recordVoiceMessage({ role: 'user', text });
                            await this.respond(text, 'user', signal);
                        }
                    } finally { await recording.dispose(); }
                }, () => { void recording.dispose(); });
            },
            onError: error => { if (!this.disposed) callbacks.failed(error); },
        });
    }

    async startSession(config: VoiceSessionConfig): Promise<string | null> {
        // prepare runs in the original tap, before permission/model network awaits.
        const audio = this.output.prepare();
        this.conversation = new VoiceConversation(this.model, config.systemPrompt, voiceToolDefinitions, async (name, args) => {
            const action = realtimeClientTools[name as keyof typeof realtimeClientTools];
            return action ? action(args) : 'Error: unknown action.';
        });
        this.startup = (async () => {
            await audio;
            await this.retired;
            if (this.disposed) return;
            const permission = await requestMicrophonePermission();
            if (this.disposed) return;
            if (!permission.granted) {
                throw new VoicePermissionError(permission.canAskAgain);
            }
            await this.prepareSpeech();
            if (this.disposed) return;
            await this.input.start();
        })();
        await this.startup;
        return this.disposed ? null : config.sessionId;
    }

    private async prepareSpeech() {
        if (this.speech || this.disposed) return;
        const speech = createPocketSpeech();
        this.speech = speech;
        resetPocketProgress(this.voice);
        this.preparing = true;
        try { await speech.prepare(this.voice); }
        finally { if (this.speech === speech) this.preparing = false; }
    }

    sendContextualUpdate(update: string) { this.conversation?.updateContext(update); }
    sendTextMessage(message: string) {
        if (!this.disposed && !this.paused) this.schedule(signal => this.respond(message, 'event', signal));
    }
    greet(text: string) { if (text) this.schedule(signal => this.say(text, signal)); }

    private async respond(text: string, source: 'user' | 'event', signal: AbortSignal) {
        const reply = await this.conversation!.respond(text, source, signal);
        if (signal.aborted || this.disposed) return;
        if (reply.ended) { this.callbacks.ended(); return; }
        if (reply.text) await this.say(reply.text, signal);
    }

    private async say(text: string, signal: AbortSignal) {
        await this.prepareSpeech();
        if (signal.aborted || this.disposed || !this.speech) return;
        // Keep complete-clip playback; stream underruns previously split words.
        // Split long answers at word boundaries instead of silently truncating them.
        const words = speechText(text, Number.MAX_SAFE_INTEGER).split(' ');
        let clip = '';
        const play = async (part: string) => {
            if (signal.aborted || this.disposed || !this.speech) return;
            this.generating = true;
            let wav: Uint8Array;
            try { wav = await this.speech.generate(part, signal); }
            finally { this.generating = false; }
            if (signal.aborted || this.disposed) return;
            this.callbacks.mode('agent-speaking');
            await this.output.play(wav, signal);
            if (!signal.aborted) recordVoiceMessage({ role: 'agent', text: part });
        };
        for (const word of words) {
            if (clip.length + word.length > 400) { await play(clip); clip = ''; }
            if (signal.aborted) return;
            clip += (clip ? ' ' : '') + word;
        }
        if (clip) await play(clip);
    }

    private schedule(work: (signal: AbortSignal) => Promise<void>, discarded?: () => void) {
        const signal = this.turn.signal;
        this.callbacks.mode('agent-speaking'); // Also holds session notifications during inference.
        this.serial = this.serial.catch(() => {}).then(async () => {
            if (signal.aborted || this.disposed || this.paused) { discarded?.(); return; }
            try { await work(signal); }
            catch (error) { if (!signal.aborted && !this.disposed) this.callbacks.failed(error); }
            finally {
                if (!signal.aborted && !this.disposed && !this.hearing) {
                    this.callbacks.mode('idle');
                    this.callbacks.idle();
                }
            }
        });
    }

    interrupt() {
        this.turn.abort();
        this.turn = new AbortController();
        if (this.generating || this.preparing) this.releaseSpeech();
    }
    private releaseSpeech() {
        this.speech?.dispose();
        this.speech = null;
        this.preparing = false;
    }
    async pause(listen: boolean) {
        this.paused = true;
        this.interrupt();
        this.releaseSpeech();
        this.hearing = false;
        if (!listen) await this.input.stop();
    }
    async resume() {
        this.paused = false;
        await this.input.start();
    }
    async endSession() {
        if (this.disposed) return;
        this.disposed = true;
        this.interrupt();
        this.releaseSpeech();
        const output = this.output.dispose();
        await Promise.all([this.input.stop(), output]);
    }
}
