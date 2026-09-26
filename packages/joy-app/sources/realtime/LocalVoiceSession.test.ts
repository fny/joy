import { beforeEach, describe, expect, it, vi } from 'vitest';

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(yes => { resolve = yes; });
    return { promise, resolve };
}
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));

const fixture = vi.hoisted(() => {
    type InputCallbacks = { onSpeechStart(): void; onRecording(recording: { dispose(): void }): void; onError(error: Error): void };
    const input = { start: vi.fn(async () => {}), stop: vi.fn(async () => {}) };
    const output = { prepare: vi.fn(async () => {}), play: vi.fn(async () => {}), dispose: vi.fn() };
    const speech = { prepare: vi.fn(async () => {}), generate: vi.fn(async () => new Uint8Array([1])), dispose: vi.fn() };
    const conversation = { respond: vi.fn(async () => ({ text: 'hello', ended: false })), updateContext: vi.fn() };
    return {
        input, output, speech, conversation,
        callbacks: null as InputCallbacks | null,
        requestPermission: vi.fn(async () => ({ granted: true, canAskAgain: true })),
        deniedAlert: vi.fn(), transcribe: vi.fn(async () => 'Joy, hello'),
        transcript: vi.fn(), mode: vi.fn(), idle: vi.fn(), wake: vi.fn(), ended: vi.fn(), failed: vi.fn(),
    };
});

vi.mock('@/utils/microphonePermissions', () => ({
    requestMicrophonePermission: fixture.requestPermission,
    showMicrophonePermissionDeniedAlert: fixture.deniedAlert,
}));
vi.mock('./pocket/speech', () => ({ createPocketSpeech: () => fixture.speech }));
vi.mock('./pocket/progress', () => ({ resetPocketProgress: vi.fn() }));
vi.mock('./speechOutput', () => ({ createSpeechOutput: () => fixture.output }));
vi.mock('./speechInput', () => ({ createSpeechInput: (callbacks: typeof fixture.callbacks) => { fixture.callbacks = callbacks; return fixture.input; } }));
vi.mock('./transcription', () => ({ transcribe: fixture.transcribe }));
vi.mock('./voiceConversation', () => ({ VoiceConversation: class { respond = fixture.conversation.respond; updateContext = fixture.conversation.updateContext; } }));
vi.mock('./realtimeClientTools', () => ({ realtimeClientTools: {}, voiceToolDefinitions: [] }));
vi.mock('./voiceTranscript', () => ({ recordVoiceMessage: fixture.transcript }));
vi.mock('./speechText', () => ({ speechText: (text: string) => text }));

import { LocalVoiceSession } from './LocalVoiceSession';

function session(retirement?: Promise<void>) {
    return new LocalVoiceSession(
        { apiStyle: 'openai', baseUrl: 'https://api.example/v1', model: 'model', apiKey: 'key' },
        { baseUrl: 'https://api.example/v1', model: 'stt', apiKey: 'key' },
        'alba',
        { mode: fixture.mode, idle: fixture.idle, wake: fixture.wake, ended: fixture.ended, failed: fixture.failed },
        retirement,
    );
}

beforeEach(() => {
    vi.clearAllMocks();
    fixture.callbacks = null;
    fixture.requestPermission.mockResolvedValue({ granted: true, canAskAgain: true });
    fixture.transcribe.mockResolvedValue('Joy, hello');
    fixture.conversation.respond.mockResolvedValue({ text: 'hello', ended: false });
    fixture.speech.prepare.mockResolvedValue(undefined);
    fixture.speech.generate.mockResolvedValue(new Uint8Array([1]));
});

describe('local voice session lifecycle', () => {
    it('does not acquire the microphone until the previous session has retired', async () => {
        const retired = deferred<void>();
        const own = session(retired.promise);
        const start = own.startSession({ sessionId: 'A', systemPrompt: 'prompt' });
        await tick();
        expect(fixture.requestPermission).not.toHaveBeenCalled();
        expect(fixture.input.start).not.toHaveBeenCalled();
        retired.resolve();
        expect(await start).toBe('A');
        expect(fixture.input.start).toHaveBeenCalledOnce();
        await own.endSession();
    });

    it('cancels a pending permission result without starting input', async () => {
        const permission = deferred<{ granted: boolean; canAskAgain: boolean }>();
        fixture.requestPermission.mockReturnValue(permission.promise);
        const own = session();
        const start = own.startSession({ sessionId: 'A', systemPrompt: 'prompt' });
        await tick();
        await own.endSession();
        permission.resolve({ granted: true, canAskAgain: true });
        expect(await start).toBeNull();
        expect(fixture.input.start).not.toHaveBeenCalled();
    });

    it('cancels a pending Pocket model load without starting input', async () => {
        const prepared = deferred<void>();
        fixture.speech.prepare.mockReturnValue(prepared.promise);
        const own = session();
        const start = own.startSession({ sessionId: 'A', systemPrompt: 'prompt' });
        await tick();
        await own.endSession();
        prepared.resolve();
        expect(await start).toBeNull();
        expect(fixture.speech.dispose).toHaveBeenCalled();
        expect(fixture.input.start).not.toHaveBeenCalled();
    });

    it('disposes every transcription clip, including one interrupted by new speech', async () => {
        const transcribed = deferred<string>();
        fixture.transcribe.mockReturnValue(transcribed.promise);
        const own = session();
        await own.startSession({ sessionId: 'A', systemPrompt: 'prompt' });
        const first = { dispose: vi.fn() };
        fixture.callbacks!.onSpeechStart();
        fixture.callbacks!.onRecording(first);
        await tick();
        fixture.callbacks!.onSpeechStart();
        transcribed.resolve('ignored');
        await tick();
        expect(first.dispose).toHaveBeenCalledOnce();
        expect(fixture.conversation.respond).not.toHaveBeenCalled();
        const second = { dispose: vi.fn() };
        fixture.transcribe.mockResolvedValue('Joy, continue');
        fixture.callbacks!.onRecording(second);
        await tick();
        expect(second.dispose).toHaveBeenCalledOnce();
        expect(fixture.conversation.respond).toHaveBeenCalledWith('Joy, continue', 'user', expect.any(AbortSignal));
        await own.endSession();
    });

    it('suppresses stale model replies and playback after interruption', async () => {
        const answer = deferred<{ text: string; ended: boolean }>();
        fixture.conversation.respond.mockReturnValue(answer.promise);
        const own = session();
        await own.startSession({ sessionId: 'A', systemPrompt: 'prompt' });
        own.sendTextMessage('session update');
        await tick();
        fixture.callbacks!.onSpeechStart();
        answer.resolve({ text: 'obsolete response', ended: false });
        await tick();
        expect(fixture.speech.generate).not.toHaveBeenCalled();
        expect(fixture.output.play).not.toHaveBeenCalled();
        await own.endSession();
    });

    it('does not record an interrupted playback as spoken', async () => {
        const played = deferred<void>();
        fixture.output.play.mockReturnValue(played.promise);
        const own = session();
        await own.startSession({ sessionId: 'A', systemPrompt: 'prompt' });
        own.sendTextMessage('session update');
        await tick();
        expect(fixture.output.play).toHaveBeenCalledOnce();
        fixture.callbacks!.onSpeechStart();
        played.resolve();
        await tick();
        expect(fixture.transcript).not.toHaveBeenCalled();
        await own.endSession();
    });
});
