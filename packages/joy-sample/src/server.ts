/**
 * joy-sample — minimal chat UI server for testing joy-channel.
 *
 * Reads session info from joy-channel's HTTP server (:7654/api/info),
 * decrypts relay messages on the server, and serves a simple chat UI.
 *
 * Browser ←→ this server ←→ relay (encrypted)
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { encrypt, decrypt, b64encode, b64decode, type EncryptionVariant } from './crypto.ts';

const CHANNEL_INFO_URL = process.env.JOY_CHANNEL_URL ?? 'http://localhost:7654/api/info';
const UI_PORT = 7655;
const POLL_INTERVAL_MS = 1500;

const __dir = dirname(fileURLToPath(import.meta.url));

// ── Session state ─────────────────────────────────────────────────────────────

interface ChannelInfo {
    sessionId: string;
    relayUrl: string;
    contentKeyB64: string;
    variant: EncryptionVariant;
}

interface ChatMessage {
    id: string;
    role: 'user' | 'agent';
    text: string;
    ts: number;
}

let channelInfo: ChannelInfo | null = null;
let sessionKey: Uint8Array | null = null;
let maxSeq = 0;
const messages: ChatMessage[] = [];
const rawMessages: Array<{ seq: number; ts: number; payload: unknown }> = [];

function log(...args: unknown[]): void {
    console.log('[joy-sample]', ...args);
}

// ── Fetch session info ────────────────────────────────────────────────────────

async function fetchChannelInfo(): Promise<void> {
    const res = await fetch(CHANNEL_INFO_URL);
    if (!res.ok) throw new Error(`channel info HTTP ${res.status}`);
    channelInfo = (await res.json()) as ChannelInfo;
    sessionKey = b64decode(channelInfo.contentKeyB64);
    log(`session: ${channelInfo.sessionId} variant=${channelInfo.variant} relay=${channelInfo.relayUrl}`);
}

// ── Relay helpers ─────────────────────────────────────────────────────────────

function relayHeaders(): Record<string, string> {
    return {
        Authorization: `Bearer ${getToken()}`,
        'Content-Type': 'application/json',
    };
}

function getToken(): string {
    const home = process.env.HAPPY_HOME_DIR ?? `${process.env.HOME}/.happy`;
    try {
        const ak = JSON.parse(readFileSync(`${home}/access.key`, 'utf8')) as { token?: string };
        if (ak.token) return ak.token;
    } catch { /* fall through */ }
    return process.env.HAPPY_TOKEN ?? '';
}

function extractText(payload: unknown): { text: string; role: 'user' | 'agent' } | null {
    if (!payload || typeof payload !== 'object') return null;
    const p = payload as Record<string, unknown>;
    if (p.role === 'user' || p.role === 'agent') {
        const content = p.content as Record<string, unknown> | undefined;
        if (content?.type === 'acp') {
            const data = content.data as Record<string, unknown> | undefined;
            if (typeof data?.content === 'string') return { text: data.content, role: p.role as 'user' | 'agent' };
            if (Array.isArray(data?.content)) {
                const text = (data.content as Array<{ type?: string; text?: string }>)
                    .filter(c => c.type === 'text' && c.text)
                    .map(c => c.text ?? '')
                    .join('\n');
                if (text) return { text, role: p.role as 'user' | 'agent' };
            }
        }
        if (typeof content === 'string' && content) return { text: content, role: p.role as 'user' | 'agent' };
    }
    return null;
}

// ── Polling ───────────────────────────────────────────────────────────────────

async function pollRelay(): Promise<void> {
    if (!channelInfo || !sessionKey) return;
    const { sessionId, relayUrl, variant } = channelInfo;
    const key = sessionKey;
    try {
        const u = `${relayUrl.replace(/\/$/, '')}/v3/sessions/${encodeURIComponent(sessionId)}/messages?after_seq=${maxSeq}&limit=50`;
        const res = await fetch(u, { headers: relayHeaders() });
        if (!res.ok) return;
        const data = (await res.json()) as { messages: Array<{ seq: number; content: unknown }> };
        for (const m of data.messages) {
            if (m.seq > maxSeq) maxSeq = m.seq;
            const raw = typeof m.content === 'string' ? m.content : (m.content as { c?: string })?.c;
            if (!raw) continue;
            const decrypted = decrypt(variant, key, b64decode(raw));
            rawMessages.push({ seq: m.seq, ts: Date.now(), payload: decrypted });
            const parsed = extractText(decrypted);
            if (parsed) {
                messages.push({ id: `${m.seq}`, role: parsed.role, text: parsed.text, ts: Date.now() });
            }
        }
    } catch (e) {
        log('poll error:', e);
    }
}

// ── Send message to relay ─────────────────────────────────────────────────────

async function sendMessage(text: string): Promise<void> {
    if (!channelInfo || !sessionKey) throw new Error('not connected');
    const { sessionId, relayUrl, variant } = channelInfo;
    const key = sessionKey;
    const localId = b64encode(new Uint8Array(randomBytes(16)));
    const payload = {
        role: 'user',
        content: { type: 'acp', provider: 'claude', data: { role: 'user', content: text } },
        meta: { sentFrom: 'joy-sample' },
    };
    const encrypted = encrypt(variant, key, payload);
    const body = JSON.stringify({ messages: [{ content: b64encode(encrypted), localId }] });
    const res = await fetch(`${relayUrl.replace(/\/$/, '')}/v3/sessions/${encodeURIComponent(sessionId)}/messages`, {
        method: 'POST',
        headers: relayHeaders(),
        body,
    });
    if (!res.ok) throw new Error(`relay POST ${res.status}`);
}

// ── HTML UI ───────────────────────────────────────────────────────────────────

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>joy-sample</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, system-ui, sans-serif; background: #f0f0f0; height: 100vh; display: flex; flex-direction: column; }
  header { background: #1a1a2e; color: white; padding: 12px 16px; display: flex; align-items: center; gap: 12px; }
  header h1 { font-size: 16px; font-weight: 600; }
  #status { font-size: 12px; padding: 3px 8px; border-radius: 12px; background: #444; }
  #status.connected { background: #2ecc71; }
  #status.error { background: #e74c3c; }
  #messages { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 8px; }
  .msg { max-width: 80%; padding: 10px 14px; border-radius: 12px; font-size: 14px; line-height: 1.5; white-space: pre-wrap; word-break: break-word; }
  .msg.user { align-self: flex-end; background: #007AFF; color: white; border-bottom-right-radius: 4px; }
  .msg.agent { align-self: flex-start; background: white; color: #1a1a1a; border-bottom-left-radius: 4px; box-shadow: 0 1px 3px rgba(0,0,0,.1); }
  .msg .meta { font-size: 10px; opacity: .6; margin-top: 4px; }
  #input-area { padding: 12px 16px; background: white; border-top: 1px solid #e0e0e0; display: flex; gap: 8px; }
  #input { flex: 1; padding: 10px 14px; border: 1px solid #ddd; border-radius: 20px; font-size: 14px; outline: none; resize: none; height: 40px; }
  #input:focus { border-color: #007AFF; }
  button { background: #007AFF; color: white; border: none; border-radius: 20px; padding: 0 20px; height: 40px; font-size: 14px; cursor: pointer; }
  button:disabled { opacity: .5; cursor: default; }
  #session-info { font-size: 11px; color: #999; padding: 6px 16px; background: #fafafa; border-bottom: 1px solid #eee; font-family: monospace; }
  #tab-bar { display: flex; background: #fafafa; border-bottom: 1px solid #e0e0e0; }
  .tab-btn { padding: 8px 20px; border: none; background: transparent; cursor: pointer; font-size: 13px; color: #666; border-bottom: 2px solid transparent; }
  .tab-btn.active { color: #007AFF; border-bottom-color: #007AFF; font-weight: 600; }
  #raw-view { flex: 1; overflow-y: auto; padding: 16px; display: none; background: #f0f0f0; }
  .raw-msg { background: white; border-radius: 8px; padding: 10px 14px; margin-bottom: 8px; box-shadow: 0 1px 3px rgba(0,0,0,.1); }
  .raw-msg .raw-meta { color: #888; font-size: 11px; margin-bottom: 6px; font-family: monospace; }
  .raw-msg pre { margin: 0; white-space: pre-wrap; word-break: break-all; font-size: 11px; color: #1a1a1a; }
</style>
</head>
<body>
<header>
  <h1>joy-sample</h1>
  <span id="status">connecting...</span>
</header>
<div id="session-info">session: loading...</div>
<div id="tab-bar">
  <button class="tab-btn active" onclick="showTab('chat')">Chat</button>
  <button class="tab-btn" onclick="showTab('raw')">Raw</button>
</div>
<div id="messages"></div>
<div id="raw-view"></div>
<div id="input-area">
  <textarea id="input" placeholder="Type a message..." rows="1"></textarea>
  <button id="send" onclick="sendMsg()">Send</button>
</div>
<script>
let lastCount = 0;
let lastRawCount = 0;
let connected = false;

function escapeHtml(t) {
  return t.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function showTab(tab) {
  document.querySelectorAll('.tab-btn').forEach((b, i) => b.classList.toggle('active', i === (tab === 'chat' ? 0 : 1)));
  document.getElementById('messages').style.display = tab === 'chat' ? 'flex' : 'none';
  document.getElementById('raw-view').style.display = tab === 'raw' ? 'block' : 'none';
}

function renderRaw(msgs) {
  const el = document.getElementById('raw-view');
  const atBottom = el.scrollHeight - el.scrollTop <= el.clientHeight + 60;
  el.innerHTML = msgs.map(m => \`
    <div class="raw-msg">
      <div class="raw-meta">seq=\${m.seq} &middot; \${new Date(m.ts).toLocaleTimeString()}</div>
      <pre>\${escapeHtml(JSON.stringify(m.payload, null, 2))}</pre>
    </div>
  \`).join('');
  if (atBottom) el.scrollTop = el.scrollHeight;
}

async function poll() {
  try {
    const r = await fetch('/api/messages');
    if (!r.ok) throw new Error(r.status);
    const data = await r.json();
    if (!connected) {
      connected = true;
      document.getElementById('status').textContent = 'connected';
      document.getElementById('status').className = 'connected';
      document.getElementById('session-info').textContent = 'session: ' + (data.sessionId || '—');
    }
    if (data.messages.length !== lastCount) {
      lastCount = data.messages.length;
      renderMessages(data.messages);
    }
    if (data.rawMessages && data.rawMessages.length !== lastRawCount) {
      lastRawCount = data.rawMessages.length;
      renderRaw(data.rawMessages);
    }
  } catch(e) {
    document.getElementById('status').textContent = 'error';
    document.getElementById('status').className = 'error';
  }
  setTimeout(poll, 1200);
}

function renderMessages(msgs) {
  const el = document.getElementById('messages');
  const atBottom = el.scrollHeight - el.scrollTop <= el.clientHeight + 60;
  el.innerHTML = msgs.map(m => \`
    <div class="msg \${m.role}">
      \${escapeHtml(m.text)}
      <div class="meta">\${m.role} · \${new Date(m.ts).toLocaleTimeString()}</div>
    </div>
  \`).join('');
  if (atBottom) el.scrollTop = el.scrollHeight;
}

async function sendMsg() {
  const input = document.getElementById('input');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  document.getElementById('send').disabled = true;
  try {
    await fetch('/api/send', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({text}) });
  } catch(e) { console.error(e); }
  document.getElementById('send').disabled = false;
}

document.getElementById('input').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMsg(); }
});

poll();
</script>
</body>
</html>`;

// ── HTTP server ───────────────────────────────────────────────────────────────

Bun.serve({
    port: UI_PORT,
    async fetch(req) {
        const url = new URL(req.url);

        if (url.pathname === '/') {
            return new Response(HTML, { headers: { 'Content-Type': 'text/html' } });
        }

        if (url.pathname === '/api/messages') {
            return Response.json({
                messages,
                rawMessages,
                sessionId: channelInfo?.sessionId ?? null,
            });
        }

        if (url.pathname === '/api/send' && req.method === 'POST') {
            try {
                const body = (await req.json()) as { text?: string };
                if (!body.text) return new Response('missing text', { status: 400 });
                await sendMessage(body.text);
                return Response.json({ ok: true });
            } catch (e) {
                return new Response(String(e), { status: 500 });
            }
        }

        return new Response('Not found', { status: 404 });
    },
});

log(`UI server on http://localhost:${UI_PORT}`);

// ── Startup ───────────────────────────────────────────────────────────────────

async function recheckChannelInfo(): Promise<void> {
    try {
        const res = await fetch(CHANNEL_INFO_URL);
        if (!res.ok) return;
        const info = (await res.json()) as ChannelInfo;
        if (info.sessionId !== channelInfo?.sessionId) {
            log(`Session changed: ${channelInfo?.sessionId ?? 'none'} → ${info.sessionId}`);
            channelInfo = info;
            sessionKey = b64decode(info.contentKeyB64);
            maxSeq = 0;
            messages.length = 0;
            rawMessages.length = 0;
        }
    } catch { /* ignore — joy-channel may be restarting */ }
}

async function startup(): Promise<void> {
    log('Waiting for joy-channel...');
    for (let i = 0; i < 30; i++) {
        try {
            await fetchChannelInfo();
            break;
        } catch {
            if (i < 29) await new Promise(r => setTimeout(r, 1000));
            else throw new Error('joy-channel not available after 30s');
        }
    }
    log('Connected to relay. Starting poll...');
    setInterval(() => void pollRelay(), POLL_INTERVAL_MS);
    setInterval(() => void recheckChannelInfo(), 10_000);
}

startup().catch(e => {
    console.error('[joy-sample] startup failed:', e);
    process.exit(1);
});
