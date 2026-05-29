/**
 * Raw JSON-RPC 2.0 stdio MCP server with claude/channel capability.
 *
 * Bypasses the MCP SDK to send custom capabilities and notifications
 * that Claude Code recognizes for bidirectional channel communication.
 *
 * Protocol:
 *   - Declares capability "claude/channel: {}" so Claude Code enables channel mode
 *   - Exposes tool "reply" for Claude to send a response back through the relay
 *   - Sends "notifications/claude/channel" to inject incoming relay messages as user turns
 */
import { appendFileSync } from 'node:fs';
const flog = (msg: string) => { try { appendFileSync('/tmp/joy-channel.log', '[mcp] ' + msg + '\n'); } catch {} };

type JsonRpcRequest = { jsonrpc: '2.0'; id: string | number; method: string; params?: unknown };
type JsonRpcNotification = { jsonrpc: '2.0'; method: string; params?: unknown };
type JsonRpcResponse = { jsonrpc: '2.0'; id: string | number; result?: unknown; error?: { code: number; message: string } };

export interface McpServerCallbacks {
    onReply: (text: string) => Promise<void>;
    onPermissionDecision: (id: string, allow: boolean) => void;
}

export class McpChannelServer {
    private initialized = false;
    private callbacks: McpServerCallbacks;

    constructor(callbacks: McpServerCallbacks) {
        this.callbacks = callbacks;
    }

    start(): void {
        let buf = '';
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', (chunk: string) => {
            buf += chunk;
            let idx: number;
            while ((idx = buf.indexOf('\n')) !== -1) {
                const line = buf.slice(0, idx).trim();
                buf = buf.slice(idx + 1);
                if (!line) continue;
                flog('[mcp] recv: ' + line.slice(0, 120));
                let msg: JsonRpcRequest | JsonRpcNotification | undefined;
                try { msg = JSON.parse(line) as JsonRpcRequest | JsonRpcNotification; } catch { continue; }
                if (msg) void this.handleMessage(msg as JsonRpcRequest);
            }
        });
        process.stdin.on('end', () => process.exit(0));
    }

    private send(obj: JsonRpcResponse | JsonRpcNotification): void {
        const line = JSON.stringify(obj);
        flog('[mcp] send: ' + line.slice(0, 120));
        process.stdout.write(line + '\n');
    }

    private reply(id: string | number, result: unknown): void {
        this.send({ jsonrpc: '2.0', id, result });
    }

    private replyError(id: string | number, code: number, message: string): void {
        this.send({ jsonrpc: '2.0', id, error: { code, message } });
    }

    private async handleMessage(msg: JsonRpcRequest | JsonRpcNotification): Promise<void> {
        if (!('id' in msg)) {
            // It's a notification — handle initialized
            if ((msg as JsonRpcNotification).method === 'notifications/initialized') this.initialized = true;
            return;
        }
        const req = msg as JsonRpcRequest;

        switch (req.method) {
            case 'initialize': {
                this.reply(req.id, {
                    protocolVersion: '2025-11-25',
                    serverInfo: { name: 'joy-channel', version: '0.1.0' },
                    capabilities: {
                        tools: {},
                        experimental: { 'claude/channel': {} },
                    },
                    instructions: 'joy-channel: relay bridge. When you have a response for the user, call the "reply" tool.',
                });
                break;
            }

            case 'tools/list': {
                this.reply(req.id, {
                    tools: [
                        {
                            name: 'reply',
                            description: 'Send your response back to the user through the relay. Call this when you have finished working on a task and have a response to deliver.',
                            inputSchema: {
                                type: 'object',
                                properties: {
                                    text: { type: 'string', description: 'The response text to send to the user' },
                                },
                                required: ['text'],
                            },
                        },
                    ],
                });
                break;
            }

            case 'tools/call': {
                const params = req.params as { name?: string; arguments?: Record<string, unknown> };
                if (params?.name === 'reply') {
                    const text = String(params?.arguments?.text ?? '');
                    try {
                        await this.callbacks.onReply(text);
                        this.reply(req.id, { content: [{ type: 'text', text: 'Response sent to relay.' }] });
                    } catch (e) {
                        this.reply(req.id, { content: [{ type: 'text', text: `Failed to send: ${String(e)}` }], isError: true });
                    }
                } else {
                    this.replyError(req.id, -32601, `Unknown tool: ${params?.name}`);
                }
                break;
            }

            case 'ping': {
                this.reply(req.id, {});
                break;
            }

            default: {
                this.replyError(req.id, -32601, `Method not found: ${req.method}`);
            }
        }
    }

    /** Push an incoming relay message to Claude Code as a channel notification. */
    pushMessage(text: string): void {
        const notification: JsonRpcNotification = {
            jsonrpc: '2.0',
            method: 'notifications/claude/channel',
            params: {
                content: text,
                meta: {
                    chat_id: 'joy-channel',
                    message_id: crypto.randomUUID(),
                    user: 'user',
                    ts: new Date().toISOString(),
                },
            },
        };
        this.send(notification);
    }

    get isInitialized(): boolean { return this.initialized; }
}
