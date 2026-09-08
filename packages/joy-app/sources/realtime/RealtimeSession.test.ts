import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// vi.mock factories are hoisted above every other statement, so the fixtures
// they close over must be hoisted too.
const { state, permission, agent, token, hooks, transcript } = vi.hoisted(() => {
    // A minimal store: only what startVoice / notifyVoiceConnected touch.
    const state = {
        realtimeStatus: 'disconnected' as string,
        realtimeMode: 'idle',
        voiceArmedSessionId: null as string | null,
        settings: { voiceMode: 'standby' as 'standby' | 'classic', voiceIdleTimeoutSec: 0, voiceWakeOnSound: false, voiceWakeOnEvents: true },
        setRealtimeStatus(s: string) { state.realtimeStatus = s; },
        setVoiceArmedSessionId(id: string | null) { state.voiceArmedSessionId = id; },
    };
    return {
        state,
        permission: { request: vi.fn<() => Promise<{ granted: boolean; canAskAgain: boolean }>>() },
        agent: { current: { agentId: 'agent-1', apiKey: undefined as string | undefined } },
        token: { mint: vi.fn<() => Promise<string>>() },
        transcript: { lastTurnAt: null as number | null },
        hooks: {
            onVoiceStarted: vi.fn((sessionId: string) => `ctx:${sessionId}`),
            onFocusChangedWhileConnecting: vi.fn(),
            onVoiceConnected: vi.fn(),
            onVoiceDisconnected: vi.fn(),
            onVoiceStopped: vi.fn(),
        },
    };
});
vi.mock('@/sync/storage', () => ({ storage: { getState: () => state } }));
vi.mock('react-native', () => ({ AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) } }));
vi.mock('@/modal', () => ({ Modal: { alert: vi.fn() } }));
vi.mock('@/text', () => ({ t: (key: string, params?: Record<string, unknown>) => (params ? `${key}:${JSON.stringify(params)}` : key) }));
vi.mock('@/utils/microphonePermissions', () => ({
    requestMicrophonePermission: () => permission.request(),
    showMicrophonePermissionDeniedAlert: vi.fn(),
}));
vi.mock('./voiceSystemPrompt', () => ({
    buildVoiceSystemPrompt: ({ sessionContext }: { sessionContext: string }) => `prompt(${sessionContext})`,
    buildVoiceBriefing: ({ sessionContext }: { sessionContext: string }) => `briefing(${sessionContext})`,
    buildVoiceFirstMessage: () => 'hello',
}));
vi.mock('./voiceTranscript', () => ({
    clearVoiceTranscript: vi.fn(),
    getRecentVoiceTranscript: () => null,
    hasVoiceTranscript: () => false,
    lastVoiceTurnAt: () => transcript.lastTurnAt,
}));
vi.mock('./elevenLabs', () => ({
    activeVoiceAgent: () => agent.current,
    mintConversationToken: () => token.mint(),
}));
vi.mock('./hooks/voiceHooks', () => ({
    voiceHooks: hooks,
    flushPendingPrompts: vi.fn(),
    hasPendingPrompts: () => false,
}));
vi.mock('./soundWake', () => ({
    startSoundWake: vi.fn(async () => {}),
    stopSoundWake: vi.fn(async () => {}),
}));
vi.mock('./voiceRules', async (importActual) => ({
    ...(await importActual<typeof import('./voiceRules')>()),
    canListenWhileIdle: () => false,
}));

import {
    startVoice,
    hangUp,
    endVoice,
    wakeForEvent,
    registerVoiceSession,
    setCurrentRealtimeSessionId,
    notifyVoiceConnected,
    notifyVoiceAgentEnded,
    notifyVoiceUnexpectedDisconnect,
} from './RealtimeSession';
import { Modal } from '@/modal';
import type { VoiceSession, VoiceSessionConfig } from './types';

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => { resolve = r; });
    return { promise, resolve };
}
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

function fakeSdk(connectOnStart = true) {
    const started: VoiceSessionConfig[] = [];
    const session: VoiceSession = {
        startSession: vi.fn(async (config: VoiceSessionConfig) => {
            started.push(config);
            if (connectOnStart) {
                state.setRealtimeStatus('connected');
                notifyVoiceConnected();
            }
            return null;
        }),
        endSession: vi.fn(async () => { state.setRealtimeStatus('disconnected'); }),
        sendTextMessage: vi.fn(),
        sendContextualUpdate: vi.fn(),
    };
    registerVoiceSession(session);
    return { session, started };
}

describe('startVoice re-reads the focused session at every async boundary (#338)', () => {
    beforeEach(async () => {
        vi.clearAllMocks();
        vi.useRealTimers();
        // Reset the module's connection state between tests.
        await hangUp();
        state.realtimeStatus = 'disconnected';
        state.voiceArmedSessionId = null;
        agent.current = { agentId: 'agent-1', apiKey: undefined };
        token.mint.mockResolvedValue('tok');
    });

    it('focus moving to B while the microphone prompt is pending briefs and starts B, not A', async () => {
        const { started } = fakeSdk();
        const perm = deferred<{ granted: boolean; canAskAgain: boolean }>();
        permission.request.mockReturnValue(perm.promise);

        const result = startVoice('A');
        await tick();
        setCurrentRealtimeSessionId('B');
        perm.resolve({ granted: true, canAskAgain: true });

        expect(await result).toBe(true);
        expect(hooks.onVoiceStarted).toHaveBeenCalledTimes(1);
        expect(hooks.onVoiceStarted).toHaveBeenCalledWith('B');
        expect(started).toHaveLength(1);
        expect(started[0].sessionId).toBe('B');
        expect(started[0].systemPrompt).toBe('prompt(ctx:B)');
        // Nothing to announce: the agent was briefed about B from the start.
        expect(hooks.onFocusChangedWhileConnecting).not.toHaveBeenCalled();
    });

    it('focus moving while the conversation token is minted rebuilds the prompt for the new session', async () => {
        const { started } = fakeSdk();
        permission.request.mockResolvedValue({ granted: true, canAskAgain: true });
        agent.current = { agentId: 'agent-1', apiKey: 'key' };
        const mint = deferred<string>();
        token.mint.mockReturnValue(mint.promise);

        const result = startVoice('A');
        await tick();
        expect(hooks.onVoiceStarted).toHaveBeenLastCalledWith('A');
        setCurrentRealtimeSessionId('B');
        mint.resolve('tok');

        expect(await result).toBe(true);
        expect(hooks.onVoiceStarted).toHaveBeenLastCalledWith('B');
        expect(started[0].sessionId).toBe('B');
        expect(started[0].systemPrompt).toBe('prompt(ctx:B)');
        expect(started[0].conversationToken).toBe('tok');
    });

    it('focus moving during the SDK connect is announced once, whether the connect callback or the start sees it first', async () => {
        const { session } = fakeSdk(false);
        permission.request.mockResolvedValue({ granted: true, canAskAgain: true });
        const connect = deferred<null>();
        (session.startSession as ReturnType<typeof vi.fn>).mockImplementation(async () => {
            await connect.promise;
            state.setRealtimeStatus('connected');
            notifyVoiceConnected();
            return null;
        });

        const result = startVoice('A');
        await tick();
        setCurrentRealtimeSessionId('C');
        connect.resolve(null);

        expect(await result).toBe(true);
        expect(hooks.onVoiceStarted).toHaveBeenCalledWith('A');
        expect(hooks.onFocusChangedWhileConnecting).toHaveBeenCalledTimes(1);
        expect(hooks.onFocusChangedWhileConnecting).toHaveBeenCalledWith('C');
    });

    it('a start with unchanged focus announces nothing', async () => {
        const { started } = fakeSdk();
        permission.request.mockResolvedValue({ granted: true, canAskAgain: true });
        expect(await startVoice('A')).toBe(true);
        expect(started[0].sessionId).toBe('A');
        expect(hooks.onFocusChangedWhileConnecting).not.toHaveBeenCalled();
    });
});

describe('the context ledger lives only as long as the connection (#340)', () => {
    beforeEach(async () => {
        vi.clearAllMocks();
        vi.useRealTimers();
        await hangUp();
        vi.clearAllMocks();
        state.realtimeStatus = 'disconnected';
        state.voiceArmedSessionId = null;
        agent.current = { agentId: 'agent-1', apiKey: undefined };
        permission.request.mockResolvedValue({ granted: true, canAskAgain: true });
    });

    it('a hang-up (the idle timeout, a tap) retires it while voice stays armed', async () => {
        fakeSdk();
        expect(await startVoice('A')).toBe(true);
        expect(hooks.onVoiceDisconnected).not.toHaveBeenCalled();
        await hangUp();
        expect(hooks.onVoiceDisconnected).toHaveBeenCalledTimes(1);
        expect(hooks.onVoiceStopped).not.toHaveBeenCalled();
        expect(state.voiceArmedSessionId).toBe('A');
    });

    it('the agent ending the call, and a drop, retire it', async () => {
        fakeSdk();
        expect(await startVoice('A')).toBe(true);
        transcript.lastTurnAt = Date.now() + 1; // something was said: a real call
        state.realtimeStatus = 'disconnected';
        notifyVoiceAgentEnded();
        expect(hooks.onVoiceDisconnected).toHaveBeenCalledTimes(1);
        // A drop while armed schedules a reconnect, which briefs afresh.
        state.voiceArmedSessionId = null;
        notifyVoiceUnexpectedDisconnect();
        expect(hooks.onVoiceDisconnected).toHaveBeenCalledTimes(2);
    });

    it('a failed connect retires it, before the attempt is parked in error', async () => {
        const { session } = fakeSdk(false);
        (session.startSession as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('no network'));
        vi.spyOn(console, 'error').mockImplementation(() => {});
        expect(await startVoice('A', { silentWake: true })).toBe(false);
        expect(hooks.onVoiceStarted).toHaveBeenCalledTimes(1);
        expect(hooks.onVoiceDisconnected).toHaveBeenCalledTimes(1);
        expect(state.realtimeStatus).toBe('error');
    });

    it('a connect that succeeds does not', async () => {
        fakeSdk();
        expect(await startVoice('A')).toBe(true);
        expect(hooks.onVoiceDisconnected).not.toHaveBeenCalled();
    });
});

describe('classic mode: one conversation from the tap until it is ended', () => {
    beforeEach(async () => {
        vi.clearAllMocks();
        vi.useRealTimers();
        await endVoice();
        vi.clearAllMocks();
        state.realtimeStatus = 'disconnected';
        state.voiceArmedSessionId = null;
        state.settings.voiceMode = 'classic';
        state.settings.voiceIdleTimeoutSec = 0;
        transcript.lastTurnAt = null;
        agent.current = { agentId: 'agent-1', apiKey: undefined };
        permission.request.mockResolvedValue({ granted: true, canAskAgain: true });
    });
    afterEach(() => { state.settings.voiceMode = 'standby'; });

    it('sends no overrides; the briefing rides the dynamic variable and a contextual update once the line is up', async () => {
        const { session, started } = fakeSdk();
        expect(await startVoice('A')).toBe(true);
        expect(started).toHaveLength(1);
        expect(started[0].systemPrompt).toBeUndefined();
        expect(started[0].firstMessage).toBeUndefined();
        expect(started[0].initialContext).toBe('ctx:A');
        expect(session.sendContextualUpdate).toHaveBeenCalledTimes(1);
        expect(session.sendContextualUpdate).toHaveBeenCalledWith('briefing(ctx:A)');
    });

    it('standby still sends the overrides its silent wakes depend on', async () => {
        state.settings.voiceMode = 'standby';
        const { session, started } = fakeSdk();
        expect(await startVoice('A')).toBe(true);
        expect(started[0].systemPrompt).toBe('prompt(ctx:A)');
        expect(started[0].firstMessage).toBe('hello');
        expect(started[0].initialContext).toBeUndefined();
        expect(session.sendContextualUpdate).not.toHaveBeenCalled();
    });

    it('never hangs up on silence', async () => {
        state.settings.voiceIdleTimeoutSec = 0.03; // 30ms
        const { session } = fakeSdk();
        expect(await startVoice('A')).toBe(true);
        await new Promise((r) => setTimeout(r, 90));
        expect(session.endSession).not.toHaveBeenCalled();
        expect(state.realtimeStatus).toBe('connected');
    });

    it('standby hangs up on the same silence', async () => {
        state.settings.voiceMode = 'standby';
        state.settings.voiceIdleTimeoutSec = 0.03;
        const { session } = fakeSdk();
        expect(await startVoice('A')).toBe(true);
        await new Promise((r) => setTimeout(r, 90));
        expect(session.endSession).toHaveBeenCalled();
    });

    it('session events do not wake it: there is nothing hung up to wake', async () => {
        const { session } = fakeSdk();
        state.voiceArmedSessionId = 'A';
        wakeForEvent('A');
        await tick();
        expect(session.startSession).not.toHaveBeenCalled();
    });

    it('the agent ending a real call (end_call, on the user\'s say-so) turns voice off, not standby', async () => {
        fakeSdk();
        expect(await startVoice('A')).toBe(true);
        transcript.lastTurnAt = Date.now() + 1;
        state.realtimeStatus = 'disconnected';
        notifyVoiceAgentEnded();
        await tick();
        expect(state.voiceArmedSessionId).toBeNull();
        expect(hooks.onVoiceStopped).toHaveBeenCalled();
        expect(Modal.alert).not.toHaveBeenCalled();
    });
});

describe('a call refused right after connect is said so, not retried', () => {
    beforeEach(async () => {
        vi.clearAllMocks();
        vi.useRealTimers();
        await endVoice();
        vi.clearAllMocks();
        state.realtimeStatus = 'disconnected';
        state.voiceArmedSessionId = null;
        state.settings.voiceIdleTimeoutSec = 0;
        transcript.lastTurnAt = null;
        agent.current = { agentId: 'agent-1', apiKey: undefined };
        permission.request.mockResolvedValue({ granted: true, canAskAgain: true });
        vi.spyOn(console, 'warn').mockImplementation(() => {});
    });
    afterEach(() => { state.settings.voiceMode = 'standby'; });

    it('native: the agent "ending" the call before a word — standby names the overrides and parks in error, still armed', async () => {
        state.settings.voiceMode = 'standby';
        fakeSdk();
        expect(await startVoice('A')).toBe(true);
        state.realtimeStatus = 'disconnected';
        notifyVoiceAgentEnded();
        expect(state.realtimeStatus).toBe('error');
        expect(state.voiceArmedSessionId).toBe('A');
        expect(Modal.alert).toHaveBeenCalledTimes(1);
        expect(String((Modal.alert as ReturnType<typeof vi.fn>).mock.calls[0][1])).toContain('voice.refusedOverrides');
        expect(hooks.onVoiceStopped).not.toHaveBeenCalled();
    });

    it('web: the server\'s close reason is what the user reads, and no reconnect is scheduled', async () => {
        state.settings.voiceMode = 'classic';
        const { session } = fakeSdk();
        expect(await startVoice('A')).toBe(true);
        state.realtimeStatus = 'disconnected';
        notifyVoiceUnexpectedDisconnect("Override for field 'prompt' is not allowed by config.");
        expect(state.realtimeStatus).toBe('error');
        expect(Modal.alert).toHaveBeenCalledTimes(1);
        expect(String((Modal.alert as ReturnType<typeof vi.fn>).mock.calls[0][1])).toContain("Override for field 'prompt'");
        await new Promise((r) => setTimeout(r, 20));
        expect(session.startSession).toHaveBeenCalledTimes(1); // no retry
    });

    it('a drop after a real exchange still reconnects', async () => {
        state.settings.voiceMode = 'classic';
        const { session } = fakeSdk();
        expect(await startVoice('A')).toBe(true);
        transcript.lastTurnAt = Date.now() + 1;
        state.realtimeStatus = 'disconnected';
        notifyVoiceUnexpectedDisconnect();
        expect(state.realtimeStatus).toBe('connecting');
        expect(Modal.alert).not.toHaveBeenCalled();
        await new Promise((r) => setTimeout(r, 900));
        expect(session.startSession).toHaveBeenCalledTimes(2);
    });
});
