// What the relay box is doing right now — for Settings → Relay in the app.
//
// The daemon side has reported host stats for every machine since July
// (cpu/ram/disk on the machine page); the relay never said anything about
// itself, so "why is the relay slow" meant ssh. This is the same shape,
// pointed inward: host load and memory, disk under / and under the data dir,
// the database's size and row counts, leases and SSE clients, uptime, version.
//
// One thing it cannot know is whether its disk is encrypted at rest — that is
// an AWS fact invisible from inside the guest — so it does not pretend to.

import * as os from 'node:os';
import * as fs from 'node:fs';
import { join } from 'node:path';

let lastCpu = null;
/** CPU busy % since the previous call (first call: load-average estimate). */
function cpuPercent() {
  const list = os.cpus();
  const sum = list.reduce((acc, c) => {
    const t = c.times; acc.idle += t.idle; acc.total += t.user + t.nice + t.sys + t.irq + t.idle; return acc;
  }, { idle: 0, total: 0 });
  const prev = lastCpu; lastCpu = sum;
  if (!prev) return Math.max(0, Math.min(100, Math.round((os.loadavg()[0] / Math.max(1, list.length)) * 100)));
  const dTotal = sum.total - prev.total, dIdle = sum.idle - prev.idle;
  if (dTotal <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((1 - dIdle / dTotal) * 100)));
}

/** Reclaimable-aware available memory on Linux (os.freemem() ignores cache). */
function memAvailable() {
  try {
    const m = /MemAvailable:\s+(\d+) kB/.exec(fs.readFileSync('/proc/meminfo', 'utf8'));
    if (m) return Number(m[1]) * 1024;
  } catch { /* not linux */ }
  return os.freemem();
}

function disk(path) {
  try {
    const s = fs.statfsSync(path);
    const total = Number(s.blocks) * Number(s.bsize), free = Number(s.bavail) * Number(s.bsize);
    return { path, totalBytes: total, freeBytes: free, usedPercent: total > 0 ? Math.round((1 - free / total) * 100) : null };
  } catch { return { path, totalBytes: null, freeBytes: null, usedPercent: null }; }
}

function dirBytes(path) {
  let bytes = 0;
  const walk = (dir) => {
    let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) { try { bytes += fs.statSync(p).size; } catch { /* raced */ } }
    }
  };
  walk(path);
  return bytes;
}

async function count(db, sql) {
  try { const { rows } = await db.query(sql); return Number(rows[0]?.n ?? 0); } catch { return null; }
}

export async function relayStatus({ db, notify, dataDir, version, startedAt }) {
  const memTotal = os.totalmem(), memAvail = memAvailable();
  const [accounts, machines, sessions, sessionsLive, events, leases] = await Promise.all([
    count(db, `SELECT COUNT(*)::int AS n FROM accounts`),
    count(db, `SELECT COUNT(*)::int AS n FROM machines`),
    count(db, `SELECT COUNT(*)::int AS n FROM native_sessions`),
    count(db, `SELECT COUNT(*)::int AS n FROM native_sessions WHERE state IN ('provisioning','starting','active')`),
    count(db, `SELECT COUNT(*)::int AS n FROM session_events`),
    count(db, `SELECT COUNT(*)::int AS n FROM daemon_leases WHERE released_at IS NULL AND expires_at > now()`),
  ]);
  let dbSizeBytes = null;
  try { const { rows } = await db.query(`SELECT pg_database_size(current_database())::bigint AS n`); dbSizeBytes = Number(rows[0]?.n ?? null); } catch { /* not exposed by this engine */ }
  const dataDirBytes = dataDir && dataDir !== ':memory:' ? dirBytes(dataDir) : null;
  const live = notify?.stats?.() ?? null;
  return {
    relay: 'joy-relay', version: version ?? null, node: process.version,
    uptimeSeconds: Math.round(process.uptime()), startedAt: startedAt ?? null, now: Date.now(),
    host: {
      hostname: os.hostname(), platform: os.platform(), cpuCount: os.cpus().length, cpuModel: os.cpus()[0]?.model ?? null,
      cpuPercent: cpuPercent(), load1: Number(os.loadavg()[0].toFixed(2)),
      memTotalBytes: memTotal, memAvailableBytes: memAvail, memUsedPercent: Math.round((1 - memAvail / memTotal) * 100),
      processRssBytes: process.memoryUsage().rss,
    },
    disk: { root: disk('/'), data: dataDir && dataDir !== ':memory:' ? disk(dataDir) : null },
    db: { dataDir: dataDir ?? null, dataDirBytes, sizeBytes: dbSizeBytes, accounts, machines, sessions, sessionsLive, events },
    live: { daemonLeases: leases, sseClients: live?.sseClients ?? null, sseAccounts: live?.sseAccounts ?? null },
  };
}
