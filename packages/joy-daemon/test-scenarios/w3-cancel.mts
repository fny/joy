import assert from 'node:assert/strict';
import {mkdtempSync,readdirSync} from 'node:fs';
const root=process.env.JOY_REVIEW_SRC ?? '/tmp/joy-test-tmux/review3/wave3-daemon-astra-checkout/packages/joy-daemon/src';
const dir=mkdtempSync('/tmp/joy-test-tmux/review3/wave2b-astra-cancel-');process.env.JOY_HOME_DIR=dir;
const {startNucleusLane}=await import(root+'/relay/nucleusLane.ts');
const scenario=process.argv[2]??'download';
const timer=globalThis.setTimeout;
const sleep=(ms:number)=>new Promise(r=>timer(r,ms));
globalThis.setTimeout=((fn:any,ms:number,...rest:any[])=>timer(fn,ms===1000||ms===500?10:ms,...rest)) as any;
async function until(fn:()=>boolean){for(let i=0;i<600&&!fn();i++)await sleep(5);assert.ok(fn(),'condition reached')}
let offered=false,cancelOffered=false,downloading=false,enqueues=0,aborts=0,plucks=0,busy=false,terminal:any=null;
let release!:()=>void;const download=new Promise<void>(r=>release=r);
const row={sessionId:'relay-session',localSessionId:'local',daemonId:'machine',state:'active',executing:null,queuedTurns:0};
const s:any={id:'local',cwd:dir,status:'active',cardMetadata:()=>null,setV2Link(){},busy:()=>busy,queueState:()=>({pendingCount:0,paused:false}),queueItemState:()=> 'delivered',enqueue(){enqueues++;busy=true;return {id:'queue-item',...(scenario==='handled_start'?{handled:'command',reinjectionId:'rein-item'}:{})}},cancelQueued(){plucks++;return scenario!=='handled_start'},async abort(){aborts++;busy=false}};
const registry:any={get:(id:string)=>id===s.id?s:undefined,list:()=>[s],listRecords:()=>[{id:s.id,v2SessionId:row.sessionId}],saveRecord(){},chatHistory:()=>[]};
const logs:string[]=[];
globalThis.fetch=(async(input:any,init:any={})=>{
 const path=new URL(String(input)).pathname.replace('/joy/v2','');const body=init.body?JSON.parse(init.body):{};
 if(path==='/daemon/leases')return Response.json({leaseId:'lease',leaseToken:'token',epoch:'1'});
 if(path==='/sessions')return Response.json({sessions:[row]});
 if(path.startsWith('/sessions/'))return Response.json({execution:null});
 if(path.includes('/claims/')){
  await sleep(10);
  if(path.endsWith('/work')&&!offered){offered=true;return Response.json({offers:[{kind:'prompt',sessionId:row.sessionId,turnId:'turn',commandId:'cmd',deliveryId:'prompt-delivery',attachments:scenario!=='plain'?[{id:'attachment',size:4}]:[],ciphertext:JSON.stringify({v:1,t:'plain',text:'test',attachments:scenario!=='plain'?[{id:'attachment',name:'photo.txt',size:4}]:[]})}]})}
  if(path.endsWith('/control')&&scenario==='download'&&downloading&&!cancelOffered){cancelOffered=true;return Response.json({offers:[{sessionId:row.sessionId,targetTurnId:'turn',commandId:'cancel',deliveryId:'cancel-delivery'}]})}
  return Response.json({offers:[]});
 }
 if(path.startsWith('/attachments/')){downloading=true;if(scenario==='download')await download;return new Response('data')}
 if(path.endsWith('/start')&&(scenario==='start_rejected'||scenario==='handled_start'))return Response.json({error:'turn_cancelled'},{status:409});
 if(body.type==='terminal')terminal=body;
 return Response.json({});
}) as any;
const lane=startNucleusLane({registry,relayUrl:'https://relay.test',token:'token',machineId:'machine',log:s=>logs.push(s)});
try{
 if(scenario==='download'){
  await until(()=>aborts===1);release();await until(()=>!!terminal);
  assert.equal(enqueues,0);assert.equal(terminal.terminalState,'cancelled');
  const files=readdirSync(dir).filter(f=>f.includes('photo'));assert.equal(files.length,0);
  console.log('cancel during attachment download: no enqueue; cancelled terminal; materialized files cleaned',JSON.stringify(files));
 }else if(scenario==='handled_start'){
  await until(()=>!!terminal);assert.equal(enqueues,1);assert.equal(aborts,0);assert.equal(plucks,1);assert.equal(busy,true);assert.equal(terminal.terminalState,'cancelled');console.log('handled-command start rejected: local work still busy, zero aborts despite admitted reinjection, cancelled terminal');
 }else{
  await until(()=>!!terminal);assert.equal(enqueues,1);assert.equal(aborts,1);assert.equal(plucks,1);assert.equal(busy,false);assert.equal(terminal.terminalState,'cancelled');
  assert.equal(readdirSync(dir).filter(f=>f.includes('photo')).length,0);console.log('start rejected: agent aborted and attachment cleaned');
  console.log('start rejected as turn_cancelled:',JSON.stringify({enqueues,aborts,plucks,busy,terminal:terminal.terminalState}));
 }
 console.log('remaining attachments:',readdirSync(dir).filter(f=>f.includes('photo'))); console.log('PASS: actual lane with controlled relay timing and adapter boundary.');
}finally{await lane.stop();globalThis.setTimeout=timer}
process.exit(0);
