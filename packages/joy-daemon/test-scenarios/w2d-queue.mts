import assert from 'node:assert/strict';
import {root,codex,opencode,until,sleep} from './wave2d-astra-helpers.mts';
const {JsonRpcResponseError}=await import(root+'/codex/appServerClient.ts');
const {loadCodexInbound}=await import(root+'/codex/codexInboundStore.ts');
// Positive: cancelled start is interrupted after a successful delayed response.
{
 let finish!:()=>void,interrupts=0;const s=codex({id:'c0dec201'});
 s.__setup({turnStart:async()=>{await new Promise<void>(r=>finish=r);return {turnId:'late'}},turnInterrupt:async()=>{interrupts++}});
 const q=s.enqueue('cancel');s.cancelQueued(q.id);await s.abort();finish();await until(()=>interrupts===1);
 assert.equal(s.queueItemState(q.id),'cancelled');console.log('Codex delayed successful start: tombstone caused interrupt');
}
// Ambiguous start response can lose the only code path that consumes tombstone.
{
 let reject!:(e:Error)=>void,interrupts=0;const s=codex({id:'c0dec202'});
 s.__setup({turnStart:()=>new Promise((_r,j)=>reject=j),turnInterrupt:async()=>{interrupts++}});
 const q=s.enqueue('cancel lost response');s.cancelQueued(q.id);await s.abort();reject(new Error('request timed out'));await sleep(10);
 s.__event({method:'turn/started',params:{threadId:'thread',turn:{id:'late'}}});
 s.__event({method:'item/completed',params:{threadId:'thread',turnId:'late',item:{id:'user',type:'userMessage',clientId:q.id,text:'cancel lost response'}}});
 await sleep(20);assert.equal(interrupts,0);assert.equal(s.queueItemState(q.id),'cancelled');
 console.log('Codex timed-out start then late turn notification: cancelled turn runs without interrupt');
}
// A permanently invalid prompt has no natural turn/completed to trigger retries.
{
 let requests=0;const s=codex({id:'c0dec203'});
 s.__setup({turnStart:async()=>{requests++;throw new JsonRpcResponseError(-32602,'invalid argument')}});
 const q=s.enqueue('permanent rejection');await sleep(100);assert.equal(requests,1);assert.equal(s.queueItemState(q.id),'pending');
 s.resumeQueue();await sleep(10);s.resumeQueue();await sleep(10);
 assert.equal(requests,3);assert.equal(s.queueItemState(q.id),'failed');
 console.log('Codex rejection budget requires external pumps: one request stays pending; manually pumping reaches failed');
}
// Rejection attempts are counted even when busy, rather than consecutive non-busy.
{
 let requests=0;const s=codex({id:'c0dec204'});
 s.__setup({turnStart:async()=>{requests++;throw new JsonRpcResponseError(-1,requests<3?'turn already active':'temporary refusal')}});
 const q=s.enqueue('busy twice');await sleep(10);s.resumeQueue();await sleep(10);s.resumeQueue();await sleep(10);
 assert.equal(s.queueItemState(q.id),'failed');console.log('Codex two busy + first non-busy rejection exhausts claimed three-non-busy budget');
}
// Positive: cancelling B while A's reply is pending removes B from the snapshot.
{
 const s=opencode({id:'0c0dec21'}),a=s.enqueue('A'),b=s.enqueue('B'),posts:string[]=[];let release!:()=>void;
 s.__setup({prompt:async(_s:string,text:string,o:any)=>{posts.push(text);if(text==='A')await new Promise<void>(r=>release=r);return {messageID:o.id}}});
 const drain=s.__drain();s.cancelQueued(b.id);release();await drain;assert.deepEqual(posts,['A']);assert.equal(s.queueItemState(b.id),'cancelled');
 console.log('OpenCode snapshot cancellation now respected');
}
// The guard drops wakeups for items arriving after the snapshot was taken.
{
 const s=opencode({id:'0c0dec22'}),posts:string[]=[];let release!:()=>void;
 s.__setup({prompt:async(_s:string,text:string,o:any)=>{posts.push(text);await new Promise<void>(r=>release=r);return {messageID:o.id}}});
 s.enqueue('A');const b=s.enqueue('B');release();await sleep(100);
 assert.equal(posts.length,1);assert.equal(s.queueItemState(b.id),'pending');assert.ok(loadCodexInbound(s.id).some((x:any)=>x.clientId===b.id));
 console.log('OpenCode newly enqueued B stranded after A drain finishes: no second request');
}
// SSE is proof of admission but must not overwrite a prior cancelled outcome.
{
 const s=opencode({id:'0c0dec23'});s.__setup({prompt:async()=>new Promise(()=>{})});
 const q=s.enqueue('admitted');s.__event({type:'session.next.prompt.admitted',data:{sessionID:'oc-session',messageID:q.id}});
 assert.equal(s.queueItemState(q.id),'delivered');console.log('OpenCode SSE-only admission now recorded delivered');
 const other=opencode({id:'0c0dec24'});other.__setup({prompt:async()=>new Promise(()=>{})});
 const c=other.enqueue('cancelled then SSE');other.cancelQueued(c.id);
 other.__event({type:'session.next.prompt.admitted',data:{sessionID:'oc-session',messageID:c.id}});
 assert.equal(other.queueItemState(c.id),'delivered');console.log('OpenCode late SSE overwrites cancelled outcome with delivered');
}
console.log('PASS: actual adapter queues with controlled client responses and event ordering.');process.exit(0);
