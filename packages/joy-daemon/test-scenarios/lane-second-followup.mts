import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync,rmSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
process.env.JOY_HOME_DIR=mkdtempSync('/tmp/joy-test-tmux/review3/wave1-astra-second-followup-');
const root='../src';
const {startNucleusLane}=await import(root+'/relay/nucleusLane.ts');
const {OutboundSpool}=await import(root+'/relay/outboundSpool.ts');
const {RelaySession,encodeTextEvent}=await import(root+'/relay/relay.ts');
const {joyStateDir}=await import(root+'/paths.ts');
const scenario=process.argv[2];
const realSetTimeout=globalThis.setTimeout;
const sleep=(ms:number)=>new Promise(r=>realSetTimeout(r,ms));
async function until(test:()=>boolean){for(let i=0;i<1200&&!test();i++)await sleep(5);assert.ok(test(),'condition reached');}
const fastSweep=['duplicates','replay_retry','sweep','claim_race','fence','sweep_health','handoff'].includes(scenario);
if(fastSweep)globalThis.setTimeout=((fn:any,ms:any,...args:any[])=>realSetTimeout(fn,ms===8000?30:ms===1000?20:ms,...args)) as any;
const row={sessionId:'session-one',localSessionId:'local-one',daemonId:'machine-one',state:'active',queuedTurns:1,executing:'running'};
const turnId='be9b8153-7009-43ba-a20b-4a73f2606d6b';
const out=(id:string,v2:string|null=row.sessionId)=>({kind:'output' as const,id,localId:row.localSessionId,v2SessionId:v2,turnId,wire:encodeTextEvent(id,{turn:'adapter-turn'}),runtimeEventId:'rec:'+id,at:Date.now()});
const terminal={kind:'terminal' as const,id:'terminal-one',v2SessionId:row.sessionId,localId:row.localSessionId,turnId,body:{type:'terminal',terminalState:'completed'},at:Date.now()};
const spoolPath=join(joyStateDir(),'v2-outbound.json');
mkdirSync(joyStateDir(),{recursive:true});
let initial:any[]=[];
if(scenario==='boot_order')initial=[out('old-first'),out('new-second',null),terminal];
if(scenario==='boot_live_order')initial=[out('old-first')];
if(scenario==='duplicates')initial=[out('first'),out('second')];
if(scenario==='replay_retry')initial=[terminal];
if(scenario==='fence')initial=[out('first')];
if(scenario==='cap'||scenario==='growth')initial=Array.from({length:2000},(_,i)=>out('old-'+i));
writeFileSync(spoolPath,JSON.stringify(initial));
const pending=()=>new OutboundSpool(spoolPath);
const adapter=new RelaySession({client:{creds:{machineId:row.daemonId}} as any,relaySessionId:row.localSessionId,metadata:{}});
let busy=false,offered=false,claimReady=false;
const session:any={id:row.localSessionId,status:'active',cardMetadata:()=>null,busy:()=>busy,queueState:()=>({pendingCount:0,paused:false}),queueItemState:()=> 'delivered',abort:async()=>{busy=false;},enqueue(){
 adapter.send(encodeTextEvent('answer',{turn:'adapter-turn'}),'answer');
 return {id:'q1',...(scenario==='claim_race'?{}:{handled:'command'})};
}};
const registry:any={get:(id:string)=>id===session.id?session:undefined,list:()=>[session],listRecords:()=>[{id:session.id,v2SessionId:row.sessionId}],saveRecord(){},chatHistory:()=>[]};
let openOutput:()=>void=()=>{};const outputGate=new Promise<void>(r=>openOutput=r);
let openStatus:()=>void=()=>{};const statusGate=new Promise<void>(r=>openStatus=r);
const originalNow=Date.now;let timeShift=0;Date.now=()=>originalNow()+timeShift;
let acquires=0,reads=0,statusReads=0,terminalState:string|null=null;
const calls:Array<{path:string,body:any,lease?:string}>=[],events:string[]=[],logs:string[]=[];
const response=(data:any={},status=200)=>new Response(JSON.stringify(data),{status});
globalThis.fetch=async(input:any,init:any={})=>{
 const path=new URL(String(input)).pathname.replace('/joy/v2',''),body=init.body?JSON.parse(init.body):{};
 if(path==='/daemon/leases'){acquires++;return response({leaseId:'lease-'+acquires,leaseToken:'token',epoch:String(acquires)});}
 if(path.includes('/claims/')){
  await sleep(10);
  if(['live_terminal','quota','claim_race','handoff'].includes(scenario)&&path.endsWith('/work')&&!offered&&(scenario!=='claim_race'||claimReady)){
   offered=true;return response({offers:[{kind:'prompt',sessionId:row.sessionId,turnId,commandId:'command',deliveryId:'delivery',ciphertext:JSON.stringify({v:1,t:'plain',text:'/title hi'})}]});
  }return response({offers:[]});
 }
 if(init.method==='PUT')return response({},scenario==='fence'&&acquires===1?401:200);
 if(path==='/sessions'){reads++;return response({sessions:[row]});}
 if(path===`/sessions/${row.sessionId}`){
  statusReads++;
  if(scenario==='boot_live_order'&&statusReads===1)await statusGate;
  if(scenario==='claim_race'&&statusReads===3){claimReady=true;await statusGate;}
  return response({execution:{state:scenario==='boot_order'||scenario==='replay_retry'?'orphaned':'running',turnId},queue:{queuedTurns:1}});
 }
 calls.push({path,body,lease:init.headers?.['x-joy-lease-id']});
 if(path.endsWith('/reconcile')){
  events.push('terminal:'+body.terminalState);
  if(scenario==='replay_retry'&&calls.filter(c=>c.path.endsWith('/reconcile')).length===1)return response({error:'temporary'},503);
  terminalState??=body.terminalState;return response({state:'terminal',terminalState});
 }
 if(path.endsWith('/facts')&&body.type==='terminal'){if(scenario==='handoff'){timeShift=61000;return response({error:'temporary'},503);}events.push('terminal:'+body.terminalState);terminalState??=body.terminalState;return response();}
 if(path.endsWith('/facts')&&body.type==='output'){
  events.push('request:'+body.runtimeEventId);
  if(['duplicates','live_terminal','cap','growth','disk_receipt','disk_opencode','sweep_health','late_sink'].includes(scenario))await outputGate;
  if(scenario==='quota')return response({error:'session_event_budget_exhausted'},429);
  if(scenario==='fence'&&init.headers?.['x-joy-lease-id']==='lease-1')return response({error:'lease_expired'},412);
  events.push('ack:'+body.runtimeEventId);return response({seq:'2'});
 }return response();
};
const lane=startNucleusLane({registry,relayUrl:'http://relay.invalid',token:'token',machineId:row.daemonId,log:s=>logs.push(s)});
try{
 if(scenario==='boot_order'){
  await until(()=>terminalState!==null);assert.equal(terminalState,'completed');
  assert.deepEqual(events,['request:rec:old-first','ack:rec:old-first','request:rec:new-second','ack:rec:new-second','terminal:completed']);
  console.log(JSON.stringify({scenario,result:'fixed',events}));
 }else if(scenario==='boot_live_order'){
  await until(()=>statusReads===1);
  adapter.send(encodeTextEvent('new-live',{turn:'adapter-turn'}),'new-live');
  await sleep(100);assert.equal(events.length,0);
  openStatus();await until(()=>events.includes('ack:rec:new-live'));
  assert.deepEqual(events,['request:rec:old-first','ack:rec:old-first','request:rec:new-live','ack:rec:new-live']);
  console.log(JSON.stringify({scenario,result:'fixed',events}));
 }else if(scenario==='duplicates'){
  await until(()=>reads>=6);openOutput();await until(()=>events.includes('ack:rec:second'));await sleep(100);assert.equal(events.filter(x=>x==='request:rec:second').length,1);
  console.log(JSON.stringify({scenario,result:'fixed',reads,firstPosts:events.filter(x=>x==='request:rec:first').length,secondPosts:events.filter(x=>x==='request:rec:second').length,spoolSize:pending().size}));
 }else if(scenario==='live_terminal'){
  await until(()=>calls.some(c=>c.path.endsWith('/start')));await sleep(100);
  assert.equal(pending().hasTerminalFor(turnId),true);
  console.log(JSON.stringify({scenario,result:'fixed',pendingKinds:pending().all().map(e=>e.kind),terminalState}));
 }else if(scenario==='replay_retry'){
  await until(()=>terminalState!==null);assert.equal(terminalState,'completed');assert.equal(acquires,1);
  assert.ok(calls.filter(c=>c.path.endsWith('/reconcile')).length>=2);
  console.log(JSON.stringify({scenario,result:'fixed',acquires,events,spoolSize:pending().size}));
 }else if(scenario==='sweep'){
  await until(()=>terminalState!==null);assert.equal(statusReads,3);
  assert.ok(calls.filter(c=>c.path.endsWith('/reconcile')).every(c=>c.path===`/daemon/turns/${turnId}/reconcile`));
  console.log(JSON.stringify({scenario,result:'fixed',statusReads,terminalState}));
 }else if(scenario==='claim_race'){
  busy=true;await until(()=>calls.some(c=>c.path.endsWith('/start')));openStatus();
  await until(()=>statusReads>=6);assert.equal(calls.filter(c=>c.path.endsWith('/reconcile')).length,0);
  console.log(JSON.stringify({scenario,result:'fixed',statusReads,workerStarted:true,releases:0}));
 }else if(scenario==='fence'){
  await until(()=>events.includes('ack:rec:first'));assert.ok(acquires>=2);
  assert.equal(pending().size,0);console.log(JSON.stringify({scenario,result:'fixed',acquires,outputLeases:calls.filter(c=>c.body.type==='output').map(c=>c.lease)}));
 }else if(scenario==='quota'){
  await until(()=>terminalState!==null);assert.equal(terminalState,'completed');assert.equal(pending().size,0);
  console.log(JSON.stringify({scenario,result:'fixed for queue liveness',events,spoolSize:0}));
 }else if(scenario==='handoff'){
  await until(()=>logs.some(s=>s.includes('retrying in the background')));await until(()=>reads>=6);
  assert.equal(calls.filter(c=>c.path.endsWith('/reconcile')).length,0);
  assert.ok(calls.filter(c=>c.body.type==='terminal').length>=2);
  assert.equal(pending().hasTerminalFor(turnId),true);
  console.log(JSON.stringify({scenario,result:'fixed',backgroundOwnsTerminal:true,reconcileAttempts:0,terminalAttempts:calls.filter(c=>c.body.type==='terminal').length}));
 }else if(scenario==='growth'){
  await until(()=>events.includes('request:rec:old-0'));
  const before=originalNow();for(let i=0;i<100;i++)adapter.send(encodeTextEvent('more '+i,{turn:'adapter-turn'}),'more-'+i);
  assert.equal(pending().size,2100);assert.equal(adapter.outboundPersistDegraded,true);
  assert.equal(events.filter(x=>x.startsWith('ack:')).length,0);
  console.log(JSON.stringify({scenario,result:'still unbounded',pending:2100,additionalAccepted:100,elapsedMs:originalNow()-before,degraded:true}));
 }else if(scenario==='cap'){
  await until(()=>events.includes('request:rec:old-0'));
  adapter.send(encodeTextEvent('newest',{turn:'adapter-turn'}),'newest');
  const disk=pending();assert.equal(disk.size,2001);assert.ok(disk.all().some(e=>e.id==='old-0'));assert.equal(adapter.outboundPersistDegraded,true);
  openOutput();await until(()=>events.includes('ack:rec:newest'));
  const posts=calls.filter(c=>c.body.type==='output');assert.equal(posts.length,2001);
  console.log(JSON.stringify({scenario,result:'fixed',onDisk:disk.size,evictedOldest:false,degraded:true,retainedScheduledOutputs:posts.length}));
 }else if(scenario==='disk_opencode'){
  await until(()=>statusReads>=1);await sleep(20);
  mkdirSync(spoolPath+'.tmp');
  const original=join(root,'opencode/opencodeSession.ts');
  // Expose only a setup/finish seam on a temporary copy; the production method is unchanged.
  const text=readFileSync(original,'utf8').replace('  constructor(init: OpencodeInit, deps: SessionDeps) {', `  __reviewFinish(norm: any) { this.#norm=norm; this.#ocSessionId='oc-session'; this.#endTurn('adapter-turn','completed'); }\n  constructor(init: OpencodeInit, deps: SessionDeps) {`).replace(/(from\s+[\"'])(\.{1,2}\/[^\"']+)([\"'])/g,(_,a,b,c)=>a+resolve(dirname(original),b)+c);
  const copy=join(process.env.JOY_HOME_DIR!,'opencode-review.ts');writeFileSync(copy,text);
  const {OpencodeSession}=await import(copy);
  const {loadWindowRecord}=await import(root+'/domain/windowRecord.ts');
  const oc=new OpencodeSession({id:row.localSessionId,cwd:process.env.JOY_HOME_DIR!,status:'active',startedAt:Date.now(),opencodeSessionId:'oc-session'},{broadcast(){}});
  oc.attachRelay(adapter);
  oc.__reviewFinish({lastMessageId:'msg_last',currentTurn:'adapter-turn',closeOpenTools:()=>[],setTurn(){}});
  assert.equal(adapter.outboundPersistDegraded,true);
  assert.equal(loadWindowRecord(row.localSessionId)?.opencodeDeliveredThrough,undefined);
  assert.equal(pending().size,0);
  console.log(JSON.stringify({scenario,result:'fixed',degraded:true,deliveredThrough:null,spooled:0}));
 }else if(scenario==='disk_receipt'||scenario==='sweep_health'||scenario==='late_sink'){
  await until(()=>statusReads>=1);await sleep(20);
  // Block only spool writes; the checkpoint directory remains writable.
  mkdirSync(spoolPath+'.tmp');
  const {CodexSession}=await import(root+'/codex/codexSession.ts');
  const {loadCheckpoint}=await import(root+'/codex/codexCheckpointStore.ts');
  const codex=new CodexSession({id:row.localSessionId,cwd:process.env.JOY_HOME_DIR!,status:'active',tmuxWindow:'fake',startedAt:Date.now()},{} as any);
  if(scenario!=='late_sink')codex.attachRelay(adapter);
  adapter.send(encodeTextEvent('answer',{turn:'adapter-turn'}),'answer');
  assert.equal(adapter.outboundPersistDegraded,true);
  adapter.stampReceiptOnLastQueued({uuid:'receipt',turn:'adapter-turn'});
  assert.equal(loadCheckpoint(row.localSessionId).deliveredThroughTurnId,null);
  if(scenario==='sweep_health'){
   await until(()=>!adapter.outboundPersistDegraded);
   assert.equal(loadCheckpoint(row.localSessionId).deliveredThroughTurnId,'adapter-turn');
   assert.equal(calls.filter(c=>c.body.type==='output').length,1);
   assert.equal(events.filter(x=>x.startsWith('ack:')).length,0);
  }else if(scenario==='late_sink'){
   codex.attachRelay(adapter);
   assert.equal(adapter.outboundPersistDegraded,true);
   assert.equal(loadCheckpoint(row.localSessionId).deliveredThroughTurnId,'adapter-turn');
  }else{
   // A genuine successful save must release the held receipt exactly once.
   rmSync(spoolPath+'.tmp',{recursive:true});
   adapter.send(encodeTextEvent('second',{turn:'adapter-turn'}),'second');
   assert.equal(adapter.outboundPersistDegraded,false);
   assert.equal(loadCheckpoint(row.localSessionId).deliveredThroughTurnId,'adapter-turn');
   assert.equal(pending().size,2);
  }
  assert.equal(pending().size,scenario==='disk_receipt'?2:0);
  console.log(JSON.stringify({scenario,result:scenario==='disk_receipt'?'held until actual save':'defect reproduced',degraded:adapter.outboundPersistDegraded,deliveredThrough:loadCheckpoint(row.localSessionId).deliveredThroughTurnId,spooled:pending().size,outputAcks:events.filter(x=>x.startsWith('ack:')).length}));
 }else throw new Error('unknown scenario');
}finally{await lane.stop();}
process.exit(0);
