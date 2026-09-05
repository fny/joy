import assert from 'node:assert/strict';
import fs from 'node:fs';
import {spawn} from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
const root='/tmp/joy-test-tmux/review3/wave3-daemon-astra-checkout/packages/joy-daemon/src';
process.env.JOY_HOME_DIR=fs.mkdtempSync('/tmp/joy-test-tmux/review3/wave2d-astra-process-');
const {isOpencodeServerPid,killOpencodeServerPid}=await import(root+'/opencode/opencodeClient.ts');
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
function running(pid:number){try{return fs.readFileSync(`/proc/${pid}/stat`,'utf8').split(') ')[1][0]!=='Z'}catch{return false}}
const childScript=`import ctypes,signal,time,os
ctypes.CDLL(None).prctl(15,b'opencode.exe',0,0,0)
signal.signal(signal.SIGTERM,lambda *_: None)
print(os.getpid(),flush=True)
while True: time.sleep(1)
`;
async function single(role:boolean){
 const p=spawn('python3',['-u','-c',childScript,...(role?['serve','--port','0']:[])],{detached:true,stdio:['ignore','pipe','pipe']});
 await new Promise<void>((r,j)=>{p.stdout.once('data',()=>r());p.once('error',j)});return p;
}
{
 const p=await single(false);try{assert.equal(isOpencodeServerPid(p.pid!),false);console.log('role check rejects interactive/name-only helper')}finally{p.kill('SIGKILL')}
}
{
 const p=await single(true);try{
  assert.equal(isOpencodeServerPid(p.pid!),true);const start=Date.now();await killOpencodeServerPid(p.pid!);
  assert.ok(Date.now()-start>=1900);assert.equal(running(p.pid!),false);
  console.log('awaited kill escalates TERM-ignoring server and returns after it stops');
 }finally{try{process.kill(-p.pid!,'SIGKILL')}catch{}}
}
// One disappearing unrelated /proc entry must not hide the surviving server.
const launcherScript=`import ctypes,subprocess,sys
ctypes.CDLL(None).prctl(15,b'opencode',0,0,0)
subprocess.Popen([sys.executable,'-u','-c',${JSON.stringify(childScript)},'serve','--port','0']).wait()
`;
const launcher=spawn('python3',['-u','-c',launcherScript,'serve','--port','0'],{detached:true,stdio:['ignore','pipe','pipe']});
const readdir=fs.readdirSync,read=fs.readFileSync;
try{
 const serverPid=await new Promise<number>((r,j)=>{launcher.stdout.once('data',d=>r(Number(d.toString().trim())));launcher.once('error',j)});
 assert.equal(isOpencodeServerPid(launcher.pid!),true);
 fs.readdirSync=((p:any,...args:any[])=>String(p)==='/proc'?['99999999',String(serverPid)]:(readdir as any)(p,...args)) as any;
 fs.readFileSync=((p:any,...args:any[])=>{if(String(p)==='/proc/99999999/stat')throw Object.assign(new Error('disappeared'),{code:'ENOENT'});return (read as any)(p,...args)}) as any;
 syncBuiltinESMExports();
 const start=Date.now();await killOpencodeServerPid(launcher.pid!);
 assert.ok(Date.now()-start>=1900);assert.equal(running(serverPid),false);
 console.log('one unrelated /proc ENOENT no longer hides the TERM-ignoring server child');
}finally{fs.readdirSync=readdir;fs.readFileSync=read;syncBuiltinESMExports();try{process.kill(-launcher.pid!,'SIGKILL')}catch{}}
console.log('PASS: actual process helpers; only owned helper processes signalled.');process.exit(0);
