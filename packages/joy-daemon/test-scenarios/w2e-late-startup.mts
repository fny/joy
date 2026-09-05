import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {EventEmitter} from 'node:events';
import {resolve,dirname} from 'node:path';
const root='/tmp/joy-test-tmux/review3/wave2e-lifecycle-astra-checkout/packages/joy-daemon/src';
const dir=mkdtempSync('/tmp/joy-test-tmux/review3/wave2e-astra-startup-');process.env.JOY_HOME_DIR=dir;
let release!:(v:any)=>void,entered=false,attachWrites=0;
class Client {
 onNotification(){}onServerRequest(){}onClose(){}async connect(){}close(){}
 threadStart(){entered=true;return new Promise(r=>release=r)}
}
(globalThis as any).__startMocks={CodexAppServerClient:Client,spawnCodexAppServer(){const p=new EventEmitter() as any;p.kill=()=>true;p.exitCode=null;return p}};
const file=root+'/codex/codexSession.ts';
let src=readFileSync(file,'utf8');
// Preserve the imported real error types and replace only process/client construction.
src=src.replace(/import \{([\s\S]*?)\} from "\.\/appServerClient";/,(all,inside)=>{
 if(!inside.includes('CodexAppServerClient'))throw new Error('unexpected import');
 return all.replace(/\bCodexAppServerClient\b/g,'OriginalCodexAppServerClient').replace(/\bspawnCodexAppServer\b/g,'originalSpawnCodexAppServer')+'\nconst {CodexAppServerClient,spawnCodexAppServer}=(globalThis as any).__startMocks;';
});
src=src.replace(/(from\s+["'])(\.[^"']+)(["'])/g,(_,a,p,b)=>a+resolve(dirname(file),p)+b);writeFileSync(dir+'/session.mts',src);
const {CodexSession}=await import(dir+'/session.mts');
const {loadWindowRecord}=await import(root+'/domain/windowRecord.ts');
const {joyStateDir}=await import(root+'/paths.ts');
const tmux={untrack(){},command:async()=>({ok:true,out:''}),literal:async()=>{attachWrites++;return {ok:true,out:''}},key:async()=>({ok:true,out:''})};
const s=new CodexSession({id:'deadbeef',cwd:dir,tmuxWindow:'fake',tmux,status:'starting',startedAt:0},{relayClient:null,broadcast(){},addChatMessage(){}});
s.beginWatching();for(let i=0;i<100&&!entered;i++)await new Promise(r=>setTimeout(r,5));assert.ok(entered);
s.forceKill();assert.equal(loadWindowRecord(s.id),null);assert.equal(existsSync(joyStateDir()+'/codex-inbound-'+s.id+'.json'),false);
release({threadId:'late-thread'});await new Promise(r=>setTimeout(r,30));
assert.equal(s.status,'ended');assert.equal(loadWindowRecord(s.id)?.codexThreadId,'late-thread');
assert.equal(existsSync(joyStateDir()+'/codex-inbound-'+s.id+'.json'),true);assert.equal(attachWrites,1);
console.log('late thread/start after kill recreates window record and inbound file, and launches attach on an ended generation');
console.log('PASS: copied actual Codex startup/kill, controlled client/process and tmux boundary.');process.exit(0);
