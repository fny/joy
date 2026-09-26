export interface VoiceModelConfig {
    apiStyle: 'openai' | 'anthropic';
    baseUrl: string;
    model: string;
    apiKey?: string;
}

export interface ConversationMessage {
    role: 'user' | 'assistant';
    content: string;
    toolCalls?: { id: string; name: string; arguments: unknown }[];
    toolResults?: { id: string; content: string }[];
    /** Raw Anthropic content blocks, retained so tool_use blocks round-trip intact. */
    providerContent?: unknown;
}

export interface ConversationTool {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
}

const MAX_TOKENS = 1024;
const REQUEST_TIMEOUT_MS = 45_000;

export function apiEndpoint(baseUrl: string, path: string): string {
    let url: URL;
    try { url = new URL(baseUrl.trim()); }
    catch { throw new Error('Invalid provider URL'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
        throw new Error('Provider URL must be an http(s) URL without credentials, query, or fragment');
    }
    const base = url.toString().replace(/\/+$/, '');
    return `${base}/${path.replace(/^\/+/, '')}`;
}

function jsonObject(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid provider response');
    return value as Record<string, unknown>;
}

function text(value: unknown): string {
    return typeof value === 'string' ? value : '';
}

function checkNotAborted(signal: AbortSignal, timedOut: { value: boolean }): void {
    if (!signal.aborted && !timedOut.value) return;
    throw new Error(timedOut.value ? 'Provider request timed out' : 'Request cancelled');
}

function awaitWithAbort<T>(promise: Promise<T>, signal: AbortSignal, timedOut: { value: boolean }): Promise<T> {
    return new Promise((resolve, reject) => {
        const onAbort = () => {
            signal.removeEventListener('abort', onAbort);
            try { checkNotAborted(signal, timedOut); } catch (error) { reject(error); }
        };
        if (signal.aborted) { onAbort(); return; }
        signal.addEventListener('abort', onAbort, { once: true });
        promise.then(
            value => { signal.removeEventListener('abort', onAbort); resolve(value); },
            error => { signal.removeEventListener('abort', onAbort); reject(error); },
        );
    });
}

function abortableDelay(ms: number, signal: AbortSignal, timedOut: { value: boolean }): Promise<void> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
        const onAbort = () => {
            clearTimeout(timer);
            signal.removeEventListener('abort', onAbort);
            try { checkNotAborted(signal, timedOut); } catch (error) { reject(error); }
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
    });
}

/** Fetch and decode a provider JSON response with bounded transport retries. */
export async function requestVoiceJson(url: string, init: RequestInit, signal: AbortSignal): Promise<unknown> {
    checkNotAborted(signal, { value: false });
    const controller = new AbortController();
    const abort = () => controller.abort();
    const timedOut = { value: false };
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => { timedOut.value = true; abort(); }, REQUEST_TIMEOUT_MS);
    const retryDelays = [500, 1500];
    try {
        for (let attempt = 0; ; attempt++) {
            let response: Response;
            try {
                response = await awaitWithAbort(fetch(url, { ...init, signal: controller.signal, redirect: init.redirect ?? 'error' }), controller.signal, timedOut);
            } catch {
                if (controller.signal.aborted) checkNotAborted(signal, timedOut);
                if (attempt >= retryDelays.length) throw new Error('Provider request failed');
                await abortableDelay(retryDelays[attempt], controller.signal, timedOut);
                continue;
            }
            checkNotAborted(signal, timedOut);
            if (!response.ok) {
                if ([408, 429].includes(response.status) || response.status >= 500) {
                    if (attempt < retryDelays.length) {
                        void response.body?.cancel().catch(() => {});
                        await abortableDelay(retryDelays[attempt], controller.signal, timedOut);
                        continue;
                    }
                }
                throw new Error(`Provider request failed (${response.status})`);
            }
            try {
                const value = await awaitWithAbort(response.json(), controller.signal, timedOut);
                checkNotAborted(signal, timedOut);
                return value;
            } catch (error) {
                if (controller.signal.aborted) checkNotAborted(signal, timedOut);
                throw new Error('Invalid provider response');
            }
        }
    } finally {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
    }
}

function openAIMessages(system: string, messages: ConversationMessage[]): unknown[] {
    const result: unknown[] = [{ role: 'system', content: system }];
    for (const message of messages) {
        if (message.role === 'assistant') {
            result.push({
                role: 'assistant', content: message.content || null,
                ...(message.toolCalls?.length ? { tool_calls: message.toolCalls.map(call => ({
                    id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) },
                })) } : {}),
            });
        } else {
            if (message.content) result.push({ role: 'user', content: message.content });
            for (const item of message.toolResults ?? []) result.push({ role: 'tool', tool_call_id: item.id, content: item.content });
        }
    }
    return result;
}

function anthropicMessages(messages: ConversationMessage[]): unknown[] {
    return messages.map(message => {
        if (message.role === 'assistant') {
            if (Array.isArray(message.providerContent)) return { role: 'assistant', content: message.providerContent };
            const content: unknown[] = [];
            if (message.content) content.push({ type: 'text', text: message.content });
            for (const call of message.toolCalls ?? []) content.push({ type: 'tool_use', id: call.id, name: call.name, input: call.arguments ?? {} });
            return { role: 'assistant', content };
        }
        const content: unknown[] = [];
        if (message.content) content.push({ type: 'text', text: message.content });
        for (const result of message.toolResults ?? []) content.push({ type: 'tool_result', tool_use_id: result.id, content: result.content });
        return { role: 'user', content };
    });
}

function parseOpenAI(data: Record<string, unknown>): ConversationMessage {
    const choice = Array.isArray(data.choices) ? jsonObject(data.choices[0]) : null;
    const message = choice && jsonObject(choice.message);
    if (!choice || !message) throw new Error('Invalid provider response');
    if (choice.finish_reason === 'length') throw new Error('Provider response reached the output limit');
    if (choice.finish_reason === 'content_filter' || text(message.refusal)) throw new Error('Provider refused the request');
    const rawCalls = message.tool_calls;
    const toolCalls = rawCalls === undefined ? [] : Array.isArray(rawCalls) ? rawCalls.map(raw => {
        const call = jsonObject(raw), fn = jsonObject(call.function);
        let args: unknown;
        try { args = JSON.parse(text(fn.arguments)); } catch { throw new Error('Provider returned invalid tool arguments'); }
        return { id: text(call.id), name: text(fn.name), arguments: args };
    }) : (() => { throw new Error('Invalid provider response'); })();
    if (toolCalls.some(call => !call.id || !call.name)) throw new Error('Invalid provider tool call');
    if (!text(message.content).trim() && toolCalls.length === 0) throw new Error('Provider returned an empty response');
    return { role: 'assistant', content: text(message.content), ...(toolCalls.length ? { toolCalls } : {}) };
}

function parseAnthropic(data: Record<string, unknown>): ConversationMessage {
    if (!Array.isArray(data.content)) throw new Error('Invalid provider response');
    if (data.stop_reason === 'max_tokens') throw new Error('Provider response reached the output limit');
    if (data.stop_reason === 'refusal') throw new Error('Provider refused the request');
    let content = '';
    const toolCalls: NonNullable<ConversationMessage['toolCalls']> = [];
    for (const itemValue of data.content) {
        const item = jsonObject(itemValue);
        if (item.type === 'text') content += text(item.text);
        if (item.type === 'tool_use') {
            if (typeof item.id !== 'string' || typeof item.name !== 'string') throw new Error('Invalid provider tool call');
            toolCalls.push({ id: item.id, name: item.name, arguments: jsonObject(item.input) });
        }
        if (item.type === 'refusal') throw new Error('Provider refused the request');
        if (item.type !== 'text' && item.type !== 'tool_use' && item.type !== 'thinking' && item.type !== 'redacted_thinking') throw new Error('Invalid provider response');
    }
    if (!content.trim() && toolCalls.length === 0) throw new Error('Provider returned an empty response');
    return { role: 'assistant', content, ...(toolCalls.length ? { toolCalls } : {}), providerContent: data.content };
}

/** Make one bounded, non-streaming chat completion using an OpenAI- or Anthropic-style API. */
export async function completeConversation(
    config: VoiceModelConfig,
    system: string,
    messages: ConversationMessage[],
    tools: ConversationTool[],
    signal: AbortSignal,
): Promise<ConversationMessage> {
    if (!config.model.trim()) throw new Error('Provider model is required');
    const url = apiEndpoint(config.baseUrl, config.apiStyle === 'openai' ? 'chat/completions' : 'messages');
    const anthropic = config.apiStyle === 'anthropic';
    const body = anthropic ? {
        model: config.model, system, messages: anthropicMessages(messages), max_tokens: MAX_TOKENS,
        ...(tools.length ? { tools: tools.map(tool => ({ name: tool.name, description: tool.description, input_schema: tool.parameters })) } : {}),
    } : {
        model: config.model, messages: openAIMessages(system, messages), max_completion_tokens: MAX_TOKENS,
        ...(tools.length ? { tools: tools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } })) } : {}),
    };
    const data = jsonObject(await requestVoiceJson(url, {
        method: 'POST', redirect: 'error',
        headers: anthropic
            ? { 'content-type': 'application/json', ...(config.apiKey?.trim() ? { 'x-api-key': config.apiKey.trim() } : {}), 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' }
            : { 'content-type': 'application/json', ...(config.apiKey?.trim() ? { authorization: `Bearer ${config.apiKey.trim()}` } : {}) },
        body: JSON.stringify(body),
    }, signal));
    return anthropic ? parseAnthropic(data) : parseOpenAI(data);
}
