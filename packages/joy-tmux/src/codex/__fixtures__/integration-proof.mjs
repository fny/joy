// Live integration proof: real codex app-server → CodexAppServerClient →
// CodexNormalizer → assert the claude-shaped wire sequence. Run with tsx so the
// TS modules load directly.
import { spawnCodexAppServer, CodexAppServerClient } from '/home/claude/Workspace/joy/packages/joy-tmux/src/codex/appServerClient.ts';
import { CodexNormalizer } from '/home/claude/Workspace/joy/packages/joy-tmux/src/codex/normalize.ts';
import { mkdirSync, rmSync } from 'fs';

const SOCK = '/tmp/claude-1000/cxint.sock';
const CWD = '/tmp/claude-1000/cxintwork';
rmSync(SOCK, { force: true });
mkdirSync(CWD, { recursive: true });

const proc = spawnCodexAppServer({ socketPath: SOCK });
proc.stderr.on('data', () => {}); // swallow bubblewrap warning

async function main() {
  // wait for the socket to be bound
  await new Promise((r) => setTimeout(r, 2500));

  const client = new CodexAppServerClient();
  const wire = [];
  let n = 0;
  const norm = new CodexNormalizer(() => `turn-${++n}`);
  const effects = [];

  client.onNotification((notif) => {
    for (const e of norm.handle(notif)) {
      effects.push(e);
      if (e.kind === 'wire') wire.push(e.record.content.data.ev);
    }
  });
  // yolo: no approvals should occur, but answer anything so nothing hangs
  client.onServerRequest(() => ({ decision: 'accept' }));

  const init = await client.connect(SOCK);
  console.log('INIT ok — userAgent:', init.userAgent);

  const { threadId, rolloutPath } = await client.threadStart({ cwd: CWD, permissionMode: 'yolo' });
  console.log('THREAD', threadId, '\n  rollout', rolloutPath);

  const done = new Promise((resolve) => {
    const orig = norm.handle.bind(norm);
    // resolve when we see a turn-end wire record
    const check = setInterval(() => {
      if (wire.some((w) => w?.t === 'turn-end')) { clearInterval(check); resolve(); }
    }, 200);
  });

  const { turnId } = await client.turnStart(threadId, "Run the shell command: echo integration-ok. Then reply with the single word done.", { clientUserMessageId: 'joy-int-1' });
  console.log('TURN', turnId);

  await Promise.race([done, new Promise((_, rej) => setTimeout(() => rej(new Error('turn timeout')), 90000))]);

  console.log('\n=== WIRE SEQUENCE ===');
  for (const w of wire) console.log(' ', JSON.stringify(w));

  // Assertions
  const types = wire.map((w) => w.t);
  const has = (t) => types.includes(t);
  const ok = has('turn-start') && has('tool-call-start') && has('tool-call-end') && has('text') && has('turn-end')
    && wire.find((w) => w.t === 'tool-call-start')?.name === 'CodexBash'
    && wire.find((w) => w.t === 'turn-end')?.status === 'completed';
  const confirmed = effects.some((e) => e.kind === 'confirmDispatch' && e.clientId === 'joy-int-1');
  const thinkingCycled = effects.some((e) => e.kind === 'thinking' && e.value === true)
    && effects.some((e) => e.kind === 'thinking' && e.value === false);

  console.log('\n=== RESULTS ===');
  console.log('wire sequence claude-shaped :', ok);
  console.log('dispatch confirmed by clientId:', confirmed);
  console.log('thinking cycled on→off       :', thinkingCycled);

  client.close();
  proc.kill();
  if (ok && confirmed && thinkingCycled) { console.log('\nINTEGRATION PASS'); process.exit(0); }
  else { console.log('\nINTEGRATION FAIL'); process.exit(1); }
}

main().catch((e) => { console.error('FAIL', e); proc.kill(); process.exit(1); });
