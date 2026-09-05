import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,readFileSync} from 'node:fs';
const root=process.env.JOY_REVIEW_SRC ?? '/tmp/joy-test-tmux/review3/wave2b-astra-checkout/packages/joy-daemon/src';
process.env.JOY_HOME_DIR=mkdtempSync('/tmp/joy-test-tmux/review3/wave2b-astra-process-');
const {isOpencodeServerPid,killOpencodeServerPid}=await import(root+'/opencode/opencodeClient.ts');
// Owned test process only: identical comm to a server/TUI, deliberately no
// `serve` command and no Joy ownership. Ignore TERM to expose lack of waiting.
const child=spawn('python3',['-u','-c',`import ctypes,signal,time
ctypes.CDLL(None).prctl(15,b'opencode.exe',0,0,0)
signal.signal(signal.SIGTERM,lambda *_: None)
print('ready',flush=True)
while True: time.sleep(1)
`],{detached:true,stdio:['ignore','pipe','pipe']});
try{
 await new Promise<void>((resolve,reject)=>{child.stdout.once('data',()=>resolve());child.once('error',reject)});
 assert.equal(isOpencodeServerPid(child.pid!),true);
 assert.match(readFileSync(`/proc/${child.pid}/cmdline`,'utf8').split('\0')[0],/(?:^|\/)python(?:3(?:\.\d+)?)?$/);
 console.log('ESM check works, but accepts an unrelated process based only on opencode.exe comm');
 const at=Date.now();killOpencodeServerPid(child.pid!);
 assert.ok(Date.now()-at<1000);process.kill(child.pid!,0);
 await new Promise(r=>setTimeout(r,100));process.kill(child.pid!,0);
 console.log('kill helper returned while old process remains live; replacement startup has no exit barrier');
 await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('escalation did not kill test child')),3500);child.once('exit',()=>{clearTimeout(timer);resolve()})});
 console.log('SIGKILL escalation eventually exited old process');
}finally{try{process.kill(-child.pid!,'SIGKILL')}catch{}}
// The recorded pid belongs to the launcher, not necessarily the server child.
const serverScript=`import ctypes,signal,time,os
ctypes.CDLL(None).prctl(15,b'opencode.exe',0,0,0)
signal.signal(signal.SIGTERM,lambda *_: None)
print(os.getpid(),flush=True)
while True: time.sleep(1)
`;
const launcherScript=`import ctypes,subprocess,sys
ctypes.CDLL(None).prctl(15,b'opencode',0,0,0)
subprocess.Popen([sys.executable,'-u','-c',${JSON.stringify(serverScript)}]).wait()
`;
const launcher=spawn('python3',['-u','-c',launcherScript],{detached:true,stdio:['ignore','pipe','pipe']});
try {
 const serverPid=await new Promise<number>((resolve,reject)=>{launcher.stdout.once('data',d=>resolve(Number(d.toString().trim())));launcher.once('error',reject)});
 assert.ok(Number.isInteger(serverPid));assert.equal(isOpencodeServerPid(launcher.pid!),true);
 const exit=new Promise<void>(r=>launcher.once('exit',()=>r()));
 killOpencodeServerPid(launcher.pid!);await exit;
 await new Promise(r=>setTimeout(r,2300));
 process.kill(serverPid,0);
 assert.notEqual(readFileSync(`/proc/${serverPid}/stat`,'utf8').split(') ')[1][0],'Z');
 console.log('launcher exited after group TERM, but its TERM-ignoring server child survived the escalation deadline');
} finally {try{process.kill(-launcher.pid!,'SIGKILL')}catch{}}
console.log('PASS: actual ESM process checks and kill helper, isolated owned child only.');process.exit(0);
