import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';
const checkout='/tmp/joy-test-tmux/review3/wave3c-app-astra-checkout';
const root=checkout+'/packages/joy-app';
const require=createRequire(root+'/package.json');const ts=require('typescript');
const {createCore}=await import(checkout+'/packages/joy-relay/src/core.mjs');
function sf(path:string){return ts.createSourceFile(path,readFileSync(root+'/sources/'+path,'utf8'),ts.ScriptTarget.Latest,true,path.endsWith('.tsx')?ts.ScriptKind.TSX:ts.ScriptKind.TS)}
function extract(path:string,pred:(n:any,s:any)=>boolean,select:(n:any)=>any=(n:any)=>n){const source=sf(path);let out:any;function visit(n:any){if(!out&&pred(n,source))out=select(n);ts.forEachChild(n,visit)}visit(source);assert.ok(out,path);return out.getText(source)}
function evaluate(code:string,env:any){return vm.runInNewContext(ts.transpileModule('var tested = '+code+'; tested;', {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React}}).outputText,env)}
const tick=()=>new Promise(r=>setTimeout(r,0));
const gate=()=>{let resolve!:(x:any)=>void;return {promise:new Promise(r=>resolve=r),resolve:(x:any)=>resolve(x)}};
const alerts:any[]=[];const common={console:{error(){}},Modal:{alert:(...a:any[])=>alerts.push(a)},t:(s:string)=>s,randomUUID:(()=>{let n=1;return()=>`uuid-${n++}`})()};
// Real relay acceptPrompt + idempotency guard; only its SQL storage boundary is in memory.
function relay(){let seq=0;const commands:any[]=[];const t={async query(sql:string,p:any[]){
 if(sql.startsWith('SELECT * FROM native_sessions'))return {rows:[{id:'s',account_id:'a',state:'active',owner_daemon_id:'d'}]};
 if(sql.startsWith('SELECT * FROM commands'))return {rows:commands.filter(c=>c.session_id===p[0]&&c.producer_actor_id===p[1]&&c.client_intent_id===p[2])};
 if(sql.startsWith('SELECT count(*)::int AS count FROM turns'))return {rows:[{count:commands.length}]};
 if(sql.startsWith('UPDATE native_sessions SET next_seq'))return {rows:[{seq:++seq,revision:seq}]};
 if(sql.includes('INSERT INTO commands')){commands.push({id:p[0],session_id:p[1],seq:p[2],event_id:p[3],producer_actor_id:p[4],client_intent_id:p[5],request_hash:p[6],ciphertext:p[7],turn_id:p[8],disposition:'queued'});return {rows:[]}};
 if(sql.includes('INSERT INTO session_events')||sql.includes('INSERT INTO turns'))return {rows:[]};
 throw new Error('Unexpected SQL '+sql);
 }};const core=createCore({tx:(fn:any)=>fn(t)},{wakeDaemon(){},pokeAccount(){}});
 return {commands,accept:(text:string,opts:any)=>core.acceptPrompt('a','actor','s',{clientIntentId:opts.localId,ciphertext:JSON.stringify({text,attachments:opts.attachments??[]})})};
}
const sendCode=extract('-session/SessionView.tsx',(n,s)=>ts.isVariableDeclaration(n)&&n.name.getText(s)==='handleSend',n=>n.initializer.arguments[0]);
const restoreCode=extract('-session/SessionView.tsx',(n,s)=>ts.isPropertyAssignment(n)&&n.name.getText(s)==='restoreMessage',n=>n.initializer);
const clearCode=extract('-session/SessionView.tsx',(n,s)=>ts.isPropertyAssignment(n)&&n.name.getText(s)==='clearMessage',n=>n.initializer);
function composer(){let text='';const sends:any[]=[],drafts:any[]=[];const r=relay();
 const env:any={...common,sessionId:'s',selectedImages:[],isJoyDaemon:true,IMMEDIATE_COMMANDS:new Set(),isFresh:()=>true,storage:{getState:()=>({sessions:{s:{thinking:false}}})},compositionIdRef:{current:'composition-A'},clearImages(){env.selectedImages=[]},addImages(a:any[]){env.selectedImages.push(...a)},releaseAttachmentUris(){},useDraftQueueStore:{getState:()=>({add:(...a:any[])=>drafts.push(a)})},sync:{sendMessage(s:string,text:string,opts:any){const g=gate();const accepted=r.accept(text,opts);sends.push({s,text,opts,g,accepted});return g.promise}},inputHandleRef:{current:{getText:()=>text,setTextAndSelection:(s:string)=>text=s}},setMessage(){},clearDraft(){}};
 env.composerHandleRef={current:{getMessage:()=>text,clearMessage:evaluate(clearCode,env),restoreMessage:evaluate(restoreCode,env)}};
 return {env,sends,drafts,r,send:evaluate(sendCode,env),set:(s:string)=>text=s,get:()=>text};
}
async function settle(c:any,i:number,ok:boolean){await c.sends[i].accepted;c.sends[i].g.resolve(ok?{ok:true}:{ok:false,reason:'lost ack'});await tick()}
if(process.argv[2]!=='draft'){
 {const c=composer();c.set('A');c.send();c.set('B');c.send();assert.notEqual(c.sends[0].opts.localId,c.sends[1].opts.localId);await settle(c,0,true);await settle(c,1,true);assert.equal(c.r.commands.length,2);console.log('PASS independent in-flight A/B receive different keys and both are accepted')}
 {const c=composer();c.set('A');c.send();await settle(c,0,false);c.send();await settle(c,1,true);assert.equal(c.sends[0].opts.localId,c.sends[1].opts.localId);assert.equal(c.r.commands.length,1);console.log('PASS unchanged text retry reuses the key and relay replays one command')}
 {const c=composer();c.env.selectedImages=[{uri:'blob:original',name:'image.png'}];c.send();await settle(c,0,false);assert.equal(c.env.selectedImages.length,1);c.send();await settle(c,1,true);assert.notEqual(c.sends[0].opts.localId,c.sends[1].opts.localId);assert.equal(c.r.commands.length,2);assert.equal(c.r.commands[0].ciphertext,c.r.commands[1].ciphertext);console.log('BUG attachment-only lost-ack retry rotates the key and relay accepts the same payload twice')}
 {const c=composer();c.set('A');c.send();c.set('new unsent B');await settle(c,0,false);assert.equal(c.get(),'A\n\nnew unsent B');c.send();await settle(c,1,true);assert.equal(c.r.commands.length,1);assert.equal(JSON.parse(c.r.commands[0].ciphertext).text,'A');assert.equal(c.get(),'');console.log('BUG A failure merges new unsent B under A key; resend replays A and clears B without delivery')}
 {const c=composer();c.set('A');c.send();await settle(c,0,false);c.set('edited B');c.send();await settle(c,1,true);assert.equal(c.r.commands.length,1);assert.equal(JSON.parse(c.r.commands[0].ciphertext).text,'A');assert.equal(c.get(),'');console.log('BUG edited restored text still uses accepted original key; B disappears on replay acknowledgement')}
}
if(process.argv[2]!=='composer'){
 let st:any;const create=(fn:any)=>{const use=(sel:any)=>sel(st);use.getState=()=>st;st=fn((v:any)=>{st={...st,...(typeof v==='function'?v(st):v)}},()=>st);return use};
 const env:any={exports:{},require:(name:string)=>name==='zustand'?{create}:{relayScopedMMKV:()=>({getString:()=>undefined,set(){}})},setTimeout,clearTimeout,Date,Math};
 vm.runInNewContext(ts.transpileModule(readFileSync(root+'/sources/-session/draftQueue.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,env);
 const store=env.exports.useDraftQueueStore;const sends:any[]=[];const r=relay();
 const componentEnv:any={...common,exports:{},require:(name:string)=>name==='react'?{memo:(f:any)=>f,useMemo:(f:any)=>f(),createElement:(_t:any,p:any)=>p}:name==='./draftQueue'?{...env.exports,useDrafts:(s:string)=>store.getState().bySession[s]??[]}:name==='./QueueStack'?{QueueStack:'queue'}:name==='@/sync/sync'?{sync:{sendMessage(s:string,text:string,opts:any){const g=gate();const accepted=r.accept(text,opts);sends.push({s,text,opts,g,accepted});return g.promise}}}:name==='@/modal'?{Modal:common.Modal}:{t:common.t}};
 vm.runInNewContext(ts.transpileModule(readFileSync(root+'/sources/-session/DraftQueueStrip.tsx','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React}}).outputText,componentEnv);
 const rows=()=>componentEnv.exports.DraftQueueStrip({sessionId:'s'}).rows;
 store.getState().add('s','A');const id=store.getState().bySession.s[0].id;rows()[0].onSend();store.getState().update('s',id,'B');await settle({sends},0,true);assert.equal(rows()[0].text,'B');console.log('PASS edited draft B survives late acknowledgement of A');
 rows()[0].onSend();await settle({sends},1,true);assert.equal(sends[0].opts.localId,sends[1].opts.localId);assert.equal(r.commands.length,1);assert.equal(JSON.parse(r.commands[0].ciphertext).text,'A');assert.equal(rows().length,0);console.log('BUG sending preserved B reuses A key: real relay replays A, and B is removed without being accepted');
 store.getState().add('s','C');rows()[0].onSend();await settle({sends},2,false);assert.equal(rows()[0].text,'C');assert.equal(store.getState().bySession.s[0].lastError,'lost ack');assert.equal(rows()[0].error,undefined);rows()[0].onSend();await settle({sends},3,true);assert.equal(r.commands.length,2);assert.equal(rows().length,0);console.log('PASS unchanged failed draft retries once; BUG stored error still omitted from row model');
}
console.log('Completed pinned 62833e10 callbacks, composer handle, draft store/row component and relay acceptance; UI and SQL boundaries controlled.');
