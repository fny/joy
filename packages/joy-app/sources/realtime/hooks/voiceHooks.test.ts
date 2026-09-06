import { beforeEach, describe, expect, it, vi } from 'vitest';

// vi.mock factories are hoisted above every other statement, so the fixtures
// they close over must be hoisted too.
const { state, voice, sent, realtime, ledger } = vi.hoisted(() => {
    const sent: string[] = [];
    // The module's ledger instance, captured so its retention can be measured.
    const ledger = { current: null as null | { size: number; isShown(id: string): boolean; staleSessions(): string[] } };
    const voice = {
        startSession: vi.fn(async () => null),
        endSession: vi.fn(async () => {}),
        sendTextMessage: vi.fn((text: string) => { sent.push(`prompt:${text}`); }),
        sendContextualUpdate: vi.fn((text: string) => { sent.push(`context:${text}`); }),
    };
    const state = {
        realtimeStatus: 'disconnected' as string,
        realtimeMode: 'idle' as string,
        voiceArmedSessionId: 'A' as string | null,
        settings: { voiceWakeOnEvents: true },
        sessions: {} as Record<string, { id: string }>,
        sessionMessages: {} as Record<string, { messages: any[]; messagesMap: Record<string, any> }>,
        getActiveSessions: () => [] as any[],
    };
    const realtime = {
        currentSessionId: null as string | null,
        wakeForEvent: vi.fn(),
    };
    return { state, voice, sent, realtime, ledger };
});
vi.mock('./contextLedger', async (importOriginal) => {
    const mod = await importOriginal<typeof import('./contextLedger')>();
    class Captured<M extends { id: string }> extends mod.SessionContextLedger<M> {
        constructor(maxDeferred?: number) { super(maxDeferred); ledger.current = this; }
    }
    return { ...mod, SessionContextLedger: Captured };
});
vi.mock('@/sync/storage', () => ({
    storage: { getState: () => state, subscribe: () => () => {} },
}));
vi.mock('../voiceConfig', () => ({ VOICE_CONFIG: { ENABLE_DEBUG_LOGGING: false } }));
vi.mock('../RealtimeSession', () => ({
    getVoiceSession: () => voice,
    isVoiceConnected: () => state.realtimeStatus === 'connected',
    getCurrentRealtimeSessionId: () => realtime.currentSessionId,
    setCurrentRealtimeSessionId: (id: string) => { realtime.currentSessionId = id; },
    wakeForEvent: (id: string) => realtime.wakeForEvent(id),
}));
vi.mock('./contextFormatters', () => ({
    formatSessionFull: (session: { id: string }, messages: { id: string }[]) => `full(${session.id}):${messages.map(m => m.id).join(',')}`,
    formatNewMessages: (sessionId: string, messages: { id: string }[]) => `new(${sessionId}):${messages.map(m => m.id).join(',')}`,
    formatReadyEvent: (sessionId: string) => `ready(${sessionId})`,
    formatSessionFocus: (sessionId: string) => `focus(${sessionId})`,
    formatPermissionRequest: (sessionId: string, requestId: string) => `permission(${sessionId},${requestId})`,
    formatQuestion: (sessionId: string) => `question(${sessionId})`,
    parseJoyOptions: () => null,
    cleanAgentText: (text: string) => text,
}));

import { flushPendingPrompts, hasPendingPrompts, voiceHooks } from './voiceHooks';
import { MAX_DEFERRED_UPDATES } from './contextLedger';

function addMessage(sessionId: string, id: string) {
    const m = { id, kind: 'agent-text' as const, localId: null, text: id, isThinking: false, createdAt: 0 };
    const bucket = state.sessionMessages[sessionId] ?? (state.sessionMessages[sessionId] = { messages: [], messagesMap: {} });
    bucket.messages.push(m);
    bucket.messagesMap[id] = m;
    return m;
}

describe('voiceHooks keep the briefed session current across a connect (#340)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        sent.length = 0;
        state.realtimeStatus = 'disconnected';
        state.realtimeMode = 'idle';
        state.voiceArmedSessionId = 'A';
        state.sessions = { A: { id: 'A' }, B: { id: 'B' } };
        state.sessionMessages = {};
        realtime.currentSessionId = 'A';
        voiceHooks.onVoiceStopped();
        addMessage('A', 'a1');
        addMessage('B', 'b1');
    });

    it('a turn that ends while the token/SDK connect is pending is replayed before the summary prompt', () => {
        state.realtimeStatus = 'connecting';
        const prompt = voiceHooks.onVoiceStarted('A');
        expect(prompt).toContain('full(A):a1');

        // A finishes while the line is still coming up: the update cannot be
        // sent, the ready prompt is queued.
        const a2 = addMessage('A', 'a2');
        voiceHooks.onMessages('A', [a2]);
        voiceHooks.onReady('A');
        expect(sent).toEqual([]);

        state.realtimeStatus = 'connected';
        voiceHooks.onVoiceConnected();
        flushPendingPrompts();

        expect(sent).toEqual(['context:new(A):a2', 'prompt:ready(A)']);
    });

    it('the flush alone replays the deferred update before the prompt', () => {
        state.realtimeStatus = 'connecting';
        voiceHooks.onVoiceStarted('A');
        const a2 = addMessage('A', 'a2');
        voiceHooks.onMessages('A', [a2]);
        voiceHooks.onReady('A');

        state.realtimeStatus = 'connected';
        flushPendingPrompts();

        expect(sent).toEqual(['context:new(A):a2', 'prompt:ready(A)']);
    });

    it('a deferred update is replayed once, then live updates flow as usual', () => {
        state.realtimeStatus = 'connecting';
        voiceHooks.onVoiceStarted('A');
        const a2 = addMessage('A', 'a2');
        voiceHooks.onMessages('A', [a2]);
        state.realtimeStatus = 'connected';
        voiceHooks.onVoiceConnected();
        voiceHooks.onVoiceConnected();
        const a3 = addMessage('A', 'a3');
        voiceHooks.onMessages('A', [a3]);
        expect(sent).toEqual(['context:new(A):a2', 'context:new(A):a3']);
    });

    it('a session not in the snapshot is injected in full on first contact, with no replay', () => {
        state.realtimeStatus = 'connecting';
        voiceHooks.onVoiceStarted('A');
        const b2 = addMessage('B', 'b2');
        voiceHooks.onMessages('B', [b2]);
        voiceHooks.onReady('B');

        state.realtimeStatus = 'connected';
        voiceHooks.onVoiceConnected();
        flushPendingPrompts();

        expect(sent).toEqual(['context:full(B):b1,b2', 'prompt:ready(B)']);
    });

    it('a rebuilt snapshot (focus moved during the connect) drops what was deferred against the old one', () => {
        state.realtimeStatus = 'connecting';
        voiceHooks.onVoiceStarted('A');
        const a2 = addMessage('A', 'a2');
        voiceHooks.onMessages('A', [a2]);
        // The prompt is rebuilt for A again: the new snapshot includes a2.
        expect(voiceHooks.onVoiceStarted('A')).toContain('full(A):a1,a2');
        state.realtimeStatus = 'connected';
        voiceHooks.onVoiceConnected();
        expect(sent).toEqual([]);
    });

    it('an idle hang-up retires the ledger: an armed phone with event wake off retains nothing (#340)', () => {
        state.realtimeStatus = 'connecting';
        voiceHooks.onVoiceStarted('A');
        state.realtimeStatus = 'connected';
        voiceHooks.onVoiceConnected();
        expect(ledger.current!.isShown('A')).toBe(true);

        // Idle timeout: hung up, still armed, nothing would wake it.
        state.realtimeStatus = 'disconnected';
        state.settings.voiceWakeOnEvents = false;
        voiceHooks.onVoiceDisconnected();
        expect(ledger.current!.isShown('A')).toBe(false);
        for (let i = 0; i < 10_000; i++) voiceHooks.onMessages('A', [addMessage('A', `idle-${i}`)]);
        expect(hasPendingPrompts()).toBe(false);
        expect(ledger.current!.size).toBe(0);
        expect(ledger.current!.staleSessions()).toEqual([]);
        expect(sent).toEqual([]);
        state.settings.voiceWakeOnEvents = true;
    });

    it('deferral is scoped to a connect in flight, not to every state the line is down in (#340)', () => {
        state.realtimeStatus = 'connecting';
        voiceHooks.onVoiceStarted('A');
        state.realtimeStatus = 'connected';
        voiceHooks.onVoiceConnected();
        // A drop the orchestrator has not reported yet: still nothing kept.
        state.realtimeStatus = 'disconnected';
        voiceHooks.onMessages('A', [addMessage('A', 'a2')]);
        state.realtimeStatus = 'error';
        voiceHooks.onMessages('A', [addMessage('A', 'a3')]);
        expect(ledger.current!.size).toBe(0);
        // In flight again: deferred, and replayed on connect.
        state.realtimeStatus = 'connecting';
        voiceHooks.onMessages('A', [addMessage('A', 'a4')]);
        expect(ledger.current!.size).toBe(1);
        state.realtimeStatus = 'connected';
        voiceHooks.onVoiceConnected();
        expect(sent).toEqual(['context:new(A):a4']);
    });

    it('a session that changes more than the ledger keeps during the connect is briefed in full again, not replayed', () => {
        state.realtimeStatus = 'connecting';
        voiceHooks.onVoiceStarted('A');
        const ids: string[] = [];
        for (let i = 0; i < MAX_DEFERRED_UPDATES + 1; i++) {
            const m = addMessage('A', `a${i + 2}`);
            ids.push(m.id);
            voiceHooks.onMessages('A', [m]);
        }
        expect(ledger.current!.size).toBe(0);
        state.realtimeStatus = 'connected';
        voiceHooks.onVoiceConnected();
        voiceHooks.onReady('A');
        expect(sent).toEqual([`context:full(A):a1,${ids.join(',')}`, 'prompt:ready(A)']);
    });

    it('updates while hung up are not replayed on a connection that re-briefs the session', () => {
        // Armed, hung up: the next connect builds a fresh snapshot anyway.
        const a2 = addMessage('A', 'a2');
        voiceHooks.onMessages('A', [a2]);
        state.realtimeStatus = 'connecting';
        expect(voiceHooks.onVoiceStarted('A')).toContain('full(A):a1,a2');
        state.realtimeStatus = 'connected';
        voiceHooks.onVoiceConnected();
        expect(sent).toEqual([]);
    });
});
