import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
const root='/tmp/joy-test-tmux/review3/wave2c-astra-checkout/packages/joy-daemon/src';
const dir=mkdtempSync('/tmp/joy-test-tmux/review3/wave2c-astra-events-');process.env.JOY_HOME_DIR=dir;
const {saveWindowRecord,loadWindowRecord,deleteWindowRecord}=await import(root+'/domain/windowRecord.ts');
for(const [agent,name] of [['pi','PiSession'],['agy','AgySession']] as const){
 const file=root+'/'+agent+'/'+agent+'Session.ts';
 let src=readFileSync(file,'utf8');
 src=src.replace(`export class ${name} implements AgentSession {`,`export class ${name} implements AgentSession { __event(e:any){${agent==='agy'?"this.#turn='test-turn';":''}this.#onEvent(e);}`);
 src=src.replace(/(from\s+["'])(\.[^"']+)(["'])/g,(_,a,p,b)=>a+resolve(dirname(file),p)+b);
 writeFileSync(dir+'/'+agent+'.mts',src);const C=(await import(dir+'/'+agent+'.mts'))[name];
 const id=agent==='pi'?'aaaabbbb':'ccccdddd';
 const s=new C({id,cwd:dir,status:'active',startedAt:0},{relayClient:null,broadcast(){},addChatMessage(){}});
 const event=(value:string)=>agent==='pi'?{type:'response',command:'get_state',success:true,data:{model:{id:value}}}:{event:'init',conversation_id:value};
 s.__event(event('initial'));assert.equal(loadWindowRecord(id)?.agent,agent);
 s.end('restart');deleteWindowRecord(id);s.__event(event('late-after-delete'));assert.equal(loadWindowRecord(id),null);
 saveWindowRecord(id,{launchCwd:dir,agent,piSettings:{model:'replacement'},agySettings:{conversationId:'replacement'}});
 const before=loadWindowRecord(id);s.__event(event('late-after-replacement'));assert.deepEqual(loadWindowRecord(id),before);
 console.log(agent+': live event saves; late event cannot recreate deleted record or overwrite replacement');
}
console.log('PASS: actual event handlers with isolated records, no agent process started.');process.exit(0);
