import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
const root=process.env.JOY_REVIEW_SRC ?? '/tmp/joy-test-tmux/review3/wave2a-followup-astra-checkout/packages/joy-daemon/src';
const dir=mkdtempSync('/tmp/joy-test-tmux/review3/wave2-astra-lifecycle-');
process.env.JOY_HOME_DIR=dir;
const {Session}=await import(root+'/claude/session.ts');
const {PiSession}=await import(root+'/pi/piSession.ts');
const {CodexSession}=await import(root+'/codex/codexSession.ts');
const {OpencodeSession}=await import(root+'/opencode/opencodeSession.ts');
const {AgySession}=await import(root+'/agy/agySession.ts');
const {machineOps,sessionOps}=await import(root+'/domain/operations.ts');
const {saveWindowRecord,loadWindowRecord}=await import(root+'/domain/windowRecord.ts');
const deps={relayClient:null,broadcast(){},addChatMessage(){}};
let kills=0;
const driver={untrack(){},captureCached:()=>({ok:false,out:''}),runSync:()=>({ok:false,out:''}),command:async()=>{kills++;return {ok:true,out:''}}};
function relay(archiveResult:boolean){let archives=0,stops=0;return new Proxy({relaySessionId:'relay-test',metadataSnapshot:{},get archives(){return archives},get stops(){return stops},archive:async()=>{archives++;return archiveResult},stop(){stops++}}, {get(t,k){return k in t?Reflect.get(t,k):()=>Promise.resolve()}})}
const kill=machineOps.find(o=>o.name==='kill')!;
const killSession=sessionOps.find(o=>o.rpcName==='killSession')!;
for(const [name,Ctor] of [['claude',Session],['pi',PiSession],['codex',CodexSession],['opencode',OpencodeSession],['agy',AgySession]] as const){
 const id=['claude','pi','codex','opencode','agy'].indexOf(name).toString().padStart(8,'0');
 const s=new Ctor({id,cwd:dir,tmuxWindow:'test',tmux:driver,status:'active',startedAt:0,flags:[]} as any,deps as any);
 const rs=relay(true);s.attachRelay(rs as any);saveWindowRecord(id,{launchCwd:dir,agent:name});
 s.end('process_exited');const out=await kill.handler({get:()=>s} as any,{id},{via:'http'});
 console.log('ended-kill',name,JSON.stringify({out,record:!!loadWindowRecord(id),reason:s.endReason,archives:rs.archives,stops:rs.stops}));
 assert.equal(rs.archives,1);
 assert.equal(loadWindowRecord(id),null);assert.equal(rs.stops,1);assert.equal(s.endReason,'killed');
}
for(const op of [kill,killSession]){
 const s=new Session({id:'eeeeeeee',cwd:dir,tmuxWindow:'test',tmux:driver,status:'ended',startedAt:0,flags:[]} as any,deps);
 s.attachRelay(relay(false) as any,true);
 const out=await op.handler(op===kill?{get:()=>s}:s as any,{id:s.id},{via:'rpc'} as any);
 console.log('archive-failure',op.name,JSON.stringify(out));
 assert.deepEqual(out,op===kill?{ok:false}:{success:false,error:'archive failed'});
}
// Copy the actual class unchanged except absolute relative imports and a public
// hook for #pollEnd. Fake only pane/process evidence and timer scheduling.
const original=root+'/claude/session.ts';
let src=readFileSync(original,'utf8').replace(/(from\s+["'])(\.[^"']+)(["'])/g,(_,a,p,b)=>a+resolve(dirname(original),p)+b);
src=src.replace('export class Session {','export class Session { __pollForTest(){ this.#pollEnd(); }');
writeFileSync(dir+'/session-test.mts',src);
const mod=await import(dir+'/session-test.mts');
const running='────\n❯\n────\n⏵⏵ bypass permissions on';
const trust='Quick safety check: Is this a project you created or one you trust?\n ❯ 1. Yes, I trust this folder\n   2. No, exit\nEnter to confirm · Esc to cancel';
const dialog='Select model\n ❯ 1. Opus\n   2. Sonnet\nEnter to confirm · Esc to cancel';
for(const [name,pane] of [['running',running],['dialog',dialog],['trust',trust]]){
 const s=new mod.Session({id:'ffffffff',pid:2147483647,cwd:dir,tmuxWindow:'fake',tmux:{...driver,captureCached:()=>({ok:true,out:pane})},flags:[],status:'active',startedAt:0},deps);
 const timer=globalThis.setTimeout;
 globalThis.setTimeout=(()=>({unref(){}})) as any;
 try{for(let i=0;i<100;i++)s.__pollForTest()}finally{globalThis.setTimeout=timer}
 console.log('frozen-pane',name,JSON.stringify({running:mod.paneShowsClaudeRunning(pane),dialog:!!mod.dialogFromPane(pane),status:s.status}));
 assert.equal(s.status,'ended');
}
console.log('PASS: follow-up lifecycle diagnostics verified with actual classes and operations; poll uses copied class plus test hook.');
process.exit(0);
