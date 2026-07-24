// Daemon-level proof: drive the REAL CodexSession class end-to-end against a
// real app-server, with a mock RelaySession capturing the wire output.
import { CodexSession } from '/home/claude/Workspace/joy/packages/joy-tmux/src/codex/codexSession.ts';
import { mkdirSync } from 'fs';

const CWD = '/tmp/claude-1000/cxsintwork';
mkdirSync(CWD, { recursive: true });

class MockRelay {
  relaySessionId = 'mock-rs';
  onMessage = () => {};
  onFileEvent = () => {};
  wire = [];
  thinking = [];
  send(r) { this.wire.push(r.content?.data?.ev ?? { role: r.role, content: r.content }); }
  setThinking(v) { this.thinking.push(v); }
  setReceiptSink() {}
  stampReceiptOnLastQueued() {}
  updateModelCode() {}
  updateContext() {}
  updateJoyState() {}
  updateQueue() {}
  start() {}
  pausePull() {}
  stop() {}
  reassertAlive() {}
}

const deps = { relayClient: null, broadcast: () => {}, addChatMessage: () => {}, onRelayAttached: () => {} };

const waitFor = (cond, ms, label) => new Promise((resolve, reject) => {
  const t0 = Date.now();
  const iv = setInterval(() => {
    if (cond()) { clearInterval(iv); resolve(); }
    else if (Date.now() - t0 > ms) { clearInterval(iv); reject(new Error('timeout: ' + label)); }
  }, 200);
});

async function main() {
  const session = new CodexSession(
    { id: 'inttest', tmuxWindow: 'no-such-session:win', cwd: CWD, permissionMode: 'yolo', status: 'starting', startedAt: Date.now() },
    deps,
  );
  const relay = new MockRelay();
  session.attachRelay(relay);
  session.beginWatching();

  await waitFor(() => session.status === 'active', 20000, 'thread start');
  console.log('CodexSession active. thread rollout:', session.transcriptPath);

  // Deliver a message through the daemon's own intake path.
  session.enqueue('Run the shell command: echo daemon-path-ok. Then reply with the single word done.', { mirrorToRelay: true });

  await waitFor(() => relay.wire.some((w) => w?.t === 'turn-end'), 90000, 'turn end');

  console.log('\n=== WIRE (captured by mock relay) ===');
  for (const w of relay.wire) console.log(' ', JSON.stringify(w));

  const types = relay.wire.map((w) => w?.t).filter(Boolean);
  const userMirrored = relay.wire.some((w) => w?.role === 'user');
  const ok = ['turn-start', 'tool-call-start', 'tool-call-end', 'text', 'turn-end'].every((t) => types.includes(t))
    && relay.wire.find((w) => w?.t === 'tool-call-start')?.name === 'CodexBash'
    && relay.wire.find((w) => w?.t === 'turn-end')?.status === 'completed';
  const busyWorked = relay.thinking.includes(true) && relay.thinking.includes(false);

  console.log('\n=== RESULTS ===');
  console.log('user message mirrored to relay :', userMirrored);
  console.log('claude-shaped output sequence  :', ok);
  console.log('thinking cycled (busy signal)  :', busyWorked);

  session.end('killed');
  if (userMirrored && ok && busyWorked) { console.log('\nDAEMON-PATH PASS'); process.exit(0); }
  else { console.log('\nDAEMON-PATH FAIL'); process.exit(1); }
}

main().catch((e) => { console.error('FAIL', e); process.exit(1); });
