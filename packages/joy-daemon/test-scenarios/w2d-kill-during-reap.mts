import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
const root='/tmp/joy-test-tmux/review3/wave2d-astra-checkout/packages/joy-daemon/src';
const dir=mkdtempSync('/tmp/joy-test-tmux/review3/wave2d-astra-reap-');process.env.JOY_HOME_DIR=dir;
let release!:()=>void,reaping=false,spawned=0,created=0;
const gate=new Promise<void>(r=>release=r);
class Client {async createSession(){created++;return {id:'new-conversation'}}onEvent(){}subscribeEvents(){}close(){}}
(globalThis as any).__mock={OpencodeClient:Client,isOpencodeServerPid:()=>true,killOpencodeServerPid:async()=>{reaping=true;await gate},spawnOpencodeServer(){spawned++;return {proc:new EventEmitter(),port:Promise.resolve(1234)}}};
const file=root+'/opencode/opencodeSession.ts';
let src=readFileSync(file,'utf8').replace('import { spawnOpencodeServer, OpencodeClient, isOpencodeServerPid, killOpencodeServerPid } from "./opencodeClient";','const {spawnOpencodeServer,OpencodeClient,isOpencodeServerPid,killOpencodeServerPid}=(globalThis as any).__mock;');
src=src.replace(/(from\s+["'])(\.[^"']+)(["'])/g,(_,a,p,b)=>a+resolve(dirname(file),p)+b);writeFileSync(dir+'/session.mts',src);
const {OpencodeSession}=await import(dir+'/session.mts');
const s=new OpencodeSession({id:'deadbeef',cwd:dir,status:'starting',startedAt:0,opencodeServerPid:1234},{relayClient:null,broadcast(){},addChatMessage(){}});
s.beginWatching();assert.ok(reaping);assert.equal(spawned,0);s.forceKill();assert.equal(s.status,'ended');
release();await new Promise(r=>setTimeout(r,40));assert.equal(spawned,1);assert.equal(created,1);assert.equal(s.end('killed'),false);
console.log('kill during awaited reaping: ended session spawned replacement and created a conversation after forceKill; repeated end is a no-op');
console.log('PASS: copied actual startup/teardown with controlled process/client boundary.');process.exit(0);
