import {mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
export const root=process.env.JOY_REVIEW_SRC ?? '/tmp/joy-test-tmux/review3/wave2d-astra-checkout/packages/joy-daemon/src';
export const dir=mkdtempSync('/tmp/joy-test-tmux/review3/wave2b-astra-');
process.env.JOY_HOME_DIR=dir;
export const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
export async function until(fn:()=>boolean){for(let i=0;i<600&&!fn();i++)await sleep(5);if(!fn())throw new Error('condition not reached')}
export const deps={relayClient:null,broadcast(){},addChatMessage(){}};
export const calls:any[]=[];
export const driver={untrack(){},runSync:()=>({ok:true,out:''}),captureCached:()=>({ok:false,out:''}),captureFresh:async()=>({ok:false,out:''}),command:async(...args:any[])=>{calls.push(['command',...args]);return {ok:true,out:''}},key:async(...args:any[])=>{calls.push(['keys',...args]);return {ok:true,out:''}},literal:async(...args:any[])=>{calls.push(['literal',...args]);return {ok:true,out:''}}};
export function relay(){
 const rows:any[]=[];
 const rs=new Proxy({relaySessionId:'test-relay',metadataSnapshot:{},outboundPersistDegraded:false,rows,send(record:any,localId?:string){rows.push({record,localId})}}, {get(t,k){return k in t?Reflect.get(t,k):()=>Promise.resolve(true)}});
 return rs;
}
function copy(file:string,hook:string){
 const source=root+'/'+file;
 const name=file.startsWith('codex')?'CodexSession':'OpencodeSession';
 let code=readFileSync(source,'utf8').replace('export class '+name+' implements AgentSession {','export class '+name+' implements AgentSession {\n'+hook+'\n');
 if(!code.includes(hook))throw new Error('hook insertion failed');
 code=code.replace(/(from\s+["'])(\.[^"']+)(["'])/g,(_,a,p,b)=>a+resolve(dirname(source),p)+b);
 const path=dir+'/'+name+'.mts';writeFileSync(path,code);return path;
}
const codexPath=copy('codex/codexSession.ts',`
 __setup(c:any,thread='thread'){this.#client=c;this.#threadId=thread;this.#norm.setThreadId(thread);this.#buffering=false;}
 __event(n:any){this.#onNotification(n);}
 __replay(c:any){return this.#reconcileHistoryInner(c);}
 __busyTurn(turn:string|null){this.#activeTurnId=turn;this.#thinking=!!turn;}
`);
const ocPath=copy('opencode/opencodeSession.ts',`
 __setup(c:any,sid='oc-session'){this.#client=c;this.#ocSessionId=sid;this.#norm=new OpencodeNormalizer(sid);}
 __event(n:any){this.#applyEffects(this.#norm!.handle(n));}
 __replay(){return this.#reconcileHistory();}
 __drain(){return this.#drainInbound();}
`);
export const {CodexSession}=await import(codexPath);
export const {OpencodeSession}=await import(ocPath);
export function codex(props:any={}){return new CodexSession({id:'c0dec001',cwd:dir,tmuxWindow:'test',tmux:driver,flags:[],status:'active',startedAt:0,...props},deps)}
export function opencode(props:any={}){return new OpencodeSession({id:'0c0dec01',cwd:dir,status:'active',startedAt:0,...props},deps)}
