import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
const root=process.env.JOY_REVIEW_SRC ?? '/tmp/joy-test-tmux/review3/wave2e-registry-astra-checkout/packages/joy-daemon/src';
const dir=mkdtempSync('/tmp/joy-test-tmux/review3/wave2-astra-registry-');
process.env.JOY_HOME_DIR=dir;
process.env.TMUX_TMPDIR=dir+'/no-sockets';
const deps={relayClient:null,broadcast(){},addChatMessage(){}};
const {Session}=await import(root+'/claude/session.ts');
const {PiSession}=await import(root+'/pi/piSession.ts');
const {CodexSession}=await import(root+'/codex/codexSession.ts');
const {OpencodeSession}=await import(root+'/opencode/opencodeSession.ts');
const {AgySession}=await import(root+'/agy/agySession.ts');
const {saveWindowRecord,loadWindowRecord,deleteWindowRecord}=await import(root+'/domain/windowRecord.ts');
const {machineOps}=await import(root+'/domain/operations.ts');
const starts:string[]=[];
for(const C of [Session,PiSession,CodexSession,OpencodeSession,AgySession])C.prototype.beginWatching=function(){starts.push(this.id)};
const servers=new Set<string>(),commands:any[]=[],drivers=new Map<string,any>();
const ok={ok:true,out:''},bad={ok:false,out:''};
let commandHook:((sock:string,args:string[])=>Promise<void>)|undefined;
function driver(sock:string){
 if(drivers.has(sock))return drivers.get(sock);
 const drv={
  runSync(...args:string[]){commands.push([sock,...args]);if(args[0]==='has-session')return servers.has(sock)?ok:bad;if(args[0]==='new-session'){if(servers.has(sock))return bad;servers.add(sock);return ok}if(args[0]==='kill-server'){servers.delete(sock);return ok}if(args[0]==='list-windows')return bad;return ok},
  async command(args:string[]){commands.push([sock,...args]);await commandHook?.(sock,args);return ok},
  commandOnce:async(args:string[])=>drv.command(args),literal:async(_t:string,text:string)=>{commands.push([sock,'literal',text]);return ok},key:async()=>ok,
  untrack(){},captureCached:()=>bad,captureFresh:async()=>bad,
 };drivers.set(sock,drv);return drv;
}
(globalThis as any).__registryMocks={tmux:driver('shared'),tmuxHandleFor:driver,disposeTmuxHandle(){},run(){return bad}};
// Actual registry, with external tmux/process operations and sleeps replaced;
// seed hook gives fixtures the same private-map placement as create/recover.
const original=root+'/domain/registry.ts';
let src=readFileSync(original,'utf8');
src=src.replace('import { setTimeout as sleep } from "timers/promises";','const sleep = async (_ms: number) => {};');
src=src.replace('import { run } from "../tmux/shell";','const {run}= (globalThis as any).__registryMocks;');
src=src.replace('import { tmux, tmuxHandleFor, disposeTmuxHandle, type TmuxDriver } from "../tmux/driver";','const {tmux,tmuxHandleFor,disposeTmuxHandle}= (globalThis as any).__registryMocks; type TmuxDriver = any;');
src=src.replace('export class SessionRegistry {','export class SessionRegistry { __seed(s:any){this.#sessions.set(s.id,s)} __server(d:any){return this.#newAgentServer(d,"joy-test",process.env.JOY_HOME_DIR!)}');
src=src.replace(/(from\s+["'])(\.[^"']+)(["'])/g,(_,a,p,b)=>a+resolve(dirname(original),p)+b);
writeFileSync(dir+'/registry-test.mts',src);
const {SessionRegistry}=await import(dir+'/registry-test.mts');
const makeRegistry=()=>new SessionRegistry({tmuxSession:'test',relayClient:null});
function claude(id:string,props:any={}){
 return new Session({id,cwd:dir,tmuxWindow:'joy-'+id+':agent',tmux:driver('joy-'+id),flags:[],status:'ended',startedAt:0,...props},deps);
}



const {run:actualRun}=await import(root+'/tmux/shell.ts');
const failed=actualRun(process.execPath,'-e','process.stderr.write("specific tmux failure");process.exit(1)');
assert.deepEqual(failed,{ok:false,out:''});
let attempts=0,ticked=false;const capture:string[]=[];const stderr=process.stderr.write;
process.stderr.write=((chunk:any)=>{capture.push(String(chunk));return true}) as any;
const timer=setTimeout(()=>ticked=true,10),start=Date.now();
try{
 const r=makeRegistry();const ok=r.__server({runSync:(...args:string[])=>{if(args[0]==='has-session')return failed;if(args[0]==='new-session')return ++attempts===1?failed:{ok:true,out:''};return {ok:true,out:''}}});
 assert.equal(ok,true);assert.equal(attempts,2);assert.equal(ticked,false);assert.ok(Date.now()-start>=400);
 assert.ok(capture.join('').includes('new-session failed ()'));assert.ok(!capture.join('').includes('specific tmux failure'));
}finally{process.stderr.write=stderr;clearTimeout(timer)}
console.log('retry succeeded on second attempt, but blocks event loop for >=400ms and real shell helper discards stderr before logging');
console.log('PASS: actual retry helper and actual shell error-capture path, no tmux server launched.');process.exit(0);
