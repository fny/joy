import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';import {createRequire} from 'node:module';import vm from 'node:vm';
const root='/tmp/joy-test-tmux/review3/wave3-app-astra-checkout/packages/joy-app';
const require=createRequire(root+'/package.json');const ts=require('typescript');
function sf(path:string){return ts.createSourceFile(path,readFileSync(root+'/sources/'+path,'utf8'),ts.ScriptTarget.Latest,true,path.endsWith('.tsx')?ts.ScriptKind.TSX:ts.ScriptKind.TS)}
function find(path:string,pred:(n:any)=>boolean){const source=sf(path);let out:any;function visit(n:any){if(!out&&pred(n))out=n;ts.forEachChild(n,visit)}visit(source);assert.ok(out,path);return out.getText(source)}
function callback(path:string,name:string){const source=sf(path);let out:any;function visit(n:any){if(ts.isVariableDeclaration(n)&&n.name.getText(source)===name)out=n.initializer.arguments[0];ts.forEachChild(n,visit)}visit(source);assert.ok(out,name);return out.getText(source)}
function evaluate(code:string,env:any){return vm.runInNewContext(ts.transpileModule('var tested = '+code+'; tested;', {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React}}).outputText,env)}
const tick=()=>new Promise(r=>setTimeout(r,0));const gate=()=>{let resolve!:(x:any)=>void;return {promise:new Promise(r=>resolve=r),resolve:(x:any)=>resolve(x)}};
const alerts:any[]=[];const common={console:{error(){}},Modal:{alert:(...a:any[])=>alerts.push(a)},t:(s:string)=>s,randomUUID:(()=>{let n=1;return()=>`uuid-${n++}`})()};
const sendCode=callback('-session/SessionView.tsx','handleSend');
function composer(){let text='';const sends:any[]=[],drafts:any[]=[];const env:any={...common,sessionId:'s',selectedImages:[],isJoyDaemon:true,IMMEDIATE_COMMANDS:new Set(),isFresh:()=>true,storage:{getState:()=>({sessions:{s:{thinking:false}}})},compositionIdRef:{current:'composition-A'},clearImages(){env.selectedImages=[]},addImages(a:any[]){env.selectedImages.push(...a)},releaseAttachmentUris(){},useDraftQueueStore:{getState:()=>({add:(...a:any[])=>drafts.push(a)})},sync:{sendMessage(s:string,text:string,opts:any){const g=gate();sends.push({s,text,opts,g});return g.promise}},composerHandleRef:{current:{getMessage:()=>text,clearMessage:()=>{text=''},restoreMessage:(s:string)=>{text=text.trim()?s+'\n\n'+text:s}}}};return {env,sends,drafts,send:evaluate(sendCode,env),set:(s:string)=>{text=s},get:()=>text}}
{
 const c=composer();c.set('first');c.send();c.sends[0].g.resolve({ok:false,reason:'lost ack'});await tick();c.send();assert.equal(c.sends[0].opts.localId,c.sends[1].opts.localId);c.sends[1].g.resolve({ok:true});await tick();console.log('PASS unchanged in-place retry keeps identity');
}
{
 const c=composer();c.set('first');c.send();c.set('second');c.send();assert.equal(c.sends[0].opts.localId,c.sends[1].opts.localId);console.log('BUG two distinct compositions while first POST is pending share localId:',c.sends.map(s=>[s.text,s.opts.localId]));c.sends.forEach(s=>s.g.resolve({ok:true}));await tick();
}
{
 const c=composer();c.set('accepted original');c.send();c.sends[0].g.resolve({ok:false,reason:'lost ack'});await tick();c.set('edited replacement');c.send();assert.equal(c.sends[0].opts.localId,c.sends[1].opts.localId);console.log('BUG edit after a lost ack reuses accepted original identity; relay replays old acceptance');c.sends[1].g.resolve({ok:true});await tick();assert.equal(c.get(),'');
}
{
 const c=composer();c.env.selectedImages=[{uri:'blob:only-copy',name:'image.png'}];c.set('with image');c.send();c.env.composerHandleRef.current=null;c.sends[0].g.resolve({ok:false,reason:'lost ack'});await tick();assert.deepEqual(c.drafts,[['s','with image','draft']]);assert.equal(c.env.selectedImages.length,0);console.log('BUG unmounted failure saves only text/reason, no attachment or original localId:',c.drafts);
 const d=composer();d.env.selectedImages=[{uri:'blob:only-copy',name:'image.png'}];d.send();d.env.composerHandleRef.current=null;d.sends[0].g.resolve({ok:false,reason:'upload refused'});await tick();assert.equal(d.drafts.length,0);console.log('BUG unmounted attachment-only failure saves no draft');
}
// Execute the actual effect with controlled request settlement and explicit React effect cleanups.
{
 const effectCode=find('components/AllFilesDiffView.tsx',(n:any)=>ts.isCallExpression(n)&&n.expression.getText()==='React.useEffect'&&n.arguments[0].getText().includes('const toFetch =')).replace(/^React\.useEffect\(/,'');
 const source=sf('components/AllFilesDiffView.tsx');let arrow:any;function visit(n:any){if(ts.isCallExpression(n)&&n.expression.getText()==='React.useEffect'&&n.arguments[0].getText().includes('const toFetch ='))arrow=n.arguments[0];ts.forEachChild(n,visit)}visit(source);
 const f=(name:string,lines=1)=>({fullPath:name,status:'modified',isStaged:false,linesAdded:lines,linesRemoved:0});const pending:any[]=[];
 const env:any={...common,sessionId:'s',files:[f('A'),f('B')],resultsMap:new Map(),fetchedSignatures:{current:new Map()},inFlight:{current:new Set()},hasLoadedOnce:false,fileSignature:(f:any)=>`${f.status}|${f.isStaged?1:0}|${f.linesAdded}|${f.linesRemoved}`,setResultsMap(v:any){env.resultsMap=typeof v==='function'?v(env.resultsMap):v},setHasLoadedOnce(v:any){env.hasLoadedOnce=v},storage:{getState:()=>({sessions:{s:{metadata:{path:'/repo'}}}})},resolveSessionFilePath:(p:string)=>({withinSessionRoot:true,relativePath:p,absolutePath:'/repo/'+p}),isImagePath:()=>false,isBinaryPath:()=>false,sessionGitDiff(_s:string,o:any){const g=gate();pending.push({...o,g});return g.promise}};
 const effect=evaluate(arrow.getText(source),env);const cleanup=effect();cleanup();env.files=[f('A',2),f('B')];effect();assert.equal(pending.length,2);pending.forEach(p=>p.g.resolve({success:true,diff:'patch'}));await tick();assert.equal(env.resultsMap.size,0);assert.equal(env.inFlight.current.size,0);
 env.files=[f('A',2),f('B')];effect();assert.equal(pending.length,3);assert.equal(pending[2].path,'A');pending[2].g.resolve({success:true,diff:'fresh A'});await tick();assert.ok(!env.resultsMap.has('B'));console.log('BUG #91 B never refetches: cancelled signature remains; no results after cancellation and even another effect run restores A only');
}
// Actual draft store with an in-memory MMKV boundary; actual row factory through React stubs.
{
 let st:any;const create=(fn:any)=>{const use=(sel:any)=>sel(st);use.getState=()=>st;st=fn((v:any)=>{st={...st,...(typeof v==='function'?v(st):v)}},()=>st);return use};
 const env:any={exports:{},require:(name:string)=>name==='zustand'?{create}:{relayScopedMMKV:()=>({getString:()=>undefined,set(){}})},setTimeout,clearTimeout,Date,Math};vm.runInNewContext(ts.transpileModule(readFileSync(root+'/sources/-session/draftQueue.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,env);
 const store=env.exports.useDraftQueueStore;store.getState().add('s','original');const id=store.getState().bySession.s[0].id;const sends:any[]=[];
 const componentEnv:any={...common,exports:{},require:(name:string)=>name==='react'?{memo:(f:any)=>f,useMemo:(f:any)=>f(),createElement:(_t:any,p:any)=>p}:name==='./draftQueue'?{...env.exports,useDrafts:(s:string)=>store.getState().bySession[s]}:name==='./QueueStack'?{QueueStack:'queue'}:name==='@/sync/sync'?{sync:{sendMessage(s:string,text:string,opts:any){const g=gate();sends.push({s,text,opts,g});return g.promise}}}:name==='@/modal'?{Modal:common.Modal}:{t:common.t}};
 vm.runInNewContext(ts.transpileModule(readFileSync(root+'/sources/-session/DraftQueueStrip.tsx','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React}}).outputText,componentEnv);
 const render=()=>componentEnv.exports.DraftQueueStrip({sessionId:'s'}).rows[0];render().onSend();sends[0].g.resolve({ok:false,reason:'lost ack'});await tick();assert.equal(store.getState().bySession.s.length,1);assert.equal(store.getState().bySession.s[0].lastError,'lost ack');assert.equal(render().error,undefined);console.log('PASS draft survives rejection; BUG row omits recorded error');
 store.getState().update('s',id,'edited after failure');render().onSend();assert.equal(sends[0].opts.localId,sends[1].opts.localId);store.getState().update('s',id,'new text while send pending');sends[1].g.resolve({ok:true});await tick();assert.equal(store.getState().bySession.s.length,0);console.log('BUG manual draft retry after edit reuses ID, and late success deletes an edited draft');
}
// Stop returns its promise, but the op wrapper ignores missing/non-JSON daemon errors.
{
 const code=find('sync/ops.ts',(n:any)=>ts.isFunctionDeclaration(n)&&n.name?.text==='sessionAbort').replace(/^export /,'');let calls=0;
 const env:any={...common,storage:{getState:()=>({sessions:{s:{metadata:{v2:{sessionId:'remote',relay:'r'}}}}})},v2ActiveTurn:async()=>null,v2CancelTurn:async()=>{},sync:{machineCtx:()=>({})},machineAbort:async()=>{calls++;return {status:500,data:null}},noCtx:()=>new Error('no ctx')};const fn=evaluate(code,env);await fn('s');assert.equal(calls,1);console.log('BUG abort resolves successfully for daemon HTTP 500 with no JSON body');
 let finish=gate();env.machineAbort=()=>finish.promise;const handling=evaluate(callback('-session/SessionView.tsx','handleAbort'),{...env,sessionId:'s',sessionAbort:fn,storage:{getState:()=>({resetSessionAgentOverrides(){}})}});let settled=false;const p=handling().then(()=>{settled=true});await tick();assert.equal(settled,false);finish.resolve({status:200,data:{ok:true}});await p;console.log('PASS handleAbort remains pending until request resolves');
}
console.log('PASS harness completed; actual extracted callbacks/effect, actual draft store/row component; external boundaries controlled.');

{
 const code=callback('components/tools/views/AskUserQuestionView.tsx','handleSubmit');let submitted=false;let sends:any[]=[];
 const env:any={...common,sessionId:'s',allQuestionsAnswered:true,isSubmitting:false,tool:{state:'running'},questions:[{question:'Which?',options:[{label:'A'},{label:'B'}]}],selections:new Map([[0,new Set([1])]]),setIsSubmitted:(v:boolean)=>submitted=v,setIsSubmitting(){},sessionAllow:()=>{throw new Error('unexpected approval')},sync:{sendMessage:async(...args:any[])=>{sends.push(args);return {ok:true}}}};
 await evaluate(code,env)();assert.equal(submitted,true);assert.equal(sends[0][1],'B');assert.equal(sends[0][2].source,'option');console.log('AskUserQuestion no permission ID sends a new ordinary message and marks submitted on relay acceptance');
 env.sync.sendMessage=async()=>({ok:false,reason:'offline'});await evaluate(code,env)();assert.equal(submitted,false);console.log('PASS AskUserQuestion form restored on rejected send');
}
{
 const {mkdtempSync,writeFileSync,mkdirSync}=await import('node:fs');const {execFileSync}=await import('node:child_process');const cwd=mkdtempSync('/tmp/joy-test-tmux/review3/wave3-app-git-');
 const git=(args:string[])=>execFileSync('git',args,{cwd,encoding:'utf8'});git(['init','-q','-b','main']);git(['config','user.email','review@example.invalid']);git(['config','user.name','review']);mkdirSync(cwd+'/src');writeFileSync(cwd+'/src/old.txt',Array.from({length:20},(_,i)=>`line ${i}`).join('\n')+'\n');git(['add','.']);git(['commit','-qm','init']);git(['mv','src/old.txt','src/new.txt']);writeFileSync(cwd+'/src/new.txt',Array.from({length:20},(_,i)=>`line ${i}`).join('\n')+'\nadded\n');git(['add','.']);
 const parser=await import(root+'/sources/sync/git-parsers/parseStatusV2.ts');const diff=await import(root+'/sources/sync/git-parsers/parseDiff.ts');const old=await import(root+'/sources/sync/git-parsers/parseStatus.ts');
 const result=parser.parseStatusSummaryV2(git(['status','--porcelain=v2']));assert.equal(result.files[0].path,'src/new.txt');assert.equal(result.files[0].from,'src/old.txt');console.log('PASS actual git rename parses new path and original path correctly');
 const num=git(['diff','--cached','--numstat']);const map=diff.createDiffStatsMap(diff.parseNumStat(num));assert.equal(map['src/new.txt'],undefined);console.log('Remaining rename numstat key:',Object.keys(map),'raw:',num.trim());const legacy=old.parseStatusSummary(git(['status','--porcelain']));assert.equal(legacy.files[0].from,undefined);console.log('Remaining legacy parser rename path:',legacy.files[0].path);
}
