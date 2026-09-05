import assert from 'node:assert/strict';
import {root,codex,opencode,relay,calls,until,sleep} from './wave2b-astra-helpers.mts';
const {loadCodexInbound}=await import(root+'/codex/codexInboundStore.ts');
// Handled commands and exact tmux bracket-token parsing.
for(const s of [codex(),opencode()]){
 const title=s.enqueue('/title hello');assert.equal(title.handled,'command');
 const prompt=s.enqueue('/joy-prompt');assert.equal(prompt.handled,'command');
 console.log(s.agentFlavor,'title and joy-prompt marked handled');
}
const keys=codex({id:'c0dec003'});
const before=calls.length;
assert.deepEqual(await keys.sendRawKeys('hello<Enter><C-c><Up>'),{ok:true,segments:2});
assert.deepEqual(calls.slice(before),[['literal','test','hello'],['keys','test','Enter','C-c','Up']]);
const invalid=await keys.sendRawKeys('<DefinitelyNotAKey>');assert.equal(invalid.ok,false);assert.equal(calls.length,before+2);
console.log('Codex app key scripts parse into literal and key segments; invalid input has no side effect');
// A queued Codex item behind another turn is removed before that turn finishes.
const queued=codex({id:'c0dec004'}),sent:string[]=[];
queued.__setup({turnStart:async(_t:string,text:string)=>{sent.push(text);return {turnId:'new-turn'}}});queued.__busyTurn('tui-turn');
const q=queued.enqueue('cancel while queued');assert.equal(queued.queueItemState(q.id),'pending');
assert.equal(queued.cancelQueued(q.id),true);queued.__event({method:'turn/completed',params:{threadId:'thread',turn:{id:'tui-turn',status:'completed'}}});
await sleep(5);assert.equal(sent.length,0);assert.equal(queued.queueItemState(q.id),'cancelled');
assert.equal(loadCodexInbound(queued.id).length,0);console.log('Codex queued cancellation survives completion pump');
// Cancellation while turn/start itself is in flight: no turn id yet to abort.
let finish!:()=>void,started=false,interrupts=0;
const pending=codex({id:'c0dec005'});
pending.__setup({turnStart:async()=>{started=true;await new Promise<void>(r=>finish=r);return {turnId:'late-turn'}},turnInterrupt:async()=>{interrupts++}});
const p=pending.enqueue('cancel during start');assert.ok(started);assert.equal(pending.cancelQueued(p.id),true);await pending.abort();
finish();await sleep(5);pending.__event({method:'turn/started',params:{threadId:'thread',turn:{id:'late-turn'}}});await sleep(5);
assert.equal(interrupts,0);assert.equal(pending.queueItemState(p.id),'cancelled');
console.log('Codex cancelled in-flight start still enters late-turn; interrupt count',interrupts);
// OpenCode cancellation only removes the array, not an existing drain snapshot.
const os=opencode({id:'0c0dec02'}),a=os.enqueue('A'),b=os.enqueue('B'),posts:string[]=[];
let release!:()=>void;
os.__setup({prompt:async(_sid:string,text:string,opts:any)=>{posts.push(text);if(text==='A')await new Promise<void>(r=>release=r);return {messageID:opts.id}}});
const drain=os.__drain();await until(()=>posts.length===1);assert.equal(os.cancelQueued(b.id),true);release();await drain;
assert.deepEqual(posts,['A','B']);assert.equal(os.queueItemState(b.id),'delivered');
console.log('OpenCode cancelled B still posted by old drain snapshot and outcome overwritten to delivered');
// Definitive HTTP rejection now leaves no retryable entry.
const rejected=opencode({id:'0c0dec03'});rejected.__setup({prompt:async()=>{throw new Error('opencode POST /prompt → 400: invalid')}});
const r=rejected.enqueue('reject');await until(()=>rejected.queueItemState(r.id)==='failed');
assert.equal(loadCodexInbound(rejected.id).length,0);console.log('OpenCode explicit rejection recorded failed and removed');
// SSE admission without a successful HTTP body loses the new per-item outcome.
const admitted=opencode({id:'0c0dec04'});admitted.__setup({prompt:async()=>new Promise(()=>{})});
const adm=admitted.enqueue('admitted');admitted.__event({type:'session.next.prompt.admitted',data:{sessionID:'oc-session',messageID:adm.id}});
assert.equal(admitted.queueItemState(adm.id),'unknown');console.log('OpenCode SSE-only admission drops queue item without delivered outcome');
console.log('PASS: copied actual adapters; test hooks only inject client/events and expose existing drain.');
process.exit(0);
