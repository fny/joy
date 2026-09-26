import { beforeEach, describe, expect, it, vi } from 'vitest';

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: Error) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));

const fixture = vi.hoisted(() => {
    const state = {
        realtimeStatus: 'disconnected', realtimeMode: 'idle', voiceArmedSessionId: null as string | null,
        settings: {
            voiceMode: 'standby', voiceIdleTimeoutSec: 0, voiceWakeOnSound: false, voiceWakeOnEvents: true,
            voiceApiModel: 'model', voiceSttModel: 'stt', voiceApiStyle: 'openai',
            voiceApiBaseUrl: 'https://api.example/v1', voiceSttBaseUrl: 'https://api.example/v1',
            voiceApiKey: 'key', voiceSttApiKey: 'key', pocketTtsVoice: 'alba',
        },
        setRealtimeStatus(value: string) { state.realtimeStatus = value; },
        setRealtimeMode(value: string) { state.realtimeMode = value; },
        setVoiceArmedSessionId(value: string | null) { state.voiceArmedSessionId = value; },
        clearRealtimeModeDebounce() {},
    };
    type Callbacks = { mode(mode: string): void; idle(): void; wake(): void; ended(): void; failed(error: Error): void };
    class FakeLocalVoiceSession {
        static instances: FakeLocalVoiceSession[] = [];
        static nextStartGate: Promise<void> | null = null;
        startSession = vi.fn(async (_config: unknown) => { await this.startGate; return 'A'; });
        endSession = vi.fn(async () => { await this.endGate; });
        pause = vi.fn(async (_listen: boolean) => { await this.pauseGate; });
        resume = vi.fn(async () => {});
        sendContextualUpdate = vi.fn();
        sendTextMessage = vi.fn();
        greet = vi.fn();
        startGate: Promise<void> = Promise.resolve();
        endGate: Promise<void> = Promise.resolve();
        pauseGate: Promise<void> = Promise.resolve();
        constructor(_model: unknown, _stt: unknown, _voice: string, public callbacks: Callbacks, public retirement: Promise<void>) {
            if (FakeLocalVoiceSession.nextStartGate) {
                this.startGate = FakeLocalVoiceSession.nextStartGate;
                FakeLocalVoiceSession.nextStartGate = null;
            }
            FakeLocalVoiceSession.instances.push(this);
        }
    }
    return {
        state, FakeLocalVoiceSession,
        hooks: {
            onVoiceStarted: vi.fn((id: string) => `context:${id}`),
            onSessionFocus: vi.fn(), onFocusChangedWhileConnecting: vi.fn(),
            onVoiceConnected: vi.fn(), onVoiceDisconnected: vi.fn(), onVoiceStopped: vi.fn(),
        },
        flush: vi.fn(), pending: { value: false },
        transcript: { value: false }, alert: vi.fn(),
    };
});

vi.mock('@/sync/storage', () => ({ storage: { getState: () => fixture.state } }));
vi.mock('@/modal', () => ({ Modal: { alert: fixture.alert } }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('@/utils/microphonePermissions', () => ({ showMicrophonePermissionDeniedAlert: vi.fn() }));
vi.mock('./LocalVoiceSession', () => ({
    LocalVoiceSession: fixture.FakeLocalVoiceSession,
    VoicePermissionError: class VoicePermissionError extends Error { canAskAgain = true; },
}));
vi.mock('./conversationApi', () => ({ apiEndpoint: (base: string, path: string) => `${base}/${path}` }));
vi.mock('./hooks/voiceHooks', () => ({ voiceHooks: fixture.hooks, flushPendingPrompts: fixture.flush, hasPendingPrompts: () => fixture.pending.value }));
vi.mock('./voiceSystemPrompt', () => ({ buildVoiceSystemPrompt: ({ sessionContext }: { sessionContext: string }) => `prompt(${sessionContext})` }));
vi.mock('./voiceTranscript', () => ({
    clearVoiceTranscript: vi.fn(), getRecentVoiceTranscript: () => null, hasVoiceTranscript: () => fixture.transcript.value,
}));

type Realtime = typeof import('./RealtimeSession');
let voice: Realtime;
beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    fixture.FakeLocalVoiceSession.instances.length = 0;
    fixture.FakeLocalVoiceSession.nextStartGate = null;
    fixture.state.realtimeStatus = 'disconnected';
    fixture.state.realtimeMode = 'idle';
    fixture.state.voiceArmedSessionId = null;
    fixture.state.settings.voiceMode = 'standby';
    fixture.state.settings.voiceWakeOnSound = false;
    fixture.state.settings.voiceWakeOnEvents = true;
    fixture.pending.value = false;
    fixture.transcript.value = false;
    voice = await import('./RealtimeSession');
});

describe('voice orchestration', () => {
    it('stops an in-flight startup and ignores its late success', async () => {
        const gate = deferred<void>();
        fixture.FakeLocalVoiceSession.nextStartGate = gate.promise;
        const start = voice.startVoice('A');
        const own = fixture.FakeLocalVoiceSession.instances[0];
        await voice.endVoice();
        gate.resolve();
        expect(await start).toBe(false);
        expect(own.endSession).toHaveBeenCalledOnce();
        expect(fixture.state.voiceArmedSessionId).toBeNull();
        expect(fixture.state.realtimeStatus).toBe('disconnected');
    });

    it('retires the previous session before the replacement claims devices', async () => {
        expect(await voice.startVoice('A')).toBe(true);
        const old = fixture.FakeLocalVoiceSession.instances[0];
        const closed = deferred<void>();
        old.endGate = closed.promise;
        const stopping = voice.endVoice();
        const restarting = voice.startVoice('B');
        const next = fixture.FakeLocalVoiceSession.instances[1];
        let retired = false;
        void next.retirement.then(() => { retired = true; });
        await tick();
        expect(retired).toBe(false);
        closed.resolve();
        await stopping;
        await restarting;
        expect(retired).toBe(true);
        expect(fixture.state.realtimeStatus).toBe('connected');
    });

    it('announces focus that moved while startup was pending', async () => {
        const gate = deferred<void>();
        fixture.FakeLocalVoiceSession.nextStartGate = gate.promise;
        const start = voice.startVoice('A');
        voice.setCurrentRealtimeSessionId('B');
        gate.resolve();
        expect(await start).toBe(true);
        expect(fixture.hooks.onVoiceStarted).toHaveBeenCalledWith('A');
        expect(fixture.hooks.onFocusChangedWhileConnecting).toHaveBeenCalledWith('B');
    });

    it('foreground waits for a background pause and keeps the resumed status', async () => {
        expect(await voice.startVoice('A')).toBe(true);
        const own = fixture.FakeLocalVoiceSession.instances[0];
        const paused = deferred<void>();
        own.pauseGate = paused.promise;
        const background = voice.setVoiceForeground(false);
        const foreground = voice.setVoiceForeground(true);
        expect(own.resume).not.toHaveBeenCalled();
        paused.resolve();
        await Promise.all([background, foreground]);
        expect(own.resume).toHaveBeenCalledOnce();
        expect(fixture.state.realtimeStatus).toBe('connected');
    });

    it('wakes silently for an event, then flushes pending prompts', async () => {
        expect(await voice.startVoice('A')).toBe(true);
        await voice.hangUp();
        fixture.flush.mockClear();
        voice.wakeForEvent('A');
        await tick();
        expect(fixture.state.realtimeStatus).toBe('connected');
        expect(fixture.flush).toHaveBeenCalled();
        expect(fixture.FakeLocalVoiceSession.instances[0].greet).toHaveBeenCalledTimes(1);
    });

    it('ignores a slow resume after a background and foreground cycle', async () => {
        await voice.startVoice('A');
        await voice.hangUp();
        const own = fixture.FakeLocalVoiceSession.instances[0];
        const resumed = deferred<void>();
        own.resume.mockImplementationOnce(() => resumed.promise);
        const start = voice.startVoice('A');
        await tick();
        await voice.setVoiceForeground(false);
        await voice.setVoiceForeground(true);
        resumed.resolve();
        expect(await start).toBe(false);
        expect(fixture.state.realtimeStatus).toBe('disconnected');
    });

    it('rebriefs the retained session when sound wakes a paused listener', async () => {
        fixture.state.settings.voiceWakeOnSound = true;
        expect(await voice.startVoice('A')).toBe(true);
        const own = fixture.FakeLocalVoiceSession.instances[0];
        await voice.hangUp();
        expect(own.pause).toHaveBeenCalledWith(true);
        fixture.hooks.onVoiceStarted.mockClear();
        own.callbacks.wake();
        expect(fixture.state.realtimeStatus).toBe('connected');
        expect(fixture.hooks.onVoiceStarted).toHaveBeenCalledWith('A');
        expect(own.sendContextualUpdate).toHaveBeenCalledWith('context:A');
    });

    it('does not retry a failed session through stale callbacks', async () => {
        expect(await voice.startVoice('A')).toBe(true);
        const own = fixture.FakeLocalVoiceSession.instances[0];
        own.callbacks.failed(new Error('lost connection'));
        expect(fixture.state.realtimeStatus).toBe('error');
        expect(fixture.hooks.onVoiceDisconnected).toHaveBeenCalled();
        own.callbacks.mode('agent-speaking');
        expect(fixture.state.realtimeMode).toBe('idle');
        voice.wakeForEvent('A');
        await tick();
        expect(fixture.FakeLocalVoiceSession.instances).toHaveLength(2);
        expect(fixture.state.realtimeStatus).toBe('connected');
    });
});
