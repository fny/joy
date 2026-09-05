import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,mkdirSync,writeFileSync} from 'node:fs';
const root=process.env.JOY_REVIEW_SRC ?? '/tmp/joy-test-tmux/review3/wave2a-followup-astra-checkout/packages/joy-daemon/src';
process.env.JOY_HOME_DIR=mkdtempSync('/tmp/joy-test-tmux/review3/wave2-astra-pairing-');
process.env.JOY_RELAY_URL='https://first.test';
const paths=await import(root+'/paths.ts');
const {pairWithRelay}=await import(root+'/relay/pairing.ts');
const {setEnvVar,readEnvStore}=await import(root+'/domain/envStore.ts');
let response:string|undefined;
globalThis.fetch=(async(url:any,init:any)=>{
 const path=new URL(url).pathname, body=JSON.parse(init.body);
 if(path.endsWith('/auth'))return Response.json({token:'account-token'});
 if(path.endsWith('/response')){response=body.response;return Response.json({ok:true})}
 if(path.endsWith('/request')){if(!response)return Response.json({state:'requested'}); const r=response;response=undefined;return Response.json({state:'authorized',token:'machine-token',response:r})}
 throw new Error('unexpected URL');
}) as any;
const secret=new Uint8Array(32).fill(7);
const first=paths.joyRelayCredsDir();
await pairWithRelay(paths.joyRelayUrl(),secret,first);
assert.deepEqual(setEnvVar('TEST_PROVIDER_TOKEN','test-value'),{ok:true});
const old=JSON.parse(readFileSync(first+'/access.key','utf8')).encryption.machineKey;
await pairWithRelay(paths.joyRelayUrl(),secret,first);
assert.equal(JSON.parse(readFileSync(first+'/access.key','utf8')).encryption.machineKey,old);
assert.deepEqual(readEnvStore(),{ok:true,env:{TEST_PROVIDER_TOKEN:'test-value'}});
console.log('same-relay re-pair: key retained and sealed store readable');
await pairWithRelay('https://second.test',secret,paths.joyRelayCredsDir('https://second.test'));
process.env.JOY_RELAY_URL='https://second.test';paths.__resetRelaySelection();
assert.deepEqual(readEnvStore(),{ok:true,env:{TEST_PROVIDER_TOKEN:'test-value'}});
console.log('new relay: inherited key and sealed store readable');
const legacy=paths.joyRelayCredsDir('https://aaa-legacy.test');mkdirSync(legacy,{recursive:true});
writeFileSync(legacy+'/access.key',JSON.stringify({token:'legacy',encryption:{publicKey:Buffer.alloc(32,2).toString('base64'),machineKey:Buffer.alloc(32,99).toString('base64')}}));
await pairWithRelay('https://third.test',secret,paths.joyRelayCredsDir('https://third.test'));
process.env.JOY_RELAY_URL='https://third.test';paths.__resetRelaySelection();
assert.deepEqual(readEnvStore(),{ok:false,error:'store_unreadable'});
console.log('existing sibling keys diverge: fresh third relay inherited wrong key, store_unreadable');
console.log('PASS: actual self-pairing and AES-GCM env store, mocked relay HTTP only.');
