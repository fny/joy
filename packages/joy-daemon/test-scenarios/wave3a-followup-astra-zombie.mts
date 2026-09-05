import assert from 'node:assert/strict';import {spawn} from 'node:child_process';import {readFileSync,mkdtempSync} from 'node:fs';
process.env.JOY_HOME_DIR=mkdtempSync('/tmp/joy-test-tmux/review3/wave3-zombie-');
const {killOpencodeServerPid,isOpencodeServerPid}=await import('/tmp/joy-test-tmux/review3/wave3a-followup-astra-checkout/packages/joy-daemon/src/opencode/opencodeClient.ts');
const code=`import os,time,ctypes,signal
pid=os.fork()
if pid==0:
 os.setsid()
 ctypes.CDLL(None).prctl(15,b'opencode.exe',0,0,0)
 print(os.getpid(),flush=True)
 while True:time.sleep(1)
signal.signal(signal.SIGUSR1,lambda *_:os.waitpid(pid,0))
while True:time.sleep(1)
`;
const p=spawn('python3',['-u','-c',code,'serve','--port','0'],{stdio:['ignore','pipe','pipe']});
const child=await new Promise<number>((r,j)=>{p.stdout.once('data',d=>r(Number(d.toString().trim())));p.once('error',j)});
try{assert.equal(isOpencodeServerPid(child),true);const gone=await killOpencodeServerPid(child);const state=readFileSync(`/proc/${child}/stat`,'utf8').split(') ')[1][0];assert.equal(state,'Z');assert.equal(gone,true);console.log('PASS: stopped server is a zombie; helper correctly returns true');}finally{p.kill('SIGUSR1');await new Promise(r=>setTimeout(r,100));p.kill('SIGKILL')}
