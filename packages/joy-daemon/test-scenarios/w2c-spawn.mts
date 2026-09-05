import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import {syncBuiltinESMExports} from 'node:module';
const root='/tmp/joy-test-tmux/review3/wave2c-astra-checkout/packages/joy-daemon/src';
process.env.JOY_HOME_DIR=fs.mkdtempSync('/tmp/joy-test-tmux/review3/wave2c-astra-spawn-');
const {joyStateDir}=await import(root+'/paths.ts');
const scenario=process.argv[2]??'collision_replay';
const intentsPath=joyStateDir()+'/v2-spawns.json';fs.mkdirSync(joyStateDir(),{recursive:true});
const write=fs.writeFileSync,uuid=crypto.randomUUID;
let count=0,writeFault=false;
if(scenario==='collision_replay'){
 crypto.randomUUID=(()=> (++count<=2?'aaaaaaaa':'bbbbbbbb')+'-0000-4000-8000-000000000000') as any;
}else{
 write(intentsPath,JSON.stringify({'older-command':'cccccccc'}));
 fs.writeFileSync=((path:any,data:any,...args:any[])=>{
  if(String(path)===intentsPath+'.tmp'){
   write(path,'{"partial":');writeFault=true;throw new Error('simulated write failure after partial tmp write');
  }
  return (write as any)(path,data,...args);
 }) as any;
}
syncBuiltinESMExports();
const {startNucleusLane}=await import(root+'/relay/nucleusLane.ts');
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function until(fn:()=>boolean){for(let i=0;i<500&&!fn();i++)await sleep(5);assert.ok(fn(),'condition reached')}
const sessions=new Map<string,any>(),records=new Map<string,any>();
function session(id:string){return {id,status:'active',agentFlavor:'claude',cwd:'/test/project',cardMetadata:()=>null,busy:()=>false,setV2Link(){}}}
sessions.set('aaaaaaaa',session('aaaaaaaa'));
let creates=0,phase=1,offered=false,binding=false,bound='',chosen='',failed=false;
const registry:any={get:(id:string)=>sessions.get(id),list:()=>[...sessions.values()],listRecords:()=>[...records.values()],saveRecord(id:string,patch:any){records.set(id,{...records.get(id),...patch,id})},chatHistory:()=>[],
 async create(opts:any){
  creates++;chosen=opts.id;assert.equal(JSON.parse(fs.readFileSync(intentsPath,'utf8'))['spawn-command'],opts.id);
  assert.notEqual(opts.id,'aaaaaaaa');const s=session(opts.id);sessions.set(s.id,s);return s;
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
 if(path.endsWith('/spawn-failed'))failed=true;
 if(path.endsWith('/bind')){
  binding=true;
  if(phase===1&&scenario==='collision_replay')return await new Promise(()=>{});
  bound=JSON.parse(init.body).localSessionId;
 }
 return Response.json({});
}) as any;
const opts={registry,relayUrl:'https://relay.test',token:'token',machineId:'machine'};
let lane=startNucleusLane(opts);
try{
 if(scenario==='collision_replay'){
  await until(()=>binding);assert.equal(creates,1);assert.equal(chosen,'bbbbbbbb');
  console.log('live-id collision: chose another id before persisting/creating');
  await lane.stop();phase=2;offered=false;lane=startNucleusLane(opts);
  await until(()=>!!bound);assert.equal(bound,chosen);assert.equal(creates,1);assert.equal(sessions.size,2);
  console.log('replay after simulated crash awaiting bind: reused exact reserved runtime; no second create');
 }else{
  await until(()=>writeFault);assert.equal(creates,0);
  assert.deepEqual(JSON.parse(fs.readFileSync(intentsPath,'utf8')),{'older-command':'cccccccc'});
  console.log('partial temp write: prior authoritative map survived unchanged; create never called');
 }
 console.log('PASS: actual lane and on-disk intents with controlled UUID, write fault, relay and launch boundary.');
}finally{await lane.stop();fs.writeFileSync=write;crypto.randomUUID=uuid;syncBuiltinESMExports()}
process.exit(0);
