// Reconciliation proof (turn-checkpoint model): run a turn in session A, then
// "restart" the SAME session id (B) resuming A's thread. B must NOT re-surface
// the already-delivered turn (checkpoint skip), and a NEW message to B must
// appear. This proves exactly-once across a daemon restart.
import { CodexSession } from '/home/claude/Workspace/joy/packages/joy-daemon/src/codex/codexSession.ts';
import { mkdirSync } from 'fs';

const CWD = '/tmp/claude-1000/cxreconwork';
mkdirSync(CWD, { recursive: true });
const SID = 'recon'; // SAME id for A and B (a restart reuses the session id)

class MockRelay {
  relaySessionId = 'mock'; onMessage = () => {}; onFileEvent = () => {};
  sent = [];
  send(r, localId) { this.sent.push({ ev: r.content?.data?.ev, role: r.role, localId }); }
  setThinking() {} setReceiptSink() {} stampReceiptOnLastQueued() {}
  updateModelCode() {} updateContext() {} updateJoyState() {} updateQueue() {}
  start() {} pausePull() {} stop() {} reassertAlive() {}
}
const deps = { relayClient: null, broadcast: () => {}, addChatMessage: () => {}, onRelayAttached: () => {} };
const waitFor = (c, ms, l) => new Promise((res, rej) => { const t0 = Date.now(); const iv = setInterval(() => { if (c()) { clearInterval(iv); res(); } else if (Date.now() - t0 > ms) { clearInterval(iv); rej(new Error('timeout ' + l)); } }, 200); });
const turnEvents = (relay) => relay.sent.filter((s) => s.ev && (s.ev.t === 'turn-start' || s.ev.t === 'text' || s.ev.t === 'turn-end'));

async function main() {
  // ── A: fresh, deliver one turn ──
  const A = new CodexSession({ id: SID, tmuxWindow: 'x:a', cwd: CWD, permissionMode: 'yolo', status: 'starting', startedAt: Date.now() }, deps);
  const ra = new MockRelay(); A.attachRelay(ra); A.beginWatching();
  await waitFor(() => A.status === 'active', 20000, 'A start');
  A.enqueue('Reply with exactly the word: alpha', { mirrorToRelay: true });
  await waitFor(() => ra.sent.some((s) => s.ev?.t === 'turn-end'), 90000, 'A turn');
  const aThread = ra.sent.find((s) => s.localId)?.localId?.split(':')[1];
  console.log('A delivered turn events:', turnEvents(ra).length, '| thread', aThread);

  A.end('process_exited'); // daemon-side death (NOT killed — preserves checkpoint)
  await new Promise((r) => setTimeout(r, 1500));

  // ── B: restart SAME id, resume A's thread ──
  const B = new CodexSession({ id: SID, tmuxWindow: 'x:b', cwd: CWD, permissionMode: 'yolo', status: 'starting', startedAt: Date.now(), codexThreadId: aThread }, deps);
  const rb = new MockRelay(); B.attachRelay(rb); B.beginWatching();
  await waitFor(() => B.status === 'active', 25000, 'B resume');
  await new Promise((r) => setTimeout(r, 1500)); // let reconcile settle
  const bAfterReconcile = turnEvents(rb).length;
  console.log('B turn events after reconcile (should be 0 — already delivered):', bAfterReconcile);

  // ── New message to B → must appear ──
  B.enqueue('Reply with exactly the word: beta', { mirrorToRelay: true });
  await waitFor(() => rb.sent.some((s) => s.ev?.t === 'turn-end'), 90000, 'B new turn');
  const bNewTurn = turnEvents(rb).length;
  console.log('B turn events after new message:', bNewTurn);

  const noReplay = bAfterReconcile === 0;               // delivered turn not re-shown
  const newDelivered = bNewTurn > 0;                     // new message got through
  const gotBeta = rb.sent.some((s) => s.ev?.t === 'text' && s.ev.text === 'beta');

  console.log('\n=== RESULTS ===');
  console.log('delivered turn NOT re-surfaced :', noReplay);
  console.log('new message delivered on B     :', newDelivered);
  console.log('B produced the new answer      :', gotBeta);

  B.end('killed');
  if (noReplay && newDelivered && gotBeta) { console.log('\nRECONCILE PASS'); process.exit(0); }
  else { console.log('\nRECONCILE FAIL'); process.exit(1); }
}
main().catch((e) => { console.error('FAIL', e); process.exit(1); });
