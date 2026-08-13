// Live proof: real OpencodeSession + mock relay against a real opencode serve.
// Asserts the claude-shaped wire sequence for a tool turn on kimi-k3.
import { OpencodeSession } from '/home/claude/Workspace/joy/packages/joy-daemon/src/opencode/opencodeSession.ts';
import { mkdirSync } from 'fs';

const CWD = '/tmp/claude-1000/ocproof';
mkdirSync(CWD, { recursive: true });

class MockRelay {
  relaySessionId = 'mock-rs';
  onMessage = () => {};
  wire = []; thinking = [];
  send(r, localId) { this.wire.push({ ev: r.content?.data?.ev ?? { role: r.role }, localId }); }
  setThinking(v) { this.thinking.push(v); }
  setReceiptSink() {} stampReceiptOnLastQueued() {}
  contexts = []; models = []; titles = [];
  async updateSummary(t) { this.titles.push(t); }
  updateModelCode(c) { this.models.push(c); } updateContext(t) { this.contexts.push(t); } updateJoyState() {} updateCodexApproval() {}
  registerRpc() {} start() {} pausePull() {} stop() {}
}
const deps = { relayClient: null, broadcast: () => {}, addChatMessage: () => {}, onRelayAttached: () => {} };
const waitFor = (cond, ms, label) => new Promise((res, rej) => {
  const t0 = Date.now();
  const iv = setInterval(() => {
    if (cond()) { clearInterval(iv); res(); }
    else if (Date.now() - t0 > ms) { clearInterval(iv); rej(new Error('timeout: ' + label)); }
  }, 300);
});

const s = new OpencodeSession(
  { id: 'ocproof1', cwd: CWD, model: 'accounts/fireworks/models/kimi-k3', providerID: 'fireworks-ai', status: 'starting', startedAt: Date.now() },
  deps,
);
const relay = new MockRelay();
// TAP raw events for diagnosis
const seen = [];
globalThis.__ocTap = (e) => seen.push(e.type + (e.durable?.seq!=null ? ':'+e.durable.seq : ''));
setInterval(() => {}, 1000); // keep loop alive
process.on('exit', () => console.log('raw events:', seen.join(', ') || '(none)'));
s.attachRelay(relay);
s.beginWatching();
await waitFor(() => s.status === 'active', 60000, 'server start');
console.log('active. oc session:', s.opencodeSessionId, '| model:', s.currentModel);

s.enqueue('Run the shell command: echo proof-ok. Then reply with just: done', { mirrorToRelay: true });
await waitFor(() => relay.wire.some(w => w.ev?.t === 'turn-end'), 120000, 'turn end');

const types = relay.wire.map(w => w.ev?.t).filter(Boolean);
console.log('wire:', types.join(' → '));
const ok = ['turn-start','tool-call-start','tool-call-end','text','turn-end'].every(t => types.includes(t));
const localIds = relay.wire.filter(w => w.localId).every(w => String(w.localId).startsWith('oc:'));
const thinking = relay.thinking.includes(true) && relay.thinking[relay.thinking.length-1] === false;
console.log('sequence ok:', ok, '| deterministic localIds:', localIds, '| thinking cycled:', thinking);
const textEv = relay.wire.find(w => w.ev?.t === 'text');
console.log('text:', textEv?.ev?.text?.slice(0, 60));
console.log('context updates:', relay.contexts);
console.log('auto-title:', JSON.stringify(relay.titles));
// mid-session model switch
const sw = await s.setModel('accounts/fireworks/models/glm-5p2', 'fireworks-ai');
console.log('setModel:', JSON.stringify(sw), '| currentModel:', s.currentModel, '| relay saw:', relay.models.at(-1));
s.end('killed');
process.exit(ok && localIds && thinking ? 0 : 1);
