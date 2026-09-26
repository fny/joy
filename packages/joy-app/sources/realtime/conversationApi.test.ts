import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiEndpoint, completeConversation, requestVoiceJson, type ConversationMessage, type ConversationTool } from './conversationApi';

const tool: ConversationTool = { name: 'send_message', description: 'Send a message', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } };
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

describe('apiEndpoint', () => {
    it('preserves a custom versioned path and removes trailing slashes', () => {
        expect(apiEndpoint('https://gateway.example/custom/v1///', '/chat/completions')).toBe('https://gateway.example/custom/v1/chat/completions');
    });
    it.each(['file:///tmp/api', 'https://user:secret@example.test/v1', 'https://example.test/v1?x=1', 'https://example.test/v1#x'])('rejects unsafe base URL %s', base => {
        expect(() => apiEndpoint(base, 'messages')).toThrow('Provider URL');
    });
});

describe('completeConversation', () => {
    it('does not start a request that was already cancelled', async () => {
        const controller = new AbortController();
        controller.abort();
        const fetchMock = vi.fn();
        globalThis.fetch = fetchMock;
        await expect(requestVoiceJson('https://api.example/v1', { method: 'POST' }, controller.signal)).rejects.toThrow('Request cancelled');
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('sends OpenAI chat messages, tool schemas and parses tool calls', async () => {
        const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => response({
            choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'send_message', arguments: '{"text":"hello"}' } }] } }],
        }));
        globalThis.fetch = fetchMock as typeof fetch;
        const messages: ConversationMessage[] = [{ role: 'user', content: 'send hello' }];
        const result = await completeConversation({ apiStyle: 'openai', baseUrl: 'https://api.example/v1/', model: 'model', apiKey: 'secret' }, 'system', messages, [tool], new AbortController().signal);
        expect(result).toEqual({ role: 'assistant', content: '', toolCalls: [{ id: 'call-1', name: 'send_message', arguments: { text: 'hello' } }] });
        const [url, init] = fetchMock.mock.calls[0];
        expect(String(url)).toBe('https://api.example/v1/chat/completions');
        expect(init?.headers).toMatchObject({ authorization: 'Bearer secret' });
        expect(JSON.parse(String(init?.body))).toMatchObject({ max_completion_tokens: 1024, messages: [{ role: 'system', content: 'system' }, { role: 'user', content: 'send hello' }], tools: [{ function: { name: 'send_message', parameters: tool.parameters } }] });
    });

    it('encodes Anthropic tool use/results and preserves returned blocks for the next turn', async () => {
        const blocks = [{ type: 'text', text: 'Working.' }, { type: 'tool_use', id: 'use-1', name: 'send_message', input: { text: 'hello' } }];
        const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => response({ content: blocks, stop_reason: 'tool_use' }));
        globalThis.fetch = fetchMock as typeof fetch;
        const history: ConversationMessage[] = [
            { role: 'assistant', content: 'Working.', providerContent: blocks },
            { role: 'user', content: 'done', toolResults: [{ id: 'use-1', content: 'sent' }] },
        ];
        const result = await completeConversation({ apiStyle: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', model: 'claude', apiKey: 'secret' }, 'rules', history, [tool], new AbortController().signal);
        expect(result).toMatchObject({ role: 'assistant', content: 'Working.', providerContent: blocks, toolCalls: [{ id: 'use-1', name: 'send_message', arguments: { text: 'hello' } }] });
        const [url, init] = fetchMock.mock.calls[0];
        expect(String(url)).toBe('https://api.anthropic.com/v1/messages');
        expect(init?.headers).toMatchObject({ 'x-api-key': 'secret', 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' });
        expect(JSON.parse(String(init?.body))).toMatchObject({ system: 'rules', max_tokens: 1024, messages: history.map(m => m.role === 'assistant' ? { role: 'assistant', content: blocks } : { role: 'user', content: [{ type: 'text', text: 'done' }, { type: 'tool_result', tool_use_id: 'use-1', content: 'sent' }] }), tools: [{ name: 'send_message', input_schema: tool.parameters }] });
    });

    it('reports HTTP status without exposing provider response details', async () => {
        globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ error: { message: 'secret should not escape' } }), { status: 401 }));
        await expect(completeConversation({ apiStyle: 'openai', baseUrl: 'https://api.example/v1', model: 'm', apiKey: 'secret' }, '', [], [], new AbortController().signal)).rejects.toThrow('Provider request failed (401)');
    });

    it('supports unauthenticated compatible endpoints without sending an empty credential header', async () => {
        const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => response({ choices: [{ finish_reason: 'stop', message: { content: 'Hello.' } }] }));
        globalThis.fetch = fetchMock as typeof fetch;
        await completeConversation({ apiStyle: 'openai', baseUrl: 'https://local.example/v1', model: 'm' }, '', [], [], new AbortController().signal);
        const [, init] = fetchMock.mock.calls[0];
        expect(init?.headers).not.toHaveProperty('authorization');
    });

    it('rejects malformed output and truncated tool output', async () => {
        globalThis.fetch = vi.fn(async () => response({ choices: [{ finish_reason: 'length', message: { content: null } }] }));
        await expect(completeConversation({ apiStyle: 'openai', baseUrl: 'https://api.example/v1', model: 'm', apiKey: 'secret' }, '', [], [], new AbortController().signal)).rejects.toThrow('output limit');
        globalThis.fetch = vi.fn(async () => response({ choices: [] }));
        await expect(completeConversation({ apiStyle: 'openai', baseUrl: 'https://api.example/v1', model: 'm', apiKey: 'secret' }, '', [], [], new AbortController().signal)).rejects.toThrow('Invalid provider response');
        globalThis.fetch = vi.fn(async () => response({ choices: [{ finish_reason: 'stop', message: { content: '' } }] }));
        await expect(completeConversation({ apiStyle: 'openai', baseUrl: 'https://api.example/v1', model: 'm', apiKey: 'secret' }, '', [], [], new AbortController().signal)).rejects.toThrow('empty response');
        globalThis.fetch = vi.fn(async () => response({ choices: [{ finish_reason: 'stop', message: { content: null, refusal: 'cannot help' } }] }));
        await expect(completeConversation({ apiStyle: 'openai', baseUrl: 'https://api.example/v1', model: 'm', apiKey: 'secret' }, '', [], [], new AbortController().signal)).rejects.toThrow('refused');
    });

    it('sends cancellation to fetch and does not expose network error text', async () => {
        const controller = new AbortController();
        globalThis.fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('secret url https://host/?key=secret')));
        }));
        const request = completeConversation({ apiStyle: 'openai', baseUrl: 'https://api.example/v1', model: 'm', apiKey: 'secret' }, '', [], [], controller.signal);
        controller.abort();
        await expect(request).rejects.toThrow('Request cancelled');
    });

    it('cancels while reading a response body even if json ignores the abort signal', async () => {
        const controller = new AbortController();
        globalThis.fetch = vi.fn(async () => ({
            ok: true,
            status: 200,
            json: () => new Promise(() => {}),
        } as Response));
        const request = completeConversation({ apiStyle: 'openai', baseUrl: 'https://api.example/v1', model: 'm' }, '', [], [], controller.signal);
        await Promise.resolve();
        controller.abort();
        await expect(request).rejects.toThrow('Request cancelled');
    });

    it('times out while reading a response body', async () => {
        vi.useFakeTimers();
        try {
            globalThis.fetch = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => ({
                ok: true,
                status: 200,
                json: () => new Promise(() => {}),
            } as Response)) as typeof fetch;
            const request = requestVoiceJson('https://api.example/v1', { method: 'POST' }, new AbortController().signal);
            const rejection = expect(request).rejects.toThrow('Provider request timed out');
            await vi.advanceTimersByTimeAsync(45_000);
            await rejection;
        } finally {
            vi.useRealTimers();
        }
    });

    it('retries transport and transient server failures with bounded delays', async () => {
        vi.useFakeTimers();
        try {
            const fetchMock = vi.fn()
                .mockRejectedValueOnce(new Error('temporary network failure'))
                .mockResolvedValueOnce(new Response('', { status: 503 }))
                .mockResolvedValueOnce(response({ ok: true }));
            globalThis.fetch = fetchMock as typeof fetch;
            const request = requestVoiceJson('https://api.example/v1', { method: 'POST' }, new AbortController().signal);
            await vi.advanceTimersByTimeAsync(500);
            await vi.advanceTimersByTimeAsync(1500);
            await expect(request).resolves.toEqual({ ok: true });
            expect(fetchMock).toHaveBeenCalledTimes(3);
        } finally {
            vi.useRealTimers();
        }
    });

    it('does not retry authorization or other non-transient HTTP failures', async () => {
        const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response('', { status: 401 }));
        globalThis.fetch = fetchMock as typeof fetch;
        await expect(requestVoiceJson('https://api.example/v1', { method: 'POST' }, new AbortController().signal)).rejects.toThrow('(401)');
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});
