import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {createRequire} from 'node:module';import vm from 'node:vm';
const root='/tmp/joy-test-tmux/review3/wave3b-app-astra-checkout/packages/joy-app';const require=createRequire(root+'/package.json');const ts=require('typescript');
function source(path:string){return ts.createSourceFile(path,readFileSync(root+'/sources/'+path,'utf8'),ts.ScriptTarget.Latest,true,path.endsWith('.tsx')?ts.ScriptKind.TSX:ts.ScriptKind.TS)}
function findNode(path:string,pred:(n:any)=>boolean){const src=source(path);let out:any;function visit(n:any){if(!out&&pred(n))out=n;ts.forEachChild(n,visit)}visit(src);assert.ok(out,path);return out}
function callback(path:string,name:string){const n=findNode(path,n=>ts.isVariableDeclaration(n)&&n.name.getText()===name);return n.initializer.arguments[0].getText()}
function evaluate(code:string,env:any){return vm.runInNewContext(ts.transpileModule('var tested = '+code+'; tested;',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React}}).outputText,env)}
function module(path:string,imports:any,globals:any={}){const env={exports:{},require:(name:string)=>name in imports?imports[name]:require(name),console:{log(){},error(){}},setTimeout,clearTimeout,setInterval,clearInterval,TextEncoder,TextDecoder,atob,btoa,...globals};vm.runInNewContext(ts.transpileModule(readFileSync(root+'/sources/'+path,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React,esModuleInterop:true}}).outputText,env);return env.exports as any}
const alerts:any[]=[];const common={console:{error(){}},Modal:{alert:(...a:any[])=>alerts.push(a)},t:(s:string)=>s};
// Navigation helper: actual UTF-8 and legacy byte encodings.
{
 const base64=module('encryption/base64.ts',{});const paths=module('utils/pathParam.ts',{'@/encryption/base64':base64});
 for(const path of ['plain.txt','中文/🦊.txt','résumé.md'])assert.equal(paths.decodePathParam(paths.encodePathParam(path)),path);
 assert.notEqual(paths.decodePathParam(btoa('résumé.md')),'résumé.md');console.log('BUG old Latin-1 btoa link now decodes as:',paths.decodePathParam(btoa('résumé.md')));
 const group=readFileSync(root+'/sources/components/ToolGroupView.tsx','utf8');assert.ok(group.includes('btoa(filePath)'));assert.throws(()=>btoa('中文.txt'));console.log('BUG grouped-tool handlers still use btoa; CJK path throws');
}
// Actual autocomplete cache with controlled file listing, actual Fuse and lock.
{
 const lock=module('utils/lock.ts',{});let files=['src/a.ts'],now=Date.now();const clock={now:()=>now};const m=module('sync/suggestionFile.ts',{'@/sync/v2/machine':{machineGitEntries:async()=>({status:200,data:{ok:true,files}})},'@/sync/sync':{sync:{awaitMachineCtx:async()=>({})}},'@/utils/lock':lock},{Date:clock});
 assert.equal((await m.searchFiles('s','a.ts'))[0].fullPath,'src/a.ts');now+=301000;files=[];const stale=await m.searchFiles('s','');assert.ok(stale.some((x:any)=>x.fullPath==='src/a.ts'));console.log('BUG successful empty listing keeps deleted files in autocomplete');
 files=['two\nlines.txt'];m.fileSearchCache.clearCache();const split=await m.searchFiles('s','');assert.equal(split.length,2);assert.ok(!split.some((x:any)=>x.fullPath==='two\nlines.txt'));console.log('BUG one newline-containing filename becomes two autocomplete entries');
}
// Actual catalog/history callbacks.
{
 const path='app/(app)/joy/new/index.tsx';const status:any={};const env:any={...common,ocPastOpen:false,ccPastOpen:false,selectedMachineId:'machine',pathInput:'/repo',selectedMachine:{metadata:{homeDir:'/home'}},resolveAbsolutePath:(p:string)=>p,trimPathInput:(p:string)=>p,sync:{machineOnlyCtx:()=>null},setOcPastOpen:(v:any)=>status.ocOpen=v,setCcPastOpen:(v:any)=>status.ccOpen=v,setOcPastLoading:(v:any)=>status.ocLoading=v,setCcPastLoading:(v:any)=>status.ccLoading=v};
 evaluate(callback(path,'toggleOcPast'),env)();evaluate(callback(path,'toggleCcPast'),env)();assert.equal(status.ocLoading,true);assert.equal(status.ccLoading,true);console.log('BUG both past-session pickers keep loading=true when machine context is missing');
}
// Real empty-file load effect and binary download callback, external storage/file APIs controlled.
{
 const path='app/(app)/session/[id]/file.tsx';const n=findNode(path,n=>ts.isCallExpression(n)&&n.expression.getText()==='React.useEffect'&&n.arguments[0].getText().includes('const loadFile ='));let error:any,content:any;
 const env:any={...common,sessionId:'s',sessionPath:'/repo',gitDiffPath:'',filePath:'empty.txt',cached:null,isDemoSession:()=>false,storage:{getState:()=>({sessions:{s:{}},applyFileCache(){}})},setIsLoading(){},setError:(e:any)=>error=e,setFileContent:(c:any)=>content=c,setImageBase64(){},isBinaryFile:(p:string)=>p.endsWith('.png'),isRasterImagePath:(p:string)=>p.endsWith('.png'),sessionReadFile:async()=>({success:true,content:''}),decodeBase64ToBytes:()=>new Uint8Array(),decodeUtf8Bytes:()=>'',setDiffContent(){}};
 evaluate(n.arguments[0].getText(),env)();await new Promise(r=>setTimeout(r,0));assert.equal(error,null);assert.equal(content.content,'');assert.equal(content.isBinary,false);console.log('PASS empty text file loads');
 env.filePath='empty.png';error=null;evaluate(n.arguments[0].getText(),env)();await new Promise(r=>setTimeout(r,0));assert.equal(error,'Failed to read file');console.log('BUG zero-byte raster still becomes read failure');
 await assert.rejects(evaluate(callback(path,'downloadCurrent'),{...env,imageBase64:null,fileContent:{isBinary:true},fileName:'empty.pdf',downloadFile(){}})(),/read failed/);console.log('BUG zero-byte binary download still rejects successful empty response');
}
// Native script escaping and message validation.
{
 const path='components/markdown/MermaidRenderer.tsx';const initializer=findNode(path,n=>ts.isVariableDeclaration(n)&&n.name.getText()==='mermaidContent').initializer.getText();const payload='</script><script>window.injected=1</script>';const escaped=evaluate(initializer,{props:{content:payload}});assert.ok(!escaped.includes('<'));assert.equal(JSON.parse(escaped),payload);
 const attr=findNode(path,n=>ts.isJsxAttribute(n)&&n.name.getText()==='onMessage');let height=100;const handler=evaluate(attr.initializer.expression.getText(),{setDimensions:(f:any)=>{height=f({height}).height}});for(const msg of ['x','null','[]','{"type":"dimensions","height":"bad"}'])handler({nativeEvent:{data:msg}});assert.equal(height,100);handler({nativeEvent:{data:'{"type":"dimensions","height":240}'}});assert.equal(height,240);handler({nativeEvent:{data:'{"type":"dimensions","height":1e309}'}});assert.equal(height,Infinity);console.log('PASS script breakout/non-JSON cases fixed; residual dimensions accepts Infinity');
}
// Android routes every button to the custom modal; shorter alerts remain cancelable.
{
 const native:any[]=[],custom:any[]=[];const m=module('modal/ModalManager.ts',{'react-native':{Platform:{OS:'android'},Alert:{alert:(...args:any[])=>native.push(args)}},'@/text':{t:(s:string)=>s}});const manager=m.Modal;assert.ok(manager);manager.setFunctions((c:any)=>{custom.push(c);return 'id'},()=>{},()=>{});manager.alert('choices','',Array.from({length:6},(_,i)=>({text:String(i)})));assert.equal(custom[0].buttons.length,6);assert.equal(native.length,0);manager.alert('short','',[{text:'OK'}]);assert.equal(native[0][3].cancelable,true);console.log('PASS Android large button list and cancelable native alert');
}
// Unsupported effort change must not send keys or mutate stored value.
{
 let keys=0,writes=0;const env:any={...common,sessionId:'s',isJoyDaemon:true,storage:{getState:()=>({sessions:{s:{metadata:{flavor:'codex'}}},updateSessionEffortLevel(){writes++}})},sendJoyKeys(){keys++}};evaluate(callback('-session/SessionView.tsx','updateEffortLevel'),env)({key:'high'});assert.equal(keys,0);assert.equal(writes,0);console.log('PASS non-Claude effort refuses without keys/state write');
}
// Real React hook: multiple edits debounce, unmount flushes the latest draft.
{
 const React=require('react'),TestRenderer=require('react-test-renderer');(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;const writes:any[]=[];const sessions:any={s:{draft:'seed'}};const storage={getState:()=>({sessions,updateSessionDraft:(sid:string,draft:string)=>{sessions[sid].draft=draft;writes.push([sid,draft])}})};
 const m=module('hooks/useDraft.ts',{'react':React,'react-native':{AppState:{addEventListener:()=>({remove(){}})}},'@/sync/storage':{storage},'@react-navigation/native':{useIsFocused:()=>true}});const onChange=()=>{};function Host({value}:any){m.useDraft('s',value,onChange,{autoSaveInterval:100});return null}let tree:any;
 await TestRenderer.act(async()=>{tree=TestRenderer.create(React.createElement(Host,{value:'seed'}))});for(const value of ['seed a','seed ab','seed abc'])await TestRenderer.act(async()=>{tree.update(React.createElement(Host,{value}))});assert.equal(writes.length,0);await TestRenderer.act(async()=>{tree.unmount()});assert.deepEqual(writes,[['s','seed abc']]);console.log('PASS actual hook no per-character save; unmount persists latest text');
}
// Real v2 summary method and parser with staged/unstaged and conflict-only status.
{
 const parser=await import(root+'/sources/sync/git-parsers/parseDiff.ts');const n=findNode('sync/gitStatusSync.ts',n=>ts.isMethodDeclaration(n)&&n.name.getText()==='fromV2GitStatus');const fn=evaluate('function '+n.getText().replace(/^private /,''),{parseNumStat:parser.parseNumStat});
 const d=fn({branch:'main',entries:[{path:'a',staged:'M',unstaged:'M'},{path:'b',untracked:true}]},'3\t2\ta','5\t1\ta');assert.equal(d.isDirty,true);assert.equal(d.linesAdded,8);assert.equal(d.linesRemoved,3);assert.equal(d.linesChanged,11);assert.equal(d.stagedLinesAdded,5);assert.equal(d.unstagedLinesRemoved,2);assert.equal(fn({entries:[{path:'conflict',staged:'U',unstaged:'U'}]}).isDirty,true);assert.equal(fn({entries:[]}).isDirty,false);console.log('PASS v2 line totals/per-side fields, clean and conflict-only isDirty');
}
console.log('PASS batch 2 app review harness completed.');
