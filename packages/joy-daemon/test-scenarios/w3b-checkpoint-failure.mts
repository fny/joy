import assert from 'node:assert/strict';import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
process.env.JOY_REVIEW_SRC='/tmp/joy-test-tmux/review3/wave3b-daemon-astra-checkout/packages/joy-daemon/src';const {root,codex,relay}=await import('./wave2d-astra-helpers.mts');
const id='c0dec777',rs=relay(),s=codex({id});s.attachRelay(rs as any);s.__setup({turnStart:async()=>({turnId:'unfinished'})});const q=s.enqueue('my prompt');
const write=fs.writeFileSync;fs.writeFileSync=((p:any,...args:any[])=>{if(String(p).includes('codex-checkpoint-'+id))throw new Error('ENOSPC checkpoint write');return (write as any)(p,...args)}) as any;syncBuiltinESMExports();
const item={id:'u',type:'userMessage',clientId:q.id,text:'my prompt'};
try{s.__event({method:'item/completed',params:{threadId:'thread',turnId:'unfinished',item}})}finally{fs.writeFileSync=write;syncBuiltinESMExports()}
const {loadCodexInbound}=await import(root+'/codex/codexInboundStore.ts');const {loadCheckpoint}=await import(root+'/codex/codexCheckpointStore.ts');assert.equal(loadCodexInbound(id).length,0);assert.ok(!loadCheckpoint(id).knownClientIds?.includes(q.id));
const after=codex({id,codexThreadId:'thread'});after.attachRelay(rs as any);after.__setup({});await after.__replay({threadRead:async()=>({thread:{turns:[{id:'unfinished',status:'inProgress',items:[item]}]}})});assert.equal(rs.rows.filter((r:any)=>r.record.role==='user').length,2);console.log('BUG checkpoint save failure after durable inbound deletion loses own identity; recovery duplicates user prompt');process.exit(0);
