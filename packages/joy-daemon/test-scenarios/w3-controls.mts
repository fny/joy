import assert from 'node:assert/strict';
process.env.JOY_REVIEW_SRC='/tmp/joy-test-tmux/review3/wave3-daemon-astra-checkout/packages/joy-daemon/src';
const {root,dir,codex,opencode,driver,deps}=await import('./wave2d-astra-helpers.mts');
for(const factory of [codex,opencode]){const s=factory();let calls=0;const reject=async()=>{calls++;throw new Error('agent interrupt transport failed')};s.__setup({turnInterrupt:reject,interrupt:reject});if(s.__busyTurn)s.__busyTurn('turn');const result=await s.abort();assert.equal(calls,1);assert.equal(result.ok,true);console.log(s.agentFlavor,'abort swallows interrupt failure and returns ok');}
const {Session,paneShowsReadyPrompt,dialogFromPane}=await import(root+'/claude/session.ts');
let keys=0;const frame='Which option?\n ❯ 1. A\n   2. B\nEnter to confirm · Esc to cancel';assert.equal(paneShowsReadyPrompt(frame),false);assert.ok(dialogFromPane(frame));
const tmux={...driver,captureFresh:async()=>({ok:true,out:frame}),literal:async()=>{keys++;return {ok:true,out:''}},key:async()=>{keys++;return {ok:true,out:''}}};
const s=new Session({id:'abcddcba',cwd:dir,tmuxWindow:'review',tmux,flags:[],status:'active',startedAt:0},deps);const q=s.enqueue('B',{source:'rpc',visible:false,mirrorToRelay:false});await new Promise(r=>setTimeout(r,600));assert.equal(keys,0);assert.equal(s.queueItemState(q.id),'pending');console.log('BUG ordinary answer message remains pending at a Claude question picker; zero answer keystrokes');s.cancelQueued(q.id);process.exit(0);
