import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync} from 'node:fs';
import crypto from 'node:crypto';
import {syncBuiltinESMExports} from 'node:module';
const root=process.env.JOY_REVIEW_SRC ?? '/tmp/joy-test-tmux/review3/wave2-astra-checkout/packages/joy-daemon/src';
process.env.JOY_HOME_DIR=mkdtempSync('/tmp/joy-test-tmux/review3/wave2-astra-spawn-');
const {joyStateDir}=await import(root+'/paths.ts');
const {startNucleusLane}=await import(root+'/relay/nucleusLane.ts');
const scenario=process.argv[2]??'adopt_crash';
const uuid=crypto.randomUUID;
if(scenario==='collision'){crypto.randomUUID=(()=> 'aaaaaaaa-0000-4000-8000-000000000000') as any;syncBuiltinESMExports()}
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function until(fn:()=>boolean){for(let i=0;i<500&&!fn();i++)await sleep(5);assert.ok(fn(),'condition reached')}
const sessions=new Map<string,any>(),records=new Map<string,any>();
function session(id:string,status='active'){return {id,status,agentFlavor:'claude',cwd:'/test/project',cardMetadata:()=>null,busy:()=>false,setV2Link(){}}}
const old=session('aaaaaaaa',scenario==='adopt_crash'?'ended':'active');sessions.set(old.id,old);
let creates=0,phase=1,offered=false,chosen='',bound='',blocked=false;
const registry:any={
 get:(id:string)=>sessions.get(id),list:()=>[...sessions.values()],listRecords:()=>[...records.values()],saveRecord(id:string,patch:any){records.set(id,{...records.get(id),...patch,id})},chatHistory:()=>[],
 async create(opts:any){
  creates++;
  const intents=JSON.parse(readFileSync(joyStateDir()+'/v2-spawns.json','utf8'));
  assert.equal(intents['spawn-command'],opts.id);chosen=opts.id;
  if(phase===1&&scenario==='adopt_crash'){
   // create's documented auto-revive return: runtime now live under an old id,
   // but create's promise has not resolved. A process crash here loses the lane
   // continuation; keep the resulting runtime and intent file for the next lane.
   old.status='active';blocked=true;
   console.log('before simulated crash',JSON.stringify({reserved:chosen,actual:old.id,forceNew:opts.forceNew??false}));
   return await new Promise(()=>{});
  }
  if(scenario==='collision'){
   assert.equal(opts.id,old.id);assert.equal(registry.get(opts.id),old);
   console.log('chosen spawn id collides with live runtime: still called create({id})');
  }
  const s=session(opts.id);sessions.set(s.id,s);return s;
 }
};
globalThis.fetch=(async(input:any,init:any={})=>{
 const path=new URL(String(input)).pathname.replace('/joy/v2','');
 if(path==='/daemon/leases')return Response.json({leaseId:'lease-'+phase,leaseToken:'token',epoch:String(phase)});
 if(path==='/sessions')return Response.json({sessions:[]});
 if(path.includes('/claims/')){
  await sleep(10);
  if(path.endsWith('/work')&&!offered){offered=true;return Response.json({offers:[{kind:'spawn_session',sessionId:'relay-session',commandId:'spawn-command',deliveryId:'delivery',ciphertext:JSON.stringify({t:'spawn',cwd:'/test/project'})}]})}
  return Response.json({offers:[]});
 }
 if(path.endsWith('/bind'))bound=JSON.parse(init.body).localSessionId;
 return Response.json({});
}) as any;
const opts={registry,relayUrl:'https://relay.test',token:'token',machineId:'machine'};
let lane=startNucleusLane(opts);
try{
 if(scenario==='adopt_crash'){
  await until(()=>blocked);assert.notEqual(chosen,old.id);
  await lane.stop();phase=2;offered=false;lane=startNucleusLane(opts);
  await until(()=>!!bound);
  assert.equal(creates,2);assert.equal(sessions.size,2);assert.equal(bound,chosen);
  console.log('replay after simulated crash',JSON.stringify({runtimeIds:[...sessions.keys()],bound,creates}));
 }else{await until(()=>!!bound);assert.equal(creates,1)}
 console.log('PASS: actual lane and on-disk intents; mocked relay and registry launch boundary.');
}finally{await lane.stop();crypto.randomUUID=uuid;syncBuiltinESMExports()}
process.exit(0);
