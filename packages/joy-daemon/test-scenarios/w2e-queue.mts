import assert from 'node:assert/strict';
import {root,codex,opencode,sleep,until} from './wave2e-queue-astra-helpers.mts';
const {JsonRpcResponseError}=await import(root+'/codex/appServerClient.ts');
const timer=globalThis.setTimeout;
globalThis.setTimeout=((f:any,ms:number,...args:any[])=>timer(f,ms===2000||ms===4000?15:ms,...args)) as any;
// Codex retries definitive non-busy failures without outside intake.
{
 let starts=0;const s=codex({id:'c0dec301'});
 s.__setup({turnStart:async()=>{starts++;throw new JsonRpcResponseError(-32602,'invalid input')}});
 const q=s.enqueue('reject');await until(()=>s.queueItemState(q.id)==='failed');assert.equal(starts,3);
 console.log('Codex non-busy refusal self-retries three times then fails');
}
{
 let starts=0;const s=codex({id:'c0dec302'});
 s.__setup({turnStart:async()=>{starts++;throw new JsonRpcResponseError(-1,starts<=2?'turn already active':'bad request')}});
 const q=s.enqueue('busy twice');await sleep(5);s.resumeQueue();await sleep(5);s.resumeQueue();
 await until(()=>s.queueItemState(q.id)==='failed');assert.equal(starts,5);console.log('Codex busy refusals do not consume non-busy budget');
}
// After timeout and cancel the item is in neither source used by turn/started.
{
 const s=codex({id:'c0dec303'});let reject!:(e:any)=>void;const interrupts:string[]=[];
 s.__setup({turnStart:()=>new Promise((_r,j)=>reject=j),turnInterrupt:async(_th:string,t:string)=>{interrupts.push(t)}});
 const q=s.enqueue('cancel');s.cancelQueued(q.id);await s.abort();reject(new Error('timeout'));await sleep(5);
 s.__event({method:'turn/started',params:{threadId:'thread',turn:{id:'late-own'}}});await sleep(5);
 assert.equal(interrupts.length,0);console.log('Codex turn/started after timeout alone misses removed tombstoned item');
 s.__event({method:'item/completed',params:{threadId:'thread',turnId:'late-own',item:{type:'userMessage',id:'u',clientId:q.id,text:'cancel'}}});
 await until(()=>interrupts.length===1);assert.equal(interrupts[0],'late-own');console.log('later correlated echo does interrupt that cancelled turn');
}
// A TUI turn that wins the race is not proof that our pending item was admitted.
{
 const s=codex({id:'c0dec304'});let reject!:(e:any)=>void;const interrupts:string[]=[];
 s.__setup({turnStart:()=>new Promise((_r,j)=>reject=j),turnInterrupt:async(_th:string,t:string)=>{interrupts.push(t)}});
 const q=s.enqueue('not admitted');s.cancelQueued(q.id);
 s.__event({method:'turn/started',params:{threadId:'thread',turn:{id:'unrelated-tui'}}});
 reject(new JsonRpcResponseError(-1,'turn already active'));await sleep(10);
 assert.deepEqual(interrupts,['unrelated-tui']);console.log('Codex tombstone interrupted unrelated TUI turn before own start was rejected busy');
}
// An item enqueued while a drain is in flight now gets a subsequent pass.
{
 const s=opencode({id:'0c0dec41'});let release!:(v:any)=>void;const posts:any[]=[];
 s.__setup({prompt:async(_s:string,text:string,o:any)=>{posts.push({text,id:o.id});if(posts.length===1)return await new Promise(r=>release=r);return {messageID:o.id}}});
 s.enqueue('A');const b=s.enqueue('B');release({messageID:posts[0].id});await until(()=>s.queueItemState(b.id)==='delivered');assert.equal(posts.length,2);
 console.log('OpenCode remembered wakeup delivers newly enqueued B exactly once');
}
for(const source of ['SSE','HTTP error','HTTP success']){
 const s=opencode({id:'0c0dec4'+({SSE:'2','HTTP error':'3','HTTP success':'4'}[source])});let resolve!:(v:any)=>void,reject!:(e:any)=>void;
 s.__setup({prompt:()=>new Promise((r,j)=>{resolve=r;reject=j})});const q=s.enqueue('cancel');s.cancelQueued(q.id);
 if(source==='SSE')s.__event({type:'session.next.prompt.admitted',data:{sessionID:'oc-session',messageID:q.id}});
 if(source==='HTTP error')reject(new Error('opencode POST /prompt → 400: invalid'));
 if(source==='HTTP success')resolve({messageID:q.id});
 await sleep(10);assert.equal(s.queueItemState(q.id),'cancelled');console.log('OpenCode cancel survives late '+source);
}
globalThis.setTimeout=timer;
console.log('PASS: actual adapter queue paths and controlled requests/events; retry timer durations shortened.');process.exit(0);
