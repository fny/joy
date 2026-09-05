import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
process.env.JOY_HOME_DIR=mkdtempSync('/tmp/joy-test-tmux/review3/wave1-astra-spool-');
const {startNucleusLane}=await import('../src/relay/nucleusLane.ts');
const {OutboundSpool}=await import('../src/relay/outboundSpool.ts');
const {RelaySession,encodeTextEvent}=await import('../src/relay/relay.ts');
const {joyStateDir}=await import('../src/paths.ts');
const scenario=process.argv[2];
const spoolPath=join(joyStateDir(),'v2-outbound.json');
const realSetTimeout=globalThis.setTimeout;
const sleep=(ms:number)=>new Promise(r=>realSetTimeout(r,ms));
async function until(test:()=>boolean){for(let i=0;i<400&&!test();i++)await sleep(5);assert.ok(test(),'condition reached');}
const row={sessionId:'session-one',localSessionId:'local-one',daemonId:'machine-one',state:'active',queuedTurns:1,executing:'running'};
const turnId='be9b8153-7009-43ba-a20b-4a73f2606d6b';
const out=(id:string,v2:string|null=row.sessionId)=>({kind:'output' as const,id,localId:row.localSessionId,v2SessionId:v2,turnId,wire:encodeTextEvent(id,{turn:'adapter-turn'}),runtimeEventId:'rec:'+id,at:Date.now()});
const terminal={kind:'terminal' as const,id:'terminal-one',v2SessionId:row.sessionId,turnId,body:{type:'terminal',terminalState:'completed'},at:Date.now()};
const seed=new OutboundSpool(spoolPath);
if(scenario==='ordering'){seed.add(out('answer'));seed.add(terminal);}
if(scenario==='record_order'){seed.add(out('old-first'));seed.add(out('new-second',null));}
if(scenario==='replay_retry'||scenario==='orphan'){seed.add(terminal);}
if(scenario==='fence'||scenario==='transient'){seed.add(out('answer'));}
if(scenario==='disk'){
 const blocker=join(process.env.JOY_HOME_DIR!,'not-a-directory');writeFileSync(blocker,'x');
 const s=new OutboundSpool(join(blocker,'spool.json'));s.add(out('answer'));
 assert.equal(s.size,1);assert.equal(new OutboundSpool(join(blocker,'spool.json')).size,0);
 console.log(JSON.stringify({scenario,returnedNormally:true,inMemory:1,afterReopen:0}));process.exit(0);
}
if(scenario==='sweep'||scenario==='replay_retry'||scenario==='quota'||scenario==='claimed_sweep'){
 globalThis.setTimeout=((fn:any,ms:any,...args:any[])=>realSetTimeout(fn,ms===8000?20:(scenario==='quota'&&[1000,2000,4000,16000,30000].includes(ms)?10:ms),...args)) as any;
}
const session:any={id:row.localSessionId,status:'active',cardMetadata:()=>null};
let stage=0;const enqueued:string[]=[];let records:any[]=[{id:row.localSessionId,...(scenario==='bind'?{launchCwd:'/tmp'}:{v2SessionId:row.sessionId})}];
const adapter=new RelaySession({client:{creds:{machineId:row.daemonId}} as any,relaySessionId:row.localSessionId,metadata:{}});
session.enqueue=(text:string)=>{enqueued.push(text);adapter.send(encodeTextEvent('answer',{turn:'adapter-turn'}),'answer');return scenario==='claimed_sweep'?{id:'q1'}:{id:'q1',handled:'command'};};
session.busy=()=>true;session.queueState=()=>({pendingCount:0,paused:false});session.queueItemState=()=>'delivered';
let offered=false;
const registry:any={get:(id:string)=>id===session.id?session:undefined,list:()=>[session],create:async()=>session,listRecords:()=>records,saveRecord(id:string,patch:any){records=records.map(r=>r.id===id?{...r,...patch}:r);},chatHistory:()=>[]};
let releaseOutput:()=>void=()=>{};
const outputGate=new Promise<void>(r=>releaseOutput=r);
let terminalState:string|null=null,settled=false,reads=0,acquires=0;
const calls:Array<{path:string,body:any}>=[],events:string[]=[],logs:string[]=[];
const response=(data:any={},status=200)=>new Response(JSON.stringify(data),{status});
globalThis.fetch=async(input:any,init:any={})=>{
 const path=new URL(String(input)).pathname.replace('/joy/v2','');const body=init.body?JSON.parse(init.body):{};
 if(path==='/daemon/leases'){acquires++;return response({leaseId:'lease-one',leaseToken:'token',epoch:'2'});}
 if(path.includes('/claims/')){await sleep(30);
 if(path.endsWith('/work')&&scenario==='edit'&&stage<2){return response({offers:[{kind:'prompt',sessionId:row.sessionId,turnId,commandId:'cmd',deliveryId:stage===0?'old':'new',ciphertext:JSON.stringify({v:1,t:'plain',text:stage===0?'A':'B'})}]});}
 if(path.endsWith('/work')&&scenario==='bind'&&stage<2){return response({offers:[{kind:'spawn_session',sessionId:row.sessionId,commandId:'spawn-cmd',deliveryId:'spawn-delivery',ciphertext:JSON.stringify({v:1,t:'spawn',cwd:'/tmp'})}]});}
if((scenario==='quota'||scenario==='claimed_sweep')&&path.endsWith('/work')&&!offered){offered=true;return response({offers:[{kind:'prompt',sessionId:row.sessionId,turnId,commandId:'cmd',deliveryId:'delivery',ciphertext:JSON.stringify({v:1,t:'plain',text:'/title hi'})}]});}return response({offers:[]});}
 if(path==='/sessions'){reads++;return response({sessions:scenario==='bind'?[]:[row]});}
 if(path===`/sessions/${row.sessionId}`)return response({execution:{state:scenario==='orphan'&&!terminalState?'orphaned':'running',turnId},queue:{queuedTurns:1}});
 if(init.method==='PUT')return response();
 calls.push({path,body});
 if(scenario==='edit'&&path.endsWith('/deliveries/old/received')){stage=1;return response({error:'delivery_superseded'},409);}
 if(scenario==='edit'&&path.endsWith('/deliveries/new/received'))stage=2;
 if(scenario==='bind'&&path.endsWith('/bind')){stage++;if(stage===1)throw new TypeError('bind committed but reply lost');}

 if(path.endsWith('/reconcile')){
  events.push('reconcile:'+body.terminalState);
  if(scenario==='replay_retry')return response({error:'temporary'},503);
  if(scenario==='sweep'||scenario==='claimed_sweep')return response({error:'turn_not_found'},404);
  terminalState??=body.terminalState;
  return response({state:'terminal',terminalState,replay:terminalState!==body.terminalState});
 }
 if(path.endsWith('/facts')&&body.type==='output'){
  events.push('output-request');
  if(scenario==='ordering')await outputGate;
  if(scenario==='quota')return response({error:'session_event_budget_exhausted'},429);
  if(scenario==='transient'&&events.filter(x=>x==='output-request').length===1)return response({error:'unavailable'},503);
  if(scenario==='fence')return response({error:'lease_expired'},412);
  events.push('output-ack');return response({seq:'10'});
 }
 return response();
};
const lane=startNucleusLane({registry,relayUrl:'http://relay.invalid',token:'x',machineId:row.daemonId,accountContentPublicKey:scenario==='bind'?new Uint8Array(32).fill(7):null,log:s=>logs.push(s)});
try{
 if(scenario==='ordering'){
  await until(()=>events.some(x=>x.startsWith('reconcile:'))&&events.includes('output-request'));
  assert.ok(!events.includes('output-ack'));
  releaseOutput();await until(()=>events.includes('output-ack'));
  console.log(JSON.stringify({scenario,events,terminalBeforeOutputAck:true}));
 }else if(scenario==='record_order'){
  await until(()=>calls.filter(c=>c.path.endsWith('/facts')&&c.body.type==='output').length>=2);
  const ids=calls.filter(c=>c.path.endsWith('/facts')&&c.body.type==='output').map(c=>c.body.runtimeEventId);
  assert.equal(ids[0],'rec:new-second');assert.equal(ids[1],'rec:old-first');
  console.log(JSON.stringify({scenario,persistedOrder:['rec:old-first','rec:new-second'],postedOrder:ids}));
 }else if(scenario==='quota'){
  await until(()=>events.filter(x=>x==='output-request').length>=3);
  for(let i=0;i<100;i++)adapter.send(encodeTextEvent('later '+i,{turn:'adapter-turn'}),'later-'+i);
  await sleep(100);
  const pending=new OutboundSpool(spoolPath);
  assert.equal(pending.size,101);assert.equal(pending.hasTerminalFor(turnId),false);
  assert.equal(calls.filter(c=>c.body.type==='terminal').length,0);
  console.log(JSON.stringify({scenario,outputAttempts:events.filter(x=>x==='output-request').length,spoolSize:pending.size,terminalSpooled:false,terminalPosts:0,leaseAcquires:acquires}));
 }else if(scenario==='orphan'){
  await until(()=>calls.filter(c=>c.path.endsWith('/reconcile')).length===2);
  assert.equal(terminalState,'interrupted');assert.equal(new OutboundSpool(spoolPath).size,0);
  console.log(JSON.stringify({scenario,events,finalTerminal:terminalState,spoolSize:0}));
 }else if(scenario==='replay_retry'){
  await until(()=>reads>=6); // five healthy sweep ticks, no lease reacquire
  assert.equal(acquires,1);assert.equal(calls.filter(c=>c.path.includes(turnId)&&c.path.endsWith('/reconcile')).length,1);
  assert.equal(new OutboundSpool(spoolPath).size,1);
  console.log(JSON.stringify({scenario,acquires,sessionListReads:reads,correctTurnReconcileAttempts:1,spoolSize:1,otherReconcilePaths:calls.filter(c=>c.path.endsWith('/reconcile')&&!c.path.includes(turnId)).map(c=>c.path)}));
 }else if(scenario==='sweep'||scenario==='claimed_sweep'){
  await until(()=>calls.filter(c=>c.path.endsWith('/reconcile')).length>=2);
  assert.ok(calls.filter(c=>c.path.endsWith('/reconcile')).every(c=>c.path==='/daemon/turns/running/reconcile'));
  if(scenario==='claimed_sweep')assert.ok(calls.some(c=>c.path===`/daemon/turns/${turnId}/start`));
  console.log(JSON.stringify({scenario,localWorkerStarted:calls.some(c=>c.path===`/daemon/turns/${turnId}/start`),releasePaths:calls.filter(c=>c.path.endsWith('/reconcile')).map(c=>c.path),actualTurnId:turnId}));
 }else if(scenario==='edit'){
  await until(()=>calls.some(c=>c.body.type==='terminal'));
  assert.deepEqual(enqueued,['B']);assert.ok(calls.filter(c=>c.body.type==='terminal').every(c=>c.body.terminalState==='completed'));
  console.log(JSON.stringify({scenario,enqueued,terminals:calls.filter(c=>c.body.type==='terminal').map(c=>c.body.terminalState)}));
 }else if(scenario==='bind'){
  // spawn backs off five seconds after the lost bind reply
  await sleep(5200);await until(()=>stage===2);
  const binds=calls.filter(c=>c.path.endsWith('/bind'));
  assert.equal(binds.length,2);assert.equal(binds[0].body.sessionKeyEnvelope,binds[1].body.sessionKeyEnvelope);
  assert.ok(records[0].v2SessionKey);assert.equal(records[0].v2AnnounceEnvelope,binds[0].body.sessionKeyEnvelope);
  console.log(JSON.stringify({scenario,bindAttempts:2,sameEnvelope:true,keyPersisted:true}));
 }else if(scenario==='transient'){
  await until(()=>events.includes('output-ack'));
  const posts=calls.filter(c=>c.body.type==='output');
  assert.equal(posts.length,2);assert.equal(posts[0].body.runtimeEventId,posts[1].body.runtimeEventId);assert.equal(new OutboundSpool(spoolPath).size,0);
  console.log(JSON.stringify({scenario,outputAttempts:2,sameRuntimeEventId:true,spoolSize:0}));
 }else if(scenario==='fence'){
  await until(()=>logs.some(s=>s.includes('dropped')));
  assert.equal(new OutboundSpool(spoolPath).size,0);
  console.log(JSON.stringify({scenario,outputAttempts:events.filter(x=>x==='output-request').length,outputAcks:events.filter(x=>x==='output-ack').length,spoolSize:0}));
 }else throw new Error('unknown scenario');
}finally{await lane.stop();}
process.exit(0);
