import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {root,codex,opencode,sleep} from './wave2d-astra-helpers.mts';
const {loadCodexInbound,saveCodexInbound}=await import(root+'/codex/codexInboundStore.ts');
const {loadCheckpoint,saveCheckpoint}=await import(root+'/codex/codexCheckpointStore.ts');
const {joyStateDir}=await import(root+'/paths.ts');
const {JsonRpcResponseError}=await import(root+'/codex/appServerClient.ts');
// Ordinary ended cleanup removes both files.
for(const s of [codex({id:'c0dec231',status:'ended'}),opencode({id:'0c0dec31',status:'ended'})]){
 saveCodexInbound(s.id,[{clientId:'queued',text:'old',state:'queued',at:1}]);
 if(s.agentFlavor==='codex')saveCheckpoint(s.id,{threadId:'thread',deliveredThroughTurnId:'turn'});
 s.forceKill();assert.equal(existsSync(joyStateDir()+'/codex-inbound-'+s.id+'.json'),false);
 if(s.agentFlavor==='codex')assert.equal(loadCheckpoint(s.id).deliveredThroughTurnId,null);
 console.log(s.agentFlavor+': ordinary ended forceKill removes inbound/checkpoint');
}
// An outstanding send can still persist the old in-memory array after cleanup.
{
 const s=codex({id:'c0dec232'});let reject!:(e:any)=>void;
 s.__setup({turnStart:()=>new Promise((_r,j)=>reject=j),close(){}});
 s.enqueue('A');const b=s.enqueue('B');s.end('process_exited');s.forceKill();
 assert.equal(existsSync(joyStateDir()+'/codex-inbound-'+s.id+'.json'),false);
 reject(new JsonRpcResponseError(-32602,'invalid input'));await sleep(30);
 assert.ok(loadCodexInbound(s.id).some((i:any)=>i.clientId===b.id));
 console.log('Codex late rejection restores killed session inbound queue including unsent B');
}
{
 const s=opencode({id:'0c0dec32'});let release!:(v:any)=>void;const posted:string[]=[];
 s.enqueue('A');const b=s.enqueue('B');
 s.__setup({prompt:async(_s:string,text:string,o:any)=>{posted.push(text);if(text==='A')return await new Promise(r=>release=r);return await new Promise(()=>{})},close(){}});
 void s.__drain();s.end('process_exited');s.forceKill();assert.equal(loadCodexInbound(s.id).length,0);
 release({messageID:loadCodexInbound(s.id)[0]?.clientId??'ack'});await sleep(30);
 assert.ok(loadCodexInbound(s.id).some((i:any)=>i.clientId===b.id));assert.equal(posted.length,2);
 console.log('OpenCode late ack restores killed queue and continues sending B through captured client');
}
console.log('PASS: actual adapter teardown and late send continuations, isolated stores.');process.exit(0);
