import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
const root=process.env.JOY_REVIEW_SRC ?? '/tmp/joy-test-tmux/review3/wave2-astra-checkout/packages/joy-daemon/src';
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
// #41: actual operation passes forceNew through to create; old detached survives.
{
 const r=makeRegistry(),s=claude('11111111');s.endReason='process_exited';r.__seed(s);
 const op=machineOps.find(o=>o.name==='create')!;
 const out:any=await op.handler(r,{cwd:dir,forceNew:true,agent:'claude'},{via:'http'});
 assert.notEqual(out.session?.id??out.id,s.id);assert.equal(r.get(s.id),s);
 console.log('forceNew operation: old detached retained, new session made');
}
// #44: harness matching and explicit settings; settings omitted by new guard.
for(const [label,opts] of [['agent',{agent:'pi'}],['model',{model:'sonnet'}],['permission',{permissionMode:'plan'}],['yolo_false',{yolo:false}],['chrome',{chrome:true}],['fallback',{fallbackModel:'sonnet'}]] as const){
 const r=makeRegistry(),s=claude('22222222');s.endReason='process_exited';r.__seed(s);
 let revived=false;(r as any).restart=async()=>{revived=true;return s};
 const out=await r.create({cwd:dir,...opts});
 console.log('explicit-create',label,JSON.stringify({revived,flavor:out.agentFlavor}));
 assert.equal(revived,['yolo_false','chrome','fallback'].includes(label));
}
// Existing live same-harness --continue still swallows explicit model.
{
 const r=makeRegistry(),s=claude('33333333',{status:'active',model:'old'});r.__seed(s);
 assert.equal(await r.create({cwd:dir,continue:true,model:'sonnet'}),s);
 console.log('continue + explicit model: returned live old model');
}
// #42 + #45: detached server is retired, simultaneous restarts share replacement.
{
 const r=makeRegistry(),s=claude('44444444',{transcriptPath:dir+'/missing.jsonl'});s.endReason='process_exited';r.__seed(s);
 saveWindowRecord(s.id,{launchCwd:dir,claudePermissionMode:'default'});servers.add('joy-'+s.id);
 const before=commands.length;
 const [a,b]=await Promise.all([r.restart({id:s.id}),r.restart({id:s.id})]);
 assert.equal(a,b);assert.equal(a.id,s.id);
 assert.equal(commands.slice(before).filter(c=>c[1]==='new-session').length,1);
 assert.equal(commands.slice(before).filter(c=>c[1]==='kill-server').length,1);
 assert.ok(!a.flags.includes('--resume'));assert.ok(!a.flags.includes('--continue'));
 console.log('detached + double restart + missing pinned transcript: one same-id fresh replacement');
}
// Auto-revive enters restart and joins a concurrent explicit restart without
// self-waiting. An active id collision is not considered stale by this fixture.
{
 const r=makeRegistry(),s=claude('44444445');s.endReason='process_exited';r.__seed(s);
 saveWindowRecord(s.id,{launchCwd:dir,claudePermissionMode:'default'});
 const [a,b]=await Promise.all([r.create({cwd:dir}),r.restart({id:s.id})]);
 assert.equal(a,b);assert.equal(a.id,s.id);
 console.log('auto-revive + restart: joined without deadlock');
 const before=commands.length;const c=await r.create({id:a.id,cwd:dir,model:'sonnet'});
 assert.notEqual(c,a);assert.ok(commands.slice(before).some(c=>c[1]==='kill-server'));
 assert.equal(a.status,'starting');
 console.log('live id collision: server killed, old object still starting, registry overwritten');
}
// Direct create({id}) is outside the restart mutex and destroys an in-flight server.
{
 const r=makeRegistry(),s=claude('55555555');s.endReason='process_exited';r.__seed(s);
 saveWindowRecord(s.id,{launchCwd:dir,claudePermissionMode:'default'});
 let unblock!:()=>void,entered!:()=>void;const gate=new Promise<void>(a=>unblock=a),ready=new Promise<void>(a=>entered=a);
 let first=true;commandHook=async(sock,args)=>{if(first&&sock==='joy-'+s.id&&args[0]==='resize-window'){first=false;entered();await gate}};
 const restarting=r.restart({id:s.id});await ready;
 const before=commands.length;const created=await r.create({id:s.id,cwd:dir,forceNew:true});
 assert.ok(commands.slice(before).some(c=>c[0]==='joy-'+s.id&&c[1]==='kill-server'));
 unblock();const replacement=await restarting;commandHook=undefined;
 assert.notEqual(created,replacement);
 console.log('restart vs create({id}): second create killed first server; two distinct Session objects returned');
}
// Unknown in-memory object but durable known record: a no-history restart continues
// whichever conversation is newest, including returning an unrelated live session.
{
 const r=makeRegistry(),s=claude('66666666',{status:'active'});r.__seed(s);
 saveWindowRecord('77777777',{launchCwd:dir,claudePermissionMode:'default'});
 const out=await r.restart({id:'77777777'});
 assert.equal(out,s);console.log('restart known record without transcript: returned unrelated live id',out.id);
}
// #52 synchronous failed replacement deletes the record for both headless adapters.
for(const [agent,C] of [['agy',AgySession],['opencode',OpencodeSession]] as const){
 const id=agent==='agy'?'88888888':'99999999',r=makeRegistry();
 const s=new C({id,cwd:dir+'/gone',status:'ended',startedAt:0},deps);s.endReason='process_exited';r.__seed(s);
 saveWindowRecord(id,{launchCwd:s.cwd,agent});
 await assert.rejects(r.restart({id}));assert.equal(loadWindowRecord(id),null);
 console.log('failed replacement record deletion',agent,'passed');
}
// #47: healthy pi record reappears with exact id; dead cwd remains absent; killed
// ended pi record is resumed too (actual forceKill used).
{
 for(const rec of makeRegistry().listRecords())deleteWindowRecord(rec.id);
 const piId='12345678',deadId='23456789',killedId='34567890';
 saveWindowRecord(piId,{launchCwd:dir,agent:'pi',piSettings:{sessionId:'a-pi-id',model:'pi-model'}});
 saveWindowRecord(deadId,{launchCwd:dir+'/gone',agent:'pi',piSettings:{sessionId:'dead-pi-id'}});
 const killed=new PiSession({id:killedId,cwd:dir,status:'ended',startedAt:0,piSessionId:'killed-pi-id'},deps);killed.endReason='process_exited';
 saveWindowRecord(killedId,{launchCwd:dir,agent:'pi',piSettings:{sessionId:killed.piSessionId}});killed.forceKill();
 const r=makeRegistry();r.recover();
 assert.equal(r.get(piId)?.piSessionId,'a-pi-id');assert.equal(r.get(deadId),undefined);assert.equal(r.get(killedId)?.piSessionId,'killed-pi-id');
 console.log('pi recovery:',JSON.stringify({healthy:!!r.get(piId),deadCwd:!!r.get(deadId),killedEnded:!!r.get(killedId)}));
}
console.log('PASS: registry diagnostics (tmux and agent startup mocked, actual selection/restart/recovery/persistence logic).');
process.exit(0);
