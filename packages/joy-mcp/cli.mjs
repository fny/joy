#!/usr/bin/env node
// joy-mcp — a remote MCP server that is a full client of one joy account.
//
//   joy-mcp pair --relay https://<relay host>:4997 [--minutes 60]   approve from the joy app (QR / link)
//   joy-mcp pair --relay … --secret <backup code>                  from the account backup code
//   joy-mcp serve                                                   JOY_MCP_PORT (3107) · JOY_MCP_PUBLIC_URL
//   joy-mcp token new <name>                                        a bearer for Claude Code / scripts
//   joy-mcp token ls · token rm <hash>
//   joy-mcp status
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { loadAccount, pairWithApp, pairWithSecret, keysFor, mcpHome, ensureHome } from './src/account.mjs';
import { RelayClient, loginWithSecret } from './src/relay.mjs';
import { SessionIndex } from './src/model.mjs';
import { DaemonTunnel } from './src/daemon.mjs';
import { Hub } from './src/server.mjs';
import { FileStore, JoyOAuthProvider } from './src/oauth.mjs';
import { createApp } from './src/app.mjs';

const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const has = (name) => argv.includes(name);
const log = (s) => process.stderr.write(`[joy-mcp] ${new Date().toISOString().slice(11, 19)} ${s}\n`);

async function main() {
  const cmd = argv[0];
  if (cmd === 'pair') {
    const relay = flag('--relay') ?? process.env.JOY_RELAY_URL;
    if (!relay) { console.error('usage: joy-mcp pair --relay <url> [--secret <backup code>]'); return 2; }
    const dir = ensureHome();
    if (has('--secret')) {
      let code = flag('--secret');
      if (!code || code === '-') code = await readLine('Backup code: ');
      const acct = await pairWithSecret(relay, code, dir);
      console.log(`paired to ${acct.relayUrl} as ${acct.accountPublicKey.slice(0, 12)}… (creds in ${dir})`);
      return 0;
    }
    const minutes = Number(flag('--minutes') ?? 60);
    const acct = await pairWithApp(relay, {
      timeoutMs: minutes * 60_000,
      onCode: async (link) => {
        console.log('\nApprove this device in the joy app — Settings → Connect a device — by scanning:\n');
        try { const qr = (await import('qrcode-terminal')).default; qr.generate(link, { small: true }, (s) => console.log(s)); } catch { /* no QR lib */ }
        console.log(`or paste the link:\n  ${link}\n\nWaiting for approval…`);
      },
      perimeterKey: process.env.JOY_RELAY_ACCESS_KEY?.trim() || undefined,
    }, dir);
    console.log(`paired to ${acct.relayUrl} as ${acct.accountPublicKey.slice(0, 12)}… (creds in ${dir})`);
    return 0;
  }
  if (cmd === 'token') {
    const sub = argv[1];
    const provider = new JoyOAuthProvider({ store: new FileStore(ensureHome()), account: loadAccount() });
    if (sub === 'new') {
      const name = argv[2];
      if (!name) { console.error('usage: joy-mcp token new <name>'); return 2; }
      console.log(provider.mintBearer(name));
      return 0;
    }
    if (sub === 'ls') { for (const t of provider.listTokens()) console.log(`${t.hash}  ${t.type.padEnd(8)} ${String(t.client).padEnd(28)} ${new Date(t.issuedAt).toISOString()}${t.expiresAt ? `  until ${new Date(t.expiresAt).toISOString()}` : ''}`); return 0; }
    if (sub === 'rm') {
      const prefix = argv[2];
      if (!prefix || prefix.length < 4) { console.error('usage: joy-mcp token rm <hash prefix from token ls, 4+ chars>'); return 2; }
      console.log(`revoked ${provider.removeTokens(prefix)}`);
      return 0;
    }
    console.error('usage: joy-mcp token new <name> | ls | rm <hash>'); return 2;
  }
  if (cmd === 'status') {
    const acct = loadAccount();
    if (!acct) { console.log(`not paired (run joy-mcp pair). home: ${mcpHome()}`); return 1; }
    const relay = await clientFor(acct);
    const { sessions } = await relay.listSessions();
    const { machines } = await relay.listMachines();
    console.log(`relay     ${acct.relayUrl}\naccount   ${acct.accountPublicKey.slice(0, 12)}…\nmachines  ${machines.length} (${machines.filter((m) => m.active || m.leaseAlive).length} online)\nsessions  ${sessions.length} (${sessions.filter((s) => s.online).length} online)\nhome      ${mcpHome()}`);
    return 0;
  }
  if (cmd === 'serve') return serve();
  console.error('usage: joy-mcp pair|serve|token|status');
  return 2;
}

async function clientFor(acct) {
  const keys = keysFor(acct.secret);
  const perimeterKey = process.env.JOY_RELAY_ACCESS_KEY?.trim() || keys.perimeterKey;
  const relay = new RelayClient({
    relayUrl: acct.relayUrl, token: acct.token, perimeterKey,
    renew: async () => { const { token } = await loginWithSecret(acct.relayUrl, acct.secret, { perimeterKey }); acct.token = token; return token; },
  });
  return relay;
}

async function serve() {
  const acct = loadAccount();
  if (!acct) { console.error(`not paired — run: joy-mcp pair --relay <url>   (home: ${mcpHome()})`); return 1; }
  const publicUrl = process.env.JOY_MCP_PUBLIC_URL;
  if (!publicUrl) { console.error('JOY_MCP_PUBLIC_URL is required (the origin Claude connects to, e.g. https://relay.example.com)'); return 1; }
  const port = Number(process.env.JOY_MCP_PORT ?? 3107);
  const relay = await clientFor(acct);
  const keys = keysFor(acct.secret);
  const index = new SessionIndex({ relay, contentSecret: keys.content.secretKey, log });
  const tunnel = new DaemonTunnel({ relay, index });
  const hub = new Hub({ index, tunnel, relay, log });
  const provider = new JoyOAuthProvider({ store: new FileStore(ensureHome()), account: acct });
  await index.refresh();
  index.start();
  const app = createApp({ hub, provider, publicUrl, log });
  const server = createServer(app);
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  log(`listening on 127.0.0.1:${port} as ${publicUrl}/mcp — ${index.rows.size} sessions, ${index.machines.size} machines`);
  const stop = () => { log('stopping'); index.stop(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 2000); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
  return new Promise(() => {});
}

function readLine(prompt) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((r) => rl.question(prompt, (a) => { rl.close(); r(a); }));
}

main().then((code) => { if (typeof code === 'number') process.exit(code); }, (e) => { console.error(e?.stack ?? e); process.exit(1); });
