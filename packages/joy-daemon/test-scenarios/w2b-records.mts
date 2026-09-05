import assert from 'node:assert/strict';
import {root,codex,opencode,relay} from './wave2b-astra-helpers.mts';
const {CodexNormalizer}=await import(root+'/codex/normalize.ts');
const {OpencodeNormalizer}=await import(root+'/opencode/normalize.ts');
function toolEnd(e:any[]){return e.find(e=>e.kind==='wire'&&e.record.content?.data?.ev?.t==='tool-call-end')?.record.content.data.ev}
for(const item of [
 {type:'commandExecution',id:'cmd',aggregatedOutput:'permission denied',exitCode:1,status:'completed'},
 {type:'mcpToolCall',id:'mcp',error:{message:'failure'},status:'failed'},
]){
 const n=new CodexNormalizer();n.setThreadId('thread');
 const ev=toolEnd(n.handle({method:'item/completed',params:{turnId:'turn',item}}));
 assert.ok(ev?.result);assert.equal(ev.isError,true);console.log('Codex tool completion preserved',item.type);
}
const oc=new OpencodeNormalizer('oc-session');oc.setTurn('turn');
assert.deepEqual(toolEnd(oc.handle({type:'session.next.tool.error',data:{callID:'call',assistantMessageID:'assistant',error:'denied'}})),{t:'tool-call-end',call:'assistant:call',result:'denied',isError:true});
console.log('OpenCode live error result preserved');
const s=opencode(),rs=relay();s.attachRelay(rs as any);
s.__setup({messages:async()=>[
 {type:'user',id:'user',time:{created:1}},
 {type:'assistant',id:'assistant',time:{created:2},finish:'stop',content:[{type:'tool',id:'call',input:{command:'false'},output:'denied',error:'denied',status:'error'}]},
]});
await s.__replay();
const replayEnd=rs.rows.find((x:any)=>x.record.content?.data?.ev?.t==='tool-call-end').record.content.data.ev;
assert.equal(replayEnd.result,undefined);assert.equal(replayEnd.isError,undefined);
console.log('OpenCode replay still drops tool result/error:',JSON.stringify(replayEnd));
// The actual fresh-card reconciliation already emits user rows outside the
// bracket; the new normalizer adds another id for the same TUI prompt inside it.
const cs=codex({id:'c0dec002',freshCard:true}),cr=relay();cs.attachRelay(cr as any);cs.__setup({});
await cs.__replay({threadRead:async()=>({thread:{turns:[{id:'turn',status:'completed',items:[{id:'item-0',type:'userMessage',content:[{type:'text',text:'typed in TUI'}]},{id:'item-1',type:'agentMessage',text:'answer'}]}]}})});
const userRows=cr.rows.filter((r:any)=>r.record.role==='user');assert.equal(userRows.length,2);assert.notEqual(userRows[0].localId,userRows[1].localId);
console.log('fresh-card replay duplicate TUI prompt ids:',JSON.stringify(userRows.map((r:any)=>r.localId)));
const n=new CodexNormalizer();n.setThreadId('thread');
const user={type:'userMessage',id:'external',clientId:'another-client-id',content:[{type:'text',text:'another client prompt'}]};
assert.equal(n.handle({method:'item/completed',params:{turnId:'turn',item:user}}).length,0);
console.log('non-Joy external clientId prompt still suppressed');
console.log('PASS: actual normalizers and copied adapters with private replay hooks only.');
process.exit(0);
