import { beforeEach, expect, it, vi } from 'vitest';

const app = vi.hoisted(() => ({
    state: { sessions: { session: {} }, sessionMessages: {} as Record<string, unknown> },
    send: vi.fn(async () => ({ ok: true })), allow: vi.fn(async () => {}), deny: vi.fn(async () => {}),
}));
vi.mock('@/sync/storage', () => ({ storage: { getState: () => app.state } }));
vi.mock('@/sync/sync', () => ({ sync: { sendMessage: app.send } }));
vi.mock('@/sync/ops', () => ({ sessionAllow: app.allow, sessionDeny: app.deny }));
vi.mock('./RealtimeSession', () => ({ noteVoiceActivity: vi.fn() }));
import { realtimeClientTools } from './realtimeClientTools';

beforeEach(() => { vi.clearAllMocks(); app.state.sessionMessages = {}; });

it('uses the existing message operation for a spoken instruction or question answer', async () => {
    await realtimeClientTools.sendMessageToSession({ sessionId: 'session', message: 'Choose option two.' });
    expect(app.send).toHaveBeenCalledWith('session', 'Choose option two.', { source: 'voice' });
    await realtimeClientTools.sendMessageToSession({ sessionId: 'missing', message: 'Hello' });
    expect(app.send).toHaveBeenCalledTimes(1);
});

it.each(['allow', 'deny'] as const)('only %ss a request while it remains pending', async decision => {
    const permission = { id: 'request', status: 'pending' };
    app.state.sessionMessages = { session: { messagesMap: { tool: { kind: 'tool-call', tool: { permission } } } } };
    await realtimeClientTools.processPermissionRequest({ requestId: 'request', decision });
    const action = decision === 'allow' ? app.allow : app.deny;
    expect(action).toHaveBeenCalledWith('session', 'request');
    permission.status = 'approved';
    const result = await realtimeClientTools.processPermissionRequest({ requestId: 'request', decision });
    expect(result).toContain('not found');
    expect(action).toHaveBeenCalledTimes(1);
});
