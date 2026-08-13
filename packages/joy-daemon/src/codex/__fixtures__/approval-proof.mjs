import { CodexSession } from '/home/claude/Workspace/joy/packages/joy-daemon/src/codex/codexSession.ts';
import { mkdirSync } from 'fs';
mkdirSync('/tmp/claude-1000/cxapwork', { recursive: true });
class MockRelay {
  relaySessionId='m'; onMessage=()=>{}; onFileEvent=()=>{}; approvals=[]; rpcs={};
  send(){} setThinking(){} setReceiptSink(){} stampReceiptOnLastQueued(){}
  updateModelCode(){} updateContext(){} updateJoyState(){} updateQueue(){}
  updateCodexApproval(info){ if(info) this.approvals.push(info); }
  registerRpc(m,h){ this.rpcs[m]=h; }
  start(){} pausePull(){} stop(){} reassertAlive(){}
}
const deps={relayClient:null,broadcast:()=>{},addChatMessage:()=>{},onRelayAttached:()=>{}};
const wait=(c,ms,l)=>new Promise((r,j)=>{const t=Date.now();const iv=setInterval(()=>{if(c()){clearInterval(iv);r();}else if(Date.now()-t>ms){clearInterval(iv);j(new Error(l));}},200);});
const s=new CodexSession({id:'ap',tmuxWindow:'x:a',cwd:'/tmp/claude-1000/cxapwork',permissionMode:'default',status:'starting',startedAt:Date.now()},deps);
const r=new MockRelay(); s.attachRelay(r); s.beginWatching();
await wait(()=>s.status==='active',20000,'start');
s.enqueue('Run the shell command: touch /tmp/claude-1000/cxapwork/approved.txt (you must actually run it via the shell tool).', {mirrorToRelay:true});
try {
  await wait(()=>r.approvals.length>0, 60000, 'approval');
  console.log('APPROVAL surfaced:', JSON.stringify(r.approvals[0]));
  // Answer allow via the registered RPC (as the app would)
  const res = await r.rpcs['joy-codex-approve']({ id:'ap', requestId: r.approvals[0].requestId, decision:'allow' });
  console.log('answer RPC result:', JSON.stringify(res));
  console.log('\nAPPROVAL-LOOP PASS');
  s.end('killed'); process.exit(0);
} catch(e) {
  console.log('no approval fired (codex auto-ran under on-request):', e.message);
  s.end('killed'); process.exit(2);
}
