import tweetnacl from 'tweetnacl';
import { readFileSync } from 'node:fs';
const [sid, credsPath, wantSeq] = process.argv.slice(2);
const creds = JSON.parse(readFileSync(credsPath,'utf8'));
const key = new Uint8Array(Buffer.from(creds.encryption.secret,'base64'));
function dec(buf,k){const n=tweetnacl.secretbox.nonceLength;const p=tweetnacl.secretbox.open(buf.slice(n),buf.slice(0,n),k);return p?JSON.parse(new TextDecoder().decode(p)):null;}
const res = await fetch(`${creds.serverUrl}/v3/sessions/${sid}/messages?after_seq=0&limit=50`,{headers:{Authorization:`Bearer ${creds.token}`}});
const {messages}=await res.json();
for(const m of messages){ if(String(m.seq)!==wantSeq) continue; const c=typeof m.content==='string'?m.content:m.content.c; console.log(JSON.stringify(dec(new Uint8Array(Buffer.from(c,'base64')),key),null,2)); }
