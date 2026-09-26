// Browser synthesis/playback + cached-model test using an isolated Chrome profile.
// Uses a loopback fixture server and hash-verified local model files; no model network.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '../public');
const models = process.argv[2];
if (!models) throw new Error('Usage: node scripts/test-pocket-browser.cjs MODEL_DIRECTORY');
let denied = false, downloads = 0;
const isolated = process.env.POCKET_ISOLATED !== '0';
const ts = require('typescript');
const playbackModule = ts.transpileModule(fs.readFileSync(path.resolve(__dirname, '../sources/realtime/speechOutput.web.ts'), 'utf8'), {
 compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;
const page = `<!doctype html><button id="go">Test local Pocket speech</button><pre id="result"></pre><script type="module">
import {createSpeechOutput} from '/playback.js';
let requestId=0;
function client(){
 const worker=new Worker('/pocket/worker.js',{type:'module'}), tasks=new Map();
 worker.onmessage=({data})=>{if(data.type==='progress')return;const task=tasks.get(data.id);if(!task)return;if(data.type==='audio'){task.onChunk(data.pcm,data.sampleRate);return}tasks.delete(data.id);data.error?task.reject(new Error(data.error)):task.resolve(data.audio)};
 worker.onerror=e=>{for(const t of tasks.values())t.reject(new Error(e.message));tasks.clear()};
 return {worker,call:(type,payload={},onChunk)=>new Promise((resolve,reject)=>{const id=++requestId;tasks.set(id,{resolve,reject,onChunk});worker.postMessage({id,type,...payload})})};
}
document.querySelector('#go').onclick=async()=>{
 const ctx=new AudioContext();await ctx.resume();const output=createSpeechOutput();await output.prepare();
 const started=performance.now();let c=client();
 try{
  await c.call('prepare',{voice:'alba'});const ready=performance.now();
  // Match Joy's session path: wait for complete synthesis, then play one buffer.
  // Incremental decoder chunks can underrun and interrupt words on slow devices.
  const wav=await c.call('generate',{text:'Hello Chris. Pocket speech is running inside Joy.'});
  const generated=performance.now();
  const decoded=await ctx.decodeAudioData(wav.slice().buffer);
  const firstAudio=performance.now(),audioSeconds=decoded.duration;
  await output.play(wav,new AbortController().signal);const played=performance.now();
  c.worker.terminate();await fetch('/deny-models');
  c=client();await c.call('prepare',{voice:'alba'});
  const second=await c.call('generate',{text:'The model is cached on this device.'});
  const cached=await ctx.decodeAudioData(second.buffer);
  window.pocketResult={ok:true,loadSeconds:(ready-started)/1000,generationSeconds:(generated-ready)/1000,firstAudioSeconds:(firstAudio-ready)/1000,playbackFinishedSeconds:(played-ready)/1000,audioSeconds,cachedAudioSeconds:cached.duration,sampleRate:cached.sampleRate,crossOriginIsolated};
 }catch(e){window.pocketResult={ok:false,error:e.stack||String(e)}}finally{c.worker.terminate();output.dispose();await ctx.close();document.querySelector('#result').textContent=JSON.stringify(window.pocketResult)}
};</script>`;
const server=http.createServer((req,res)=>{
 if(isolated){res.setHeader('Cross-Origin-Opener-Policy','same-origin');res.setHeader('Cross-Origin-Embedder-Policy','require-corp');}
 if(req.url==='/playback.js'){res.setHeader('content-type','text/javascript');res.end(playbackModule);return;}
 if(req.url==='/pocket/worker.js' && process.env.POCKET_BENCHMARK_SEED){
  res.setHeader('content-type','text/javascript');
  // Deterministic noise makes benchmark comparisons use the same generated speech.
  res.end('let seed=12345;Math.random=()=>((seed=Math.imul(seed,1664525)+1013904223>>>0)+0.5)/4294967296;\n'+fs.readFileSync(path.join(root,'pocket/worker.js'),'utf8'));return;
 }
 if(req.url==='/'){res.setHeader('content-type','text/html');res.end(page);return;}
 if(req.url==='/deny-models'){denied=true;res.end('done');return;}
 if(req.url==='/pocket/assets.json'){
  const assets=JSON.parse(fs.readFileSync(path.join(root,'pocket/assets.json')));
  for(const [name,asset] of Object.entries(assets.files))asset.url=`http://127.0.0.1:${server.address().port}/models/${name}`;
  res.setHeader('content-type','application/json');res.end(JSON.stringify(assets));return;
 }
 let file;
 if(req.url.startsWith('/models/')){
  if(denied){res.writeHead(503);res.end('Model network disabled');return;}
  downloads++;file=path.join(models,path.basename(req.url));
 }else file=path.join(root,path.normalize(req.url).replace(/^\/+/,''));
 if(!file.startsWith(root)&&!file.startsWith(models)){res.writeHead(404);res.end();return;}
 if(!fs.existsSync(file)){res.writeHead(404);res.end();return;}
 res.setHeader('content-type',file.endsWith('.wasm')?'application/wasm':file.endsWith('.js')||file.endsWith('.mjs')?'text/javascript':file.endsWith('.json')?'application/json':'application/octet-stream');
 res.setHeader('content-length',fs.statSync(file).size);fs.createReadStream(file).pipe(res);
});
let chrome,ws;
(async()=>{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const profile=fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'joy-pocket-chrome-'));
 chrome=spawn(process.env.CHROME_BIN || 'google-chrome',['--headless=new',...(process.env.JOY_POCKET_CHROME_NO_SANDBOX === '1' ? ['--no-sandbox'] : []),'--disable-dev-shm-usage',`--user-data-dir=${profile}`,'--remote-debugging-port=0','--remote-debugging-address=127.0.0.1','about:blank'],{stdio:'ignore'});
 for(let i=0;i<100&&!fs.existsSync(path.join(profile,'DevToolsActivePort'));i++)await new Promise(r=>setTimeout(r,100));
 const port=fs.readFileSync(path.join(profile,'DevToolsActivePort'),'utf8').split('\n')[0];
 const targets=await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
 ws=new WebSocket(targets.find(t=>t.type==='page').webSocketDebuggerUrl);await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject});
 const tasks=new Map();let id=0;
 ws.onmessage=event=>{const data=JSON.parse(event.data);if(data.id){const t=tasks.get(data.id);tasks.delete(data.id);data.error?t.reject(data.error):t.resolve(data.result)}};
 const call=(method,params={})=>new Promise((resolve,reject)=>{const n=++id;tasks.set(n,{resolve,reject});ws.send(JSON.stringify({id:n,method,params}))});
 await call('Page.navigate',{url:`http://127.0.0.1:${server.address().port}`});
 await new Promise(r=>setTimeout(r,500));
 await call('Input.dispatchMouseEvent',{type:'mousePressed',x:60,y:20,button:'left',clickCount:1});
 await call('Input.dispatchMouseEvent',{type:'mouseReleased',x:60,y:20,button:'left',clickCount:1});
 const r=await call('Runtime.evaluate',{expression:'new Promise((resolve,reject)=>{const start=Date.now();const timer=setInterval(()=>{if(window.pocketResult){clearInterval(timer);resolve(window.pocketResult)}else if(Date.now()-start>120000){clearInterval(timer);reject(new Error("browser test timed out"))}},100)})',awaitPromise:true,returnByValue:true});
 console.log(JSON.stringify({browser:r.result?.value||r,modelDownloads:downloads,modelNetworkDisabled:denied}));
 if(!r.result?.value?.ok)process.exitCode=1;
})().catch(error=>{console.error(error);process.exitCode=1}).finally(()=>{ws?.close();chrome?.kill();server.close()});
