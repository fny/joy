import { beforeEach, expect, test, vi } from 'vitest';
const complete = vi.hoisted(() => vi.fn());
vi.mock('./conversationApi', () => ({ completeConversation: complete }));
import { VoiceConversation } from './voiceConversation';
const config = { apiStyle: 'openai' as const, baseUrl: 'https://example.test/v1', model: 'model', apiKey: '' };
const tools = ['sendMessageToSession', 'processPermissionRequest', 'skip_turn', 'end_call'].map(name => ({ name, description: name, parameters: {} }));
const signal = () => new AbortController();
beforeEach(() => complete.mockReset());
test('silent context becomes available on the next conversation turn without being spoken directly', async () => {
    const execute = vi.fn();
    const conversation = new VoiceConversation(config, 'rules', tools, execute);
    conversation.updateContext('Session A is building.');
    expect(complete).not.toHaveBeenCalled();
    complete.mockResolvedValueOnce({ role: 'assistant', content: 'Your build is running.' });
    expect(await conversation.respond('What is happening?', 'user', signal().signal)).toEqual({ text: 'Your build is running.', ended: false });
    expect(complete.mock.calls[0][2][0].content).toContain('Session A is building.');
    expect(execute).not.toHaveBeenCalled();
});
test('a spoken instruction executes an existing action and returns its result to the model', async () => {
    const execute = vi.fn(async () => 'sent');
    const conversation = new VoiceConversation(config, 'rules', tools, execute);
    complete.mockResolvedValueOnce({ role: 'assistant', content: '', toolCalls: [{ id: 'call', name: 'sendMessageToSession', arguments: { sessionId: 'a', message: 'Fix it' } }] })
        .mockResolvedValueOnce({ role: 'assistant', content: 'Sent.' });
    expect((await conversation.respond('Tell it to fix it', 'user', signal().signal)).text).toBe('Sent.');
    expect(execute).toHaveBeenCalledWith('sendMessageToSession', { sessionId: 'a', message: 'Fix it' });
    expect(complete.mock.calls[1][2].at(-1).toolResults).toEqual([{ id: 'call', content: 'sent' }]);
});
test('notifications are marked as session data and retain earlier user instructions', async () => {
    const conversation = new VoiceConversation(config, 'rules', tools, vi.fn());
    complete.mockResolvedValue({ role: 'assistant', content: 'Understood.' });
    await conversation.respond('Announce updates briefly', 'user', signal().signal);
    await conversation.respond('Session B finished', 'event', signal().signal);
    const messages = complete.mock.calls[1][2];
    expect(messages[0].content).toContain('[User said]');
    expect(messages.at(-1).content).toContain('[Session notification]');
});
test('a cancelled response cannot execute a late action', async () => {
    const execute = vi.fn(); const controller = signal();
    const conversation = new VoiceConversation(config, 'rules', tools, execute);
    complete.mockImplementation(async () => {
        controller.abort();
        return { role: 'assistant', content: '', toolCalls: [{ id: 'late', name: 'processPermissionRequest', arguments: {} }] };
    });
    await expect(conversation.respond('Approve that', 'user', controller.signal)).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
});
test('interruption during an action records its result and prevents the next action', async () => {
    const controller = signal();
    const execute = vi.fn(async () => { controller.abort(); return 'sent'; });
    const conversation = new VoiceConversation(config, 'rules', tools, execute);
    complete.mockResolvedValueOnce({ role: 'assistant', content: '', toolCalls: [
        { id: 'one', name: 'sendMessageToSession', arguments: {} },
        { id: 'two', name: 'sendMessageToSession', arguments: {} },
    ] });
    await expect(conversation.respond('Send it', 'user', controller.signal)).rejects.toThrow();
    expect(execute).toHaveBeenCalledTimes(1);
    complete.mockResolvedValueOnce({ role: 'assistant', content: 'Stopped.' });
    await conversation.respond('Stop', 'user', signal().signal);
    expect(complete.mock.calls[1][2][2].toolResults).toEqual([{ id: 'one', content: 'sent' }, { id: 'two', content: 'Not executed: voice turn interrupted.' }]);
});
test('conversation controls cannot accompany executable actions', async () => {
    const execute = vi.fn();
    const conversation = new VoiceConversation(config, 'rules', tools, execute);
    complete.mockResolvedValueOnce({ role: 'assistant', content: '', toolCalls: [
        { id: 'stop', name: 'end_call', arguments: {} }, { id: 'send', name: 'sendMessageToSession', arguments: {} },
    ] });
    await expect(conversation.respond('Stop', 'user', signal().signal)).rejects.toThrow('mixed');
    expect(execute).not.toHaveBeenCalled();
});
