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
src=src.replace('export class SessionRegistry {','export class SessionRegistry { __seed(s:any){this.#sessions.set(s.id,s)}');
src=src.replace(/(from\s+["'])(\.[^"']+)(["'])/g,(_,a,p,b)=>a+resolve(dirname(original),p)+b);
writeFileSync(dir+'/registry-test.mts',src);
const {SessionRegistry}=await import(dir+'/registry-test.mts');
const makeRegistry=()=>new SessionRegistry({tmuxSession:'test',relayClient:null});
function claude(id:string,props:any={}){
 return new Session({id,cwd:dir,tmuxWindow:'joy-'+id+':agent',tmux:driver('joy-'+id),flags:[],status:'ended',startedAt:0,...props},deps);
}


const settle=(p:Promise<any>)=>Promise.race([p.then(v=>({state:'resolved',v}),e=>({state:'rejected',error:String(e)})),new Promise(r=>setTimeout(()=>r({state:'pending'}),150))]) as any;
// All ordinary restarts now resolve; double restarts join.
for(const [agent,C] of [['claude',Session],['pi',PiSession],['opencode',OpencodeSession],['agy',AgySession],['codex',CodexSession]] as const){
 const r=makeRegistry(),id='dead'+String(['claude','pi','opencode','agy','codex'].indexOf(agent)).padStart(4,'0');
 const s=agent==='claude'?claude(id):new C({id,cwd:dir,status:'ended',startedAt:0},deps);
 s.endReason='process_exited';r.__seed(s);saveWindowRecord(id,{launchCwd:dir,agent});
 const [a,b]=await Promise.all([settle(r.restart({id})),settle(r.restart({id}))]);
 assert.equal(a.state,'resolved');assert.equal(a.v,b.v);assert.equal(a.v.id,id);console.log(agent,'restart and double restart resolve to one replacement');
}
{
 const r=makeRegistry();saveWindowRecord('77777777',{launchCwd:dir,claudePermissionMode:'default'});r.__seed(claude('66666666',{status:'active'}));
 const out=await r.restart({id:'77777777'});assert.equal(out.id,'77777777');assert.ok(!out.flags.includes('--continue'));assert.ok(!out.flags.includes('--resume'));
 console.log('record-only no-history restart: same id, fresh flags, no cwd adoption');
}
// A second create is rejected while the first is waiting in tmux setup.
{
 const r=makeRegistry(),id='aabbccdd';let release!:()=>void,entered!:()=>void;
 const gate=new Promise<void>(x=>release=x),ready=new Promise<void>(x=>entered=x);let first=true;
 commandHook=async(sock,args)=>{if(first&&sock==='joy-'+id&&args[0]==='resize-window'){first=false;entered();await gate}};
 const p=r.create({id,cwd:dir});await ready;const before=commands.length;
 await assert.rejects(r.create({id,cwd:dir}),/id_in_use/);assert.equal(commands.length,before);
 release();await p;commandHook=undefined;console.log('in-flight create collision: rejected without touching first server');
}
// A joiner can reserve the very id the pending restart needs to construct.
{
 const r=makeRegistry(),s=claude('aabbccde');s.endReason='process_exited';r.__seed(s);saveWindowRecord(s.id,{launchCwd:dir});
 let release!:()=>void;const gate=new Promise<void>(r=>release=r);s.awaitExit=()=>gate;
 const restarting=r.restart({id:s.id});const create=r.create({id:s.id,cwd:dir});
 const both=Promise.all([settle(restarting),settle(create)]);release();const out=await both;
 assert.ok(out.every((o:any)=>o.state==='rejected'&&o.error.includes('id_in_use')));
 assert.equal(r.get(s.id),undefined);assert.equal(loadWindowRecord(s.id),null);
 console.log('create joining retiring restart: both rejected id_in_use; no replacement, record deleted');
}
{
 const r=makeRegistry(),s=claude('33333333',{status:'active',model:'sonnet',claudeSessionId:'conversation'});r.__seed(s);
 for(const identify of [{continue:true},{resume_id:'conversation'}]){
  assert.equal(await r.create({cwd:dir,...identify,model:'sonnet'}),s);
  await assert.rejects(r.create({cwd:dir,...identify,model:'other'}),/different settings/);
  for(const extra of [{fallbackModel:'other'},{chrome:true},{extraArgs:'--different-setting'}])assert.equal(await r.create({cwd:dir,...identify,...extra}),s);
 }
 console.log('resume/continue compare model correctly, but ignore differing fallbackModel/chrome/extraArgs');
 s.detectPermissionMode=()=> 'plan';await assert.rejects(r.create({cwd:dir,continue:true,permissionMode:'plan',yolo:true}),/different settings/);
 console.log('matching explicit plan mode with overridden yolo:true incorrectly conflicts');
 assert.equal(await r.create({cwd:dir,continue:true,forceNew:true,model:'sonnet'}),s);
 console.log('forceNew + continue still adopts live session');
}
for(const yolo of [false,true]){
 const r=makeRegistry(),s=claude('44444444');s.endReason='process_exited';r.__seed(s);let revived=false;r.restart=async()=>{revived=true;return s};await r.create({cwd:dir,yolo});assert.equal(revived,false);
}
console.log('explicit yolo either way blocks detached auto-revive');
console.log('PASS: pinned registry, isolated records, mocked tmux/agent startup.');process.exit(0);
