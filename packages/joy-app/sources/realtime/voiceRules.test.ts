import { describe, expect, it } from 'vitest';
import { canListenWhileIdle, classifyDisconnect } from './voiceRules';

const listening = {
    armed: true,
    wakeOnSound: true,
    connecting: false,
    status: 'disconnected' as const,
    appState: 'active',
};

describe('canListenWhileIdle', () => {
    it('listens while armed, hung up, foregrounded and enabled', () => {
        expect(canListenWhileIdle(listening)).toBe(true);
    });

    it('does not listen when disarmed or the setting is off', () => {
        expect(canListenWhileIdle({ ...listening, armed: false })).toBe(false);
        expect(canListenWhileIdle({ ...listening, wakeOnSound: false })).toBe(false);
    });

    it('does not listen while a connection is up or being made', () => {
        expect(canListenWhileIdle({ ...listening, connecting: true })).toBe(false);
        expect(canListenWhileIdle({ ...listening, status: 'connecting' })).toBe(false);
        expect(canListenWhileIdle({ ...listening, status: 'connected' })).toBe(false);
    });

    it('does not re-arm after a failed start: error is a parked state (#20)', () => {
        expect(canListenWhileIdle({ ...listening, status: 'error' })).toBe(false);
    });

    it('only listens in the foreground', () => {
        expect(canListenWhileIdle({ ...listening, appState: 'background' })).toBe(false);
        expect(canListenWhileIdle({ ...listening, appState: 'inactive' })).toBe(false);
        expect(canListenWhileIdle({ ...listening, appState: null })).toBe(false);
    });
});

describe('classifyDisconnect (#343)', () => {
    it('native: reason agent without context is the agent hanging up', () => {
        expect(classifyDisconnect({ reason: 'agent' })).toBe('agent-ended');
        expect(classifyDisconnect({ reason: 'agent', context: null })).toBe('agent-ended');
    });

    it('web: the end_call tool is the agent hanging up', () => {
        expect(classifyDisconnect({ reason: 'agent', context: { type: 'end_call' } })).toBe('agent-ended');
    });

    it('web: a WebRTC room close or a clean socket close is a drop', () => {
        expect(classifyDisconnect({ reason: 'agent', context: { type: 'close' } })).toBe('dropped');
    });

    it('errors and user-reported reasons are drops (the orchestrator knows its own stops)', () => {
        expect(classifyDisconnect({ reason: 'error', message: 'socket error' })).toBe('dropped');
        expect(classifyDisconnect({ reason: 'user' })).toBe('dropped');
        expect(classifyDisconnect(undefined)).toBe('dropped');
        expect(classifyDisconnect(null)).toBe('dropped');
    });
});
