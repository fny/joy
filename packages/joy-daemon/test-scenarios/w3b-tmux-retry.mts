import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
const root=process.env.JOY_REVIEW_SRC ?? '/tmp/joy-test-tmux/review3/wave3b-daemon-astra-checkout/packages/joy-daemon/src';
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

src=src.replace('import { run } from "../tmux/shell";','const {run}= (globalThis as any).__registryMocks;');
src=src.replace('import { tmux, tmuxHandleFor, disposeTmuxHandle, type TmuxDriver } from "../tmux/driver";','const {tmux,tmuxHandleFor,disposeTmuxHandle}= (globalThis as any).__registryMocks; type TmuxDriver = any;');
src=src.replace('export class SessionRegistry {','export class SessionRegistry { __seed(s:any){this.#sessions.set(s.id,s)} __newForTest(d:any){return this.#newAgentServer(d,"review","/tmp")}');
src=src.replace(/(from\s+["'])(\.[^"']+)(["'])/g,(_,a,p,b)=>a+resolve(dirname(original),p)+b);
writeFileSync(dir+'/registry-test.mts',src);
const {SessionRegistry}=await import(dir+'/registry-test.mts');
const makeRegistry=()=>new SessionRegistry({tmuxSession:'test',relayClient:null});
function claude(id:string,props:any={}){
 return new Session({id,cwd:dir,tmuxWindow:'joy-'+id+':agent',tmux:driver('joy-'+id),flags:[],status:'ended',startedAt:0,...props},deps);
}



const r=makeRegistry();let attempts=0,pulses=0;const log:string[]=[];const write=process.stderr.write;process.stderr.write=((s:any)=>{log.push(String(s));return true}) as any;
const d={runSync(command:string){if(command==='has-session')return {ok:false};if(command==='new-session'){attempts++;return attempts===1?{ok:false,error:'real tmux diagnostic'}:{ok:true}}return {ok:true}}};
const pulse=setInterval(()=>pulses++,20);const started=Date.now();try{assert.equal(await r.__newForTest(d),true)}finally{clearInterval(pulse);process.stderr.write=write}
assert.equal(attempts,2);assert.ok(pulses>=10);assert.ok(log.some(s=>s.includes('real tmux diagnostic')));console.log('PASS async tmux retry: two attempts, error logged, elapsed',Date.now()-started,'ms, heartbeat count',pulses);process.exit(0);
