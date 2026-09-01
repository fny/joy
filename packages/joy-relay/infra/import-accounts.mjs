#!/usr/bin/env node
// One-shot import of an account-plane export into a relay data dir. Used to
// carry accounts/machines/push tokens over from an earlier authority so ids
// (and therefore every issued bearer token) survive. Run with the relay
// STOPPED — PGlite is single-writer.
//
//   node infra/import-accounts.mjs <data-dir> <export.json>
//
// export.json shape (all timestamps ISO strings or epoch ms):
//   { accounts:   [{ id, publicKey (base64 or hex), createdAt, updatedAt }],
//     machines:   [{ id, accountId, metadata, metadataVersion, daemonState,
//                    daemonStateVersion, dataEncryptionKey, seq, lastActiveAt,
//                    createdAt, updatedAt }],
//     pushTokens: [{ id, accountId, token, createdAt, updatedAt }] }
// Existing rows with the same id are left untouched (idempotent).
import { readFileSync } from 'node:fs';
import { openDb } from '../src/db.mjs';

const [dataDir, file] = process.argv.slice(2);
if (!dataDir || !file) { console.error('usage: import-accounts.mjs <data-dir> <export.json>'); process.exit(2); }
const dump = JSON.parse(readFileSync(file, 'utf8'));

const ts = (v) => (v == null ? new Date().toISOString() : new Date(v).toISOString());
const keyHex = (k) => {
  if (/^[0-9a-f]{64}$/i.test(k)) return k.toUpperCase();
  const buf = Buffer.from(k, 'base64');
  if (buf.length !== 32) throw new Error(`bad public key: ${k}`);
  return buf.toString('hex').toUpperCase();
};

const db = await openDb(dataDir);
const n = { accounts: 0, machines: 0, pushTokens: 0 };
await db.tx(async (t) => {
  for (const a of dump.accounts ?? []) {
    const r = await t.query(
      `INSERT INTO accounts (id, public_key, created_at, updated_at) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
      [a.id, keyHex(a.publicKey), ts(a.createdAt), ts(a.updatedAt)],
    );
    n.accounts += r.affectedRows ?? 0;
  }
  for (const m of dump.machines ?? []) {
    const r = await t.query(
      `INSERT INTO machines (id, account_id, metadata, metadata_version, daemon_state, daemon_state_version,
         data_encryption_key, seq, last_active_at, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING`,
      [m.id, m.accountId, m.metadata ?? '', m.metadataVersion ?? 1, m.daemonState ?? null, m.daemonStateVersion ?? 0,
        m.dataEncryptionKey ?? null, m.seq ?? 0, ts(m.lastActiveAt), ts(m.createdAt), ts(m.updatedAt)],
    );
    n.machines += r.affectedRows ?? 0;
  }
  for (const p of dump.pushTokens ?? []) {
    const r = await t.query(
      `INSERT INTO push_tokens (id, account_id, token, created_at, updated_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
      [p.id, p.accountId, p.token, ts(p.createdAt), ts(p.updatedAt)],
    );
    n.pushTokens += r.affectedRows ?? 0;
  }
});
const count = async (tbl) => Number((await db.query(`SELECT count(*) AS n FROM ${tbl}`)).rows[0].n);
console.log(`imported accounts=${n.accounts} machines=${n.machines} pushTokens=${n.pushTokens}`);
console.log(`totals accounts=${await count('accounts')} machines=${await count('machines')} pushTokens=${await count('push_tokens')}`);
await db.close();
