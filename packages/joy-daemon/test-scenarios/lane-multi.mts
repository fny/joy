import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
process.env.JOY_HOME_DIR=mkdtempSync('/tmp/joy-test-tmux/review3/wave1-astra-multi-');
const root='../src';
const {startNucleusLane}=await import(root+'/relay/nucleusLane.ts');
const {RelaySession,encodeTextEvent}=await import(root+'/relay/relay.ts');
const {spool,seedSpool}=await import('./ledger-spool-shim.mts');
const {joyStateDir}=await import(root+'/paths.ts');
const realTimeout=globalThis.setTimeout,realNow=Date.now;
const sleep=(ms:number)=>new Promise(r=>realTimeout(r,ms));
let offset=0;Date.now=()=>realNow()+offset;
globalThis.setTimeout=((fn:any,ms:any,...args:any[])=>realTimeout(fn,ms===8000?30:ms,...args)) as any;
async function until(fn:()=>boolean){for(let i=0;i<1500&&!fn();i++)await sleep(5);assert.ok(fn(),'condition reached');}
const dir=joyStateDir(),path=join(dir,'v2-outbound.json');mkdirSync(dir,{recursive:true});
const wire=encodeTextEvent('old answer',{turn:'runtime-old'});
seedSpool(dir,Array.from({length:2001},(_,i)=>({kind:'output' as const,id:'old-'+i,localId:'local-A',v2SessionId:'session-A',turnId:null,wire,runtimeEventId:'old-'+i,at:Date.now()})));
const adapters=Object.fromEntries(['A','B'].map(id=>[id,new RelaySession({client:{creds:{machineId:'machine'}} as any,relaySessionId:'local-'+id,metadata:{}})]));
let receipts=0;adapters.B.setReceiptSink(()=>receipts++);
const enqueued:string[]=[],done=new Set<string>(),logs:string[]=[],calls:any[]=[];
const sessions=Object.fromEntries(['A','B'].map(id=>[id,{id:'local-'+id,status:'active',cardMetadata:()=>null,enqueue(){enqueued.push(id);adapters[id].send(encodeTextEvent('new '+id,{turn:'turn-'+id}),'new-'+id);if(id==='B')adapters.B.stampReceiptOnLastQueued({uuid:'rB',turn:'turn-B'});return {id:'q-'+id,handled:'command'};}}]));
const registry:any={get:(id:string)=>Object.values(sessions).find(s=>s.id===id),list:()=>Object.values(sessions),listRecords:()=>['A','B'].map(id=>({id:'local-'+id,v2SessionId:'session-'+id})),saveRecord(){},chatHistory:()=>[]};
let release:()=>void=()=>{};const gate=new Promise<void>(r=>release=r);
const reply=(o:any={})=>new Response(JSON.stringify(o),{status:200});
globalThis.fetch=async(input:any,init:any={})=>{
 const p=new URL(String(input)).pathname.replace('/joy/v2',''),body=init.body?JSON.parse(init.body):{};
 if(p==='/daemon/leases')return reply({leaseId:'lease',leaseToken:'token',epoch:1});
 if(init.method==='PUT')return reply();
 if(p==='/sessions')return reply({sessions:['A','B'].map(id=>({sessionId:'session-'+id,daemonId:'machine',localSessionId:'local-'+id,state:'active',executing:null,queuedTurns:done.has(id)?0:1}))});
 if(p.startsWith('/sessions/'))return reply({execution:{state:'idle'},queue:{queuedTurns:1}});
 if(p.includes('/claims/')){await sleep(15);return reply({offers:p.endsWith('/work')?['A','B'].filter(id=>!done.has(id)).map(id=>({kind:'prompt',sessionId:'session-'+id,turnId:'turn-'+id,commandId:'command-'+id,deliveryId:'delivery-'+id,ciphertext:JSON.stringify({v:1,t:'plain',text:'prompt '+id})})):[]});}
 calls.push({p,body});
 if(body.type==='output'&&p.includes('session-A'))await gate;
 if(body.type==='terminal')done.add(p.includes('turn-B')?'B':'A');
 return reply();
};
const lane=startNucleusLane({registry,relayUrl:'http://relay.invalid',token:'token',machineId:'machine',log:s=>logs.push(s)});
try{
 await until(()=>done.has('B'));
 assert.deepEqual(enqueued,['B']);assert.equal(spool(dir).pendingOutputs('local-A'),2001);
 assert.equal(adapters.A.outboundPersistDegraded,true);assert.equal(adapters.B.outboundPersistDegraded,true);assert.equal(receipts,0);
 assert.ok(!calls.some(c=>c.p.includes('/delivery-A/received')));
 release();await until(()=>spool(dir).pendingOutputs('local-A')===0);await until(()=>receipts===1);
 offset=16000;await until(()=>done.has('A'));assert.deepEqual(enqueued,['B','A']);
 assert.equal(receipts,1);assert.equal(adapters.B.outboundPersistDegraded,false);
 console.log(JSON.stringify({result:'PASS',enqueued,globalHealthStayedDegradedAcrossBOutputAndTerminal:true,heldBReceiptsReleasedOnceAfterADrained:true,ADispatchedAfterDrain:true}));
}finally{await lane.stop();}
process.exit(0);
