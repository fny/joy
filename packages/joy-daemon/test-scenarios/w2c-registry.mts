import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
const root=process.env.JOY_REVIEW_SRC ?? '/tmp/joy-test-tmux/review3/wave2c-astra-checkout/packages/joy-daemon/src';
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
src=src.replace('export class SessionRegistry {','export class SessionRegistry { __seed(s:any){this.#sessions.set(s.id,s)}');
src=src.replace(/(from\s+["'])(\.[^"']+)(["'])/g,(_,a,p,b)=>a+resolve(dirname(original),p)+b);
writeFileSync(dir+'/registry-test.mts',src);
const {SessionRegistry}=await import(dir+'/registry-test.mts');
const makeRegistry=()=>new SessionRegistry({tmuxSession:'test',relayClient:null});
function claude(id:string,props:any={}){
 return new Session({id,cwd:dir,tmuxWindow:'joy-'+id+':agent',tmux:driver('joy-'+id),flags:[],status:'ended',startedAt:0,...props},deps);
}

const tick=()=>new Promise(r=>setTimeout(r,5));
const settle=async(p:Promise<any>)=>Promise.race([p.then(v=>({state:'resolved',v}),e=>({state:'rejected',error:String(e)})),new Promise(r=>setTimeout(()=>r({state:'pending'}),100))]) as any;
// Ordinary restarts and every headless variant must not join their own promise.
for(const [agent,C] of [['claude',Session],['pi',PiSession],['opencode',OpencodeSession],['agy',AgySession],['codex',CodexSession]] as const){
 const r=makeRegistry(),id='dead'+String(['claude','pi','opencode','agy','codex'].indexOf(agent)).padStart(4,'0');
 const s=agent==='claude'?claude(id):new C({id,cwd:dir,status:'ended',startedAt:0},deps);
 s.endReason='process_exited';r.__seed(s);saveWindowRecord(id,{launchCwd:dir,agent});
 const before=starts.length;
 const p=r.restart({id});const out=await settle(p);
 assert.equal(out.state,'pending');assert.equal(r.get(id),undefined);assert.equal(starts.length,before);
 const joined=await settle(r.create({id,cwd:dir}));assert.equal(joined.state,'pending');
 console.log('restart self-wait',agent,JSON.stringify({state:out.state,removed:!r.get(id),newStarts:starts.length-before,externalJoin:joined.state}));
}
{
 const r=makeRegistry();saveWindowRecord('77777777',{launchCwd:dir,claudePermissionMode:'default'});
 const other=claude('66666666',{status:'active'});r.__seed(other);
 const out=await settle(r.restart({id:'77777777'}));assert.equal(out.state,'pending');assert.equal(r.get(other.id),other);
 console.log('record-only restart: also self-waits; unrelated live session retained');
}
// The explicit-id branch does fix synchronous adoption and active-id clashes.
{
 const r=makeRegistry(),s=claude('11111111');s.endReason='process_exited';r.__seed(s);
 const next=await r.create({id:'11111112',cwd:dir});assert.equal(next.id,'11111112');assert.equal(r.get(s.id),s);
 const before=commands.length;await assert.rejects(r.create({id:next.id,cwd:dir}),/id_in_use/);
 assert.equal(commands.length,before);console.log('explicit id: skipped detached adoption and refused live collision without tmux writes');
}
// But two creates can pass the live check before either registers its object.
{
 const r=makeRegistry(),id='aabbccdd';let release!:()=>void,entered!:()=>void;
 const gate=new Promise<void>(x=>release=x),ready=new Promise<void>(x=>entered=x);let first=true;
 commandHook=async(sock,args)=>{if(first&&sock==='joy-'+id&&args[0]==='resize-window'){first=false;entered();await gate}};
 const p=r.create({id,cwd:dir});await ready;const before=commands.length;
 const second=await r.create({id,cwd:dir});release();const firstResult=await p;commandHook=undefined;
 assert.notEqual(firstResult,second);assert.ok(commands.slice(before).some(c=>c[1]==='kill-server'));
 console.log('create/create race: second killed first server; two distinct starting objects returned');
}
// Explicit settings and both adoption branches.
for(const [label,opts] of [['model',{model:'sonnet'}],['permission',{permissionMode:'plan'}],['yolo_false',{yolo:false}],['chrome',{chrome:true}],['fallback',{fallbackModel:'sonnet'}]] as const){
 const r=makeRegistry(),s=claude('22222222');s.endReason='process_exited';r.__seed(s);
 let revived=false;r.restart=async()=>{revived=true;return s};
 await r.create({cwd:dir,...opts});assert.equal(revived,false);console.log('explicit detached settings respected',label);
}
{
 const r=makeRegistry(),s=claude('33333333',{status:'active',model:'sonnet',claudeSessionId:'conversation'});r.__seed(s);
 await assert.rejects(r.create({cwd:dir,continue:true,model:'other'}),/already live/);
 await assert.rejects(r.create({cwd:dir,continue:true,model:'sonnet'}),/already live/);
 const got=await r.create({cwd:dir,resume_id:'conversation',model:'other'});assert.equal(got,s);
 await assert.rejects(r.create({cwd:dir,continue:true,forceNew:true,model:'other'}),/already live/);
 console.log('continue: different and identical explicit models both conflict, including forceNew; resume with different model still returns old model');
}
{
 const r=makeRegistry(),s=claude('44444444',{flags:['--permission-mode','plan']});s.endReason='process_exited';r.__seed(s);
 let revived=false;r.restart=async()=>{revived=true;return s};await r.create({cwd:dir,yolo:true});assert.equal(revived,true);
 console.log('explicit yolo:true still auto-revives old plan session');
}
console.log('PASS: actual registry control flow with isolated records and mocked tmux/startup.');process.exit(0);
