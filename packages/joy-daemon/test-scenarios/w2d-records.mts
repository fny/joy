import assert from 'node:assert/strict';
import {root,codex,opencode,relay} from './wave2d-astra-helpers.mts';
const {OpencodeNormalizer}=await import(root+'/opencode/normalize.ts');
const event=(r:any)=>r.record.content?.data?.ev;
// Stored OpenCode state completion matches the live outcome, including errors.
for(const state of [{status:'completed',output:'answer'},{status:'error',error:{message:'denied'}},{status:'completed',output:'x'.repeat(60_000)}]){
 const s=opencode(),rs=relay();s.attachRelay(rs as any);
 s.__setup({messages:async()=>[{type:'user',id:'user'}, {type:'assistant',id:'assistant',finish:'stop',content:[{type:'tool',id:'call',state}]}]});
 await s.__replay();const end=event(rs.rows.find((r:any)=>event(r)?.t==='tool-call-end'));
 const n=new OpencodeNormalizer('oc-session');n.setTurn('user');
 const live=n.handle({type:state.status==='error'?'session.next.tool.error':'session.next.tool.success',data:{callID:'call',assistantMessageID:'assistant',output:state.output,error:state.error}}).find((e:any)=>e.kind==='wire') as any;
 assert.deepEqual(end,live.record.content.data.ev);
 console.log('OpenCode stored state matches live tool outcome',state.status,state.output?.length??'error object');
}
// User mirroring is now session-owned, and fresh replay has exactly one row.
const history={threadRead:async()=>({thread:{turns:[{id:'turn',status:'completed',items:[{id:'user',type:'userMessage',clientId:'external-client',content:[{type:'text',text:'TUI prompt'}]},{id:'answer',type:'agentMessage',text:'answer'}]}]}})};
{
 const s=codex({id:'c0dec211',freshCard:true}),rs=relay();s.attachRelay(rs as any);s.__setup({});await s.__replay(history);
 assert.equal(rs.rows.filter((r:any)=>r.record.role==='user').length,1);
 assert.equal(rs.rows[0].record.role,'user');console.log('fresh-card history: one user row, before turn start');
}
{
 const s=codex({id:'c0dec212'}),rs=relay();s.attachRelay(rs as any);s.__setup({});
 s.__event({method:'turn/started',params:{threadId:'thread',turn:{id:'turn'}}});
 s.__event({method:'item/completed',params:{threadId:'thread',turnId:'turn',item:{id:'user',type:'userMessage',clientId:'external-client',text:'TUI prompt'}}});
 assert.equal(rs.rows.filter((r:any)=>r.record.role==='user').length,1);
 assert.equal(event(rs.rows[0]).t,'turn-start');assert.equal(rs.rows[1].record.role,'user');
 console.log('external clientId now mirrored live, but user row still follows turn-start');
}
{
 const s=codex({id:'c0dec213',freshCard:false}),rs=relay();s.attachRelay(rs as any);s.__setup({});await s.__replay(history);
 assert.equal(rs.rows.filter((r:any)=>r.record.role==='user').length,0);
 assert.ok(rs.rows.some((r:any)=>event(r)?.t==='text'));
 console.log('ordinary recovery history: missed TUI prompt suppressed while its answer is replayed');
}
{
 const {saveCodexInbound}=await import(root+'/codex/codexInboundStore.ts');
 const id='c0dec214',clientId='rpc-uuid-from-before-restart';
 saveCodexInbound(id,[{clientId,text:'Joy RPC prompt',state:'sentUnknown',at:1}]);
 const s=codex({id,codexThreadId:'thread'}),rs=relay();s.attachRelay(rs as any);s.__setup({});
 const item={id:'user',type:'userMessage',clientId,text:'Joy RPC prompt'};
 await s.__replay({threadRead:async()=>({thread:{turns:[{id:'turn',status:'inProgress',items:[item]}]}})});
 assert.equal(s.queueItemState(clientId),'delivered');assert.equal(rs.rows.filter((r:any)=>r.record.role==='user').length,0);
 s.__event({method:'item/completed',params:{threadId:'thread',turnId:'turn',item}});
 assert.equal(rs.rows.filter((r:any)=>r.record.role==='user').length,1);
 console.log('recovery confirms/removes own RPC spool item; buffered echo then misclassified external and mirrored again');
}
console.log('PASS: actual replay and live paths with client/history fixtures.');process.exit(0);
