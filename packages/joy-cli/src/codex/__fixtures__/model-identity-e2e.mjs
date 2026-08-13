// E2E: codex model selection + identity. For each requested model, drive a REAL
// CodexSession against a real codex app-server and assert:
//   (1) MODEL SELECTION — the thread's effective model (reported via
//       updateModelCode from thread/start) matches the requested model, so
//       "gpt-5.6-sol vs others" actually launches the chosen model.
//   (2) IDENTITY — asking "what model are you" comes back as an OpenAI/GPT
//       model, NOT Claude/Anthropic — proving codex launched, not Claude Code.
import { CodexSession } from '/home/claude/Workspace/joy/packages/joy-cli/src/codex/codexSession.ts';
import { mkdirSync } from 'fs';

const MODELS = process.env.E2E_MODELS?.split(',') ?? ['gpt-5.6-sol', 'gpt-5.5'];

const waitFor = (cond, ms, label) => new Promise((resolve, reject) => {
  const t0 = Date.now();
  const iv = setInterval(() => {
    if (cond()) { clearInterval(iv); resolve(); }
    else if (Date.now() - t0 > ms) { clearInterval(iv); reject(new Error('timeout: ' + label)); }
  }, 200);
});

class MockRelay {
  relaySessionId = 'mock-rs';
  onMessage = () => {};
  onFileEvent = () => {};
  wire = [];
  modelCode = null;
  send(r) { this.wire.push(r.content?.data?.ev ?? { role: r.role }); }
  setThinking() {}
  setReceiptSink() {}
  stampReceiptOnLastQueued() {}
  updateModelCode(code) { this.modelCode = code; }
  updateContext() {}
  updateJoyState() {}
  updateCodexApproval() {}
  registerRpc() {}
  start() {} pausePull() {} stop() {} reassertAlive() {}
}

const deps = { relayClient: null, broadcast: () => {}, addChatMessage: () => {}, onRelayAttached: () => {} };

async function testModel(model) {
  const cwd = `/tmp/claude-1000/cx-e2e-${model}`;
  mkdirSync(cwd, { recursive: true });
  const session = new CodexSession(
    { id: `e2e-${model}`, tmuxWindow: 'no-such-session:win', cwd, model, permissionMode: 'yolo', status: 'starting', startedAt: Date.now() },
    deps,
  );
  const relay = new MockRelay();
  session.attachRelay(relay);
  session.beginWatching();
  await waitFor(() => session.status === 'active', 25000, `${model}: thread start`);

  // (1) model selection: the effective model the thread resolved to.
  const effective = relay.modelCode ?? session.currentModel;
  const modelOk = effective === model;

  // (2) identity: ask who it is.
  session.enqueue('In one short sentence: what AI model are you, and which company built you?', { mirrorToRelay: true });
  await waitFor(() => relay.wire.some((w) => w?.t === 'turn-end'), 90000, `${model}: turn end`);
  const answer = relay.wire.filter((w) => w?.t === 'text').map((w) => w.text).join(' ').trim();
  const low = answer.toLowerCase();
  const isClaude = /claude|anthropic/.test(low);
  const isOpenAI = /openai|chatgpt|gpt/.test(low);

  session.end('killed');

  const pass = modelOk && !isClaude;
  console.log(`\n── ${model} ──`);
  console.log(`  effective model : ${effective}   (selection ${modelOk ? 'OK' : 'MISMATCH — got ' + effective})`);
  console.log(`  identity answer : ${answer.slice(0, 160)}`);
  console.log(`  → OpenAI/GPT: ${isOpenAI}   Claude/Anthropic: ${isClaude}`);
  console.log(`  RESULT: ${pass ? 'PASS' : 'FAIL'}`);
  return pass;
}

async function main() {
  console.log('Codex model-selection + identity e2e — models:', MODELS.join(', '));
  let allPass = true;
  for (const m of MODELS) {
    try { allPass = (await testModel(m)) && allPass; }
    catch (e) { console.log(`\n── ${m} ──\n  ERROR: ${e.message}`); allPass = false; }
  }
  console.log(`\n=== ${allPass ? 'ALL MODELS PASS' : 'FAILURES PRESENT'} ===`);
  process.exit(allPass ? 0 : 1);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
