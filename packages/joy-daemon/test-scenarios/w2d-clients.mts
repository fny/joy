import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync} from 'node:fs';
import {createRequire} from 'node:module';
const root=process.env.JOY_REVIEW_SRC ?? '/tmp/joy-test-tmux/review3/wave2d-astra-checkout/packages/joy-daemon/src';
const dir=mkdtempSync('/tmp/joy-test-tmux/review3/wave2b-astra-clients-');process.env.JOY_HOME_DIR=dir;
const {OpencodeClient}=await import(root+'/opencode/opencodeClient.ts');
const {CodexAppServerClient}=await import(root+'/codex/appServerClient.ts');
const {WebSocketServer}=createRequire(root+'/../package.json')('ws');
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function until(fn:()=>boolean){for(let i=0;i<300&&!fn();i++)await sleep(5);assert.ok(fn())}
const server=createServer((req,res)=>{
 if(req.url==='/complete'){res.end(JSON.stringify({ok:true}));return}
 if(req.url==='/truncated'){
  res.writeHead(200,{'content-type':'application/json','content-length':100});res.write('{"ok":');setTimeout(()=>res.destroy(),15);return;
 }
 res.writeHead(200,{'content-type':'application/json'});res.write('[');
 const t=setInterval(()=>res.write(' '),10);res.on('close',()=>clearInterval(t));
});
await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
const oc=new OpencodeClient((server.address() as any).port);
assert.deepEqual(await oc.request('GET','/complete',undefined,500),{ok:true});
let at=Date.now();await assert.rejects(oc.request('GET','/truncated',undefined,500),/aborted|truncated|response error/);assert.ok(Date.now()-at<450);
at=Date.now();await assert.rejects(oc.request('GET','/drip',undefined,100),/exceeded|timed out/);assert.ok(Date.now()-at<450);
assert.deepEqual(await oc.request('GET','/complete',undefined,500),{ok:true});
server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));
console.log('OpenCode HTTP: complete body succeeds; truncated body rejects; continuous drip bounded by hard deadline; next request succeeds');
const wsHttp=createServer(),wss=new WebSocketServer({server:wsHttp}),sockets:any[]=[];
let attempts=0,closes=0,held=false;const replies:any[]=[];
wss.on('connection',(ws:any)=>{
 const attempt=++attempts;sockets.push(ws);
 ws.on('message',(buf:any)=>{
  const msg=JSON.parse(buf.toString());
  if(msg.method==='initialize'){
   if(attempt===1){ws.send(JSON.stringify({jsonrpc:'2.0',id:900,method:'approval',params:{}}));return}
   ws.send(JSON.stringify({jsonrpc:'2.0',id:msg.id,result:{ok:true}}));return;
  }
  if(msg.method==='probe')ws.send(JSON.stringify({jsonrpc:'2.0',id:msg.id,result:{alive:true}}));
  if(msg.id===900)replies.push({attempt,msg});
 });
});
await new Promise<void>(r=>wsHttp.listen(dir+'/app.sock',r));
const client=new CodexAppServerClient();client.onClose(()=>closes++);
let answer!:(v:any)=>void;client.onServerRequest(()=>{held=true;return new Promise(r=>answer=r)});
await assert.rejects(client.connect(dir+'/app.sock',150),/connect timed out/);assert.ok(held);
await until(()=>sockets[0].readyState===3);
await client.connect(dir+'/app.sock',500);
assert.deepEqual(await client.request('probe',{}),{alive:true});assert.equal(closes,0);
console.log('Codex connect timeout: abandoned socket closed, retry and next request succeed, no stale close callback');
// A new request reuses the id of the abandoned request and is answered by TUI.
const answerOld=answer;let answerNew!:(v:any)=>void;
client.onServerRequest(()=>new Promise(r=>answerNew=r));
sockets[1].send(JSON.stringify({jsonrpc:'2.0',id:900,method:'approval',params:{}}));
await until(()=>!!answerNew);client.resolveServerRequestExternally(900);
answerOld({approved:true});await sleep(50);assert.equal(replies.length,0);
console.log('old response correctly fenced from replacement socket');
answerNew({approved:false});await until(()=>replies.length>0);
assert.equal(replies[0].attempt,2);
console.log('old handler consumed new generation external-resolution marker; new handler sent duplicate response:',JSON.stringify(replies));
client.close();for(const s of sockets)s.terminate();await new Promise<void>(r=>wss.close(()=>r()));await new Promise<void>(r=>wsHttp.close(()=>r()));
console.log('PASS: actual clients against local HTTP/WebSocket servers, no source hooks.');
process.exit(0);
