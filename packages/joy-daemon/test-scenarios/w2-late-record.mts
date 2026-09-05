import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
const root=process.env.JOY_REVIEW_SRC ?? '/tmp/joy-test-tmux/review3/wave2-astra-checkout/packages/joy-daemon/src';
const dir=mkdtempSync('/tmp/joy-test-tmux/review3/wave2-astra-late-record-');
process.env.JOY_HOME_DIR=dir;process.env.TMUX_TMPDIR=dir+'/no-sockets';
const cwd=dir+'/project';mkdirSync(cwd);
const absolute=(src:string,file:string)=>src.replace(/(from\s+["'])(\.[^"']+)(["'])/g,(_,a,p,b)=>a+resolve(dirname(file),p)+b);
let unlock!:()=>void,entered!:()=>void;
const gate=new Promise<void>(r=>unlock=r),ready=new Promise<void>(r=>entered=r);
let spawned=0;
class Client {
 constructor(_port:number){}
 async createSession(){return {id:'oc-conversation'}}
 async switchModel(){entered();await gate}
 onEvent(){} subscribeEvents(){} close(){}
 async request(){return {data:[]}}
}
(globalThis as any).__ocMocks={
 OpencodeClient:Client,isOpencodeServerPid:()=>false,killOpencodeServerPid(){},
 spawnOpencodeServer(){spawned++;return {proc:new EventEmitter(),port:Promise.resolve(12345)}}
};
const ocFile=root+'/opencode/opencodeSession.ts';
let ocSrc=readFileSync(ocFile,'utf8').replace('import { spawnOpencodeServer, OpencodeClient, isOpencodeServerPid, killOpencodeServerPid } from "./opencodeClient";', 'const {spawnOpencodeServer,OpencodeClient,isOpencodeServerPid,killOpencodeServerPid}=(globalThis as any).__ocMocks;');
writeFileSync(dir+'/oc.mts',absolute(ocSrc,ocFile));
const {OpencodeSession}=await import(dir+'/oc.mts');
const registryFile=root+'/domain/registry.ts';
let regSrc=readFileSync(registryFile,'utf8').replace('import { OpencodeSession } from "../opencode/opencodeSession";',`import { OpencodeSession } from ${JSON.stringify(dir+'/oc.mts')};`);
regSrc=regSrc.replace('import { run } from "../tmux/shell";','const run=()=>({ok:false,out:""});');
regSrc=regSrc.replace('import { tmux, tmuxHandleFor, disposeTmuxHandle, type TmuxDriver } from "../tmux/driver";','const tmux={runSync:()=>({ok:false,out:""})}; const tmuxHandleFor=()=>tmux; const disposeTmuxHandle=()=>{}; type TmuxDriver=any;');
regSrc=regSrc.replace('export class SessionRegistry {','export class SessionRegistry { __seed(s:any){this.#sessions.set(s.id,s)}');
writeFileSync(dir+'/registry.mts',absolute(regSrc,registryFile));
const {SessionRegistry}=await import(dir+'/registry.mts');
const {saveWindowRecord,loadWindowRecord}=await import(root+'/domain/windowRecord.ts');
const registry=new SessionRegistry({tmuxSession:'test',relayClient:null});
const s=new OpencodeSession({id:'deadbeef',cwd,model:'test-model',providerID:'test-provider',status:'starting',startedAt:0},{relayClient:null,broadcast(){},addChatMessage(){}});
registry.__seed(s);saveWindowRecord(s.id,{launchCwd:cwd,agent:'opencode'});
s.beginWatching();await ready;
rmSync(cwd,{recursive:true});
await assert.rejects(registry.restart({id:s.id}));
assert.equal(loadWindowRecord(s.id),null);
console.log('failed replacement: record deleted, old startup still awaiting model reply');
unlock();
for(let i=0;i<100&&!loadWindowRecord(s.id);i++)await new Promise(r=>setTimeout(r,5));
assert.equal(s.status,'ended');assert.equal(loadWindowRecord(s.id)?.agent,'opencode');
console.log('late old startup: recreated record after failed replacement',JSON.stringify({status:s.status,reason:s.endReason,record:!!loadWindowRecord(s.id)}));
mkdirSync(cwd);
const next=new SessionRegistry({tmuxSession:'test',relayClient:null});next.recover();
assert.ok(next.get(s.id));assert.equal(spawned,2);
console.log('next recover: restarted the record that replacement cleanup had deleted');
console.log('PASS: copied actual startup/retire/replace/recover logic; process and HTTP client mocked.');
process.exit(0);
