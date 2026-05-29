/**
 * joy-channel — bridges a browser chat UI with Claude Code via MCP channels.
 *
 * Browser  ──POST /api/send──►  joy-channel  ──notifications/claude/channel──►  Claude Code
 * Browser  ◄──GET /api/messages──  joy-channel  ◄──POST /api/hook (stop hook)──  Claude Code
 */
import { appendFileSync } from 'node:fs';
import { McpChannelServer } from './mcp.ts';

const HTTP_PORT = 7654;

interface Message {
    id: string;
    role: 'user' | 'assistant';
    text: string;
    ts: number;
}

const messages: Message[] = [];

function log(...args: unknown[]): void {
    const msg = '[joy-channel] ' + args.map(String).join(' ') + '\n';
    process.stderr.write(msg);
    try { appendFileSync('/tmp/joy-channel.log', msg); } catch {}
}

function extractLastAssistantText(body: Record<string, unknown>): string | null {
    if (typeof body.last_assistant_message === 'string' && body.last_assistant_message) {
        return body.last_assistant_message;
    }
    const transcript = body.transcript as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(transcript)) return null;
    for (let i = transcript.length - 1; i >= 0; i--) {
        const entry = transcript[i];
        const role = (entry.role ?? (entry.message as Record<string, unknown> | undefined)?.role) as string | undefined;
        if (role !== 'assistant') continue;
        const msg = (entry.message ?? entry) as Record<string, unknown>;
        const content = msg.content;
        if (typeof content === 'string') return content || null;
        if (Array.isArray(content)) {
            const parts = (content as Array<{ type?: string; text?: string }>)
                .filter(c => c.type === 'text' && c.text).map(c => c.text ?? '');
            return parts.join('\n') || null;
        }
    }
    return null;
}

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>joy-channel</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, system-ui, sans-serif; background: #f0f0f0; height: 100vh; display: flex; flex-direction: column; }
  header { background: #1a1a2e; color: white; padding: 12px 16px; display: flex; align-items: center; gap: 12px; }
  header h1 { font-size: 16px; font-weight: 600; }
  #status { font-size: 12px; padding: 3px 8px; border-radius: 12px; background: #444; }
  #status.ok { background: #2ecc71; }
  #tab-bar { display: flex; background: #fafafa; border-bottom: 1px solid #e0e0e0; }
  .tab-btn { padding: 8px 20px; border: none; background: transparent; cursor: pointer; font-size: 13px; color: #666; border-bottom: 2px solid transparent; }
  .tab-btn.active { color: #007AFF; border-bottom-color: #007AFF; font-weight: 600; }
  #chat-view { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 8px; }
  .msg { max-width: 80%; padding: 10px 14px; border-radius: 12px; font-size: 14px; line-height: 1.5; white-space: pre-wrap; word-break: break-word; }
  .msg.user { align-self: flex-end; background: #007AFF; color: white; border-bottom-right-radius: 4px; }
  .msg.assistant { align-self: flex-start; background: white; color: #1a1a1a; border-bottom-left-radius: 4px; box-shadow: 0 1px 3px rgba(0,0,0,.1); }
  .msg .meta { font-size: 10px; opacity: .6; margin-top: 4px; }
  #raw-view { flex: 1; overflow-y: auto; padding: 16px; display: none; background: #f0f0f0; }
  .raw-msg { background: white; border-radius: 8px; padding: 10px 14px; margin-bottom: 8px; box-shadow: 0 1px 3px rgba(0,0,0,.1); }
  .raw-msg .raw-meta { color: #888; font-size: 11px; margin-bottom: 6px; font-family: monospace; }
  .raw-msg pre { margin: 0; white-space: pre-wrap; word-break: break-all; font-size: 11px; }
  #input-area { padding: 12px 16px; background: white; border-top: 1px solid #e0e0e0; display: flex; gap: 8px; }
  #input { flex: 1; padding: 10px 14px; border: 1px solid #ddd; border-radius: 20px; font-size: 14px; outline: none; resize: none; height: 40px; }
  #input:focus { border-color: #007AFF; }
  button#send { background: #007AFF; color: white; border: none; border-radius: 20px; padding: 0 20px; height: 40px; font-size: 14px; cursor: pointer; }
  button#send:disabled { opacity: .5; cursor: default; }
</style>
</head>
<body>
<header>
  <h1>joy-channel</h1>
  <span id="status">connecting...</span>
</header>
<div id="tab-bar">
  <button class="tab-btn active" onclick="showTab('chat')">Chat</button>
  <button class="tab-btn" onclick="showTab('raw')">Raw</button>
</div>
<div id="chat-view"></div>
<div id="raw-view"></div>
<div id="input-area">
  <textarea id="input" placeholder="Type a message..." rows="1"></textarea>
  <button id="send" onclick="sendMsg()">Send</button>
</div>
<script>
let lastCount = 0;
let connected = false;

function esc(t) {
  return t.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function showTab(tab) {
  document.querySelectorAll('.tab-btn').forEach((b, i) => b.classList.toggle('active', i === (tab === 'chat' ? 0 : 1)));
  document.getElementById('chat-view').style.display = tab === 'chat' ? 'flex' : 'none';
  document.getElementById('raw-view').style.display = tab === 'raw' ? 'block' : 'none';
}

function renderChat(msgs) {
  const el = document.getElementById('chat-view');
  const atBottom = el.scrollHeight - el.scrollTop <= el.clientHeight + 60;
  el.innerHTML = msgs.map(m => \`
    <div class="msg \${m.role}">
      \${esc(m.text)}
      <div class="meta">\${m.role} · \${new Date(m.ts).toLocaleTimeString()}</div>
    </div>
  \`).join('');
  if (atBottom) el.scrollTop = el.scrollHeight;
}

function renderRaw(msgs) {
  const el = document.getElementById('raw-view');
  const atBottom = el.scrollHeight - el.scrollTop <= el.clientHeight + 60;
  el.innerHTML = msgs.map(m => \`
    <div class="raw-msg">
      <div class="raw-meta">\${m.role} &middot; \${new Date(m.ts).toLocaleTimeString()}</div>
      <pre>\${esc(JSON.stringify(m, null, 2))}</pre>
    </div>
  \`).join('');
  if (atBottom) el.scrollTop = el.scrollHeight;
}

async function poll() {
  try {
    const r = await fetch('/api/messages');
    if (!r.ok) throw new Error(r.status);
    const { messages } = await r.json();
    if (!connected) {
      connected = true;
      document.getElementById('status').textContent = 'connected';
      document.getElementById('status').className = 'ok';
    }
    if (messages.length !== lastCount) {
      lastCount = messages.length;
      renderChat(messages);
      renderRaw(messages);
    }
  } catch {
    document.getElementById('status').textContent = 'disconnected';
    document.getElementById('status').className = '';
  }
  setTimeout(poll, 1000);
}

async function sendMsg() {
  const input = document.getElementById('input');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  document.getElementById('send').disabled = true;
  try {
    await fetch('/api/send', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({text}) });
  } finally {
    document.getElementById('send').disabled = false;
  }
}

document.getElementById('input').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMsg(); }
});

poll();
</script>
</body>
</html>`;

const mcp = new McpChannelServer({
    async onReply(text: string) {
        messages.push({ id: crypto.randomUUID(), role: 'assistant', text, ts: Date.now() });
        log(`reply tool: ${text.length} chars`);
    },
    onPermissionDecision() {},
});

Bun.serve({
    port: HTTP_PORT,
    async fetch(req) {
        const url = new URL(req.url);

        if (url.pathname === '/') {
            return new Response(HTML, { headers: { 'Content-Type': 'text/html' } });
        }

        if (url.pathname === '/api/messages') {
            return Response.json({ messages });
        }

        if (url.pathname === '/api/send' && req.method === 'POST') {
            const body = await req.json() as { text?: string };
            if (!body.text) return new Response('missing text', { status: 400 });
            const text = body.text;
            messages.push({ id: crypto.randomUUID(), role: 'user', text, ts: Date.now() });
            mcp.pushMessage(text);
            log(`user → Claude: ${text.slice(0, 60)}`);
            return Response.json({ ok: true });
        }

        if (url.pathname === '/api/hook' && req.method === 'POST') {
            try {
                const body = await req.json() as Record<string, unknown>;
                const text = extractLastAssistantText(body);
                if (text) {
                    messages.push({ id: crypto.randomUUID(), role: 'assistant', text, ts: Date.now() });
                    log(`stop hook → stored: ${text.length} chars`);
                }
            } catch (e) { log('stop hook error:', e); }
            return Response.json({ continue: true });
        }

        return new Response('Not found', { status: 404 });
    },
});

log(`HTTP server on :${HTTP_PORT}`);

if (!process.argv.includes('--http-only')) {
    mcp.start();
    log('MCP stdio server started');
} else {
    log('HTTP-only mode');
    setInterval(() => {}, 60_000);
}
