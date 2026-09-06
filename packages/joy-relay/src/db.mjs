// PGlite-backed store for the native protocol. One embedded postgres, one
// process, one writer — every mutation runs inside tx(), which PGlite
// serializes by construction, so "lock the session row" is structural rather
// than something we can get wrong. The SQL is plain, so moving to a real
// postgres server later is a driver swap, not a rewrite.
import { PGlite } from '@electric-sql/pglite';
import { closeSync, mkdirSync, openSync, readFileSync, realpathSync, statSync, unlinkSync, writeSync } from 'node:fs';

/** Ordered, append-only migrations. Tracked in _migrations by index. */
const MIGRATIONS = [
  // 001 — the v1 nucleus (docs/joy-relay-design.md §2, §9).
  `
  CREATE TABLE native_sessions (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    owner_daemon_id TEXT NOT NULL,
    local_session_id TEXT,
    creation_intent_id TEXT NOT NULL,
    creator_actor_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('provisioning','starting','active','detached','failed','archived')),
    session_key_envelope TEXT,
    encrypted_metadata TEXT,
    next_seq BIGINT NOT NULL DEFAULT 1,
    revision BIGINT NOT NULL DEFAULT 0,
    active_turn_id TEXT,
    recovery_required BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (account_id, creator_actor_id, creation_intent_id)
  );
  CREATE UNIQUE INDEX native_sessions_local ON native_sessions (owner_daemon_id, local_session_id)
    WHERE local_session_id IS NOT NULL;

  CREATE TABLE daemon_leases (
    id TEXT PRIMARY KEY,
    daemon_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    epoch BIGINT NOT NULL,
    token_hash TEXT NOT NULL,
    capabilities JSONB NOT NULL DEFAULT '{}',
    acquired_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    renewed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL,
    released_at TIMESTAMPTZ
  );
  -- one CURRENT lease per daemon (released_at null)
  CREATE UNIQUE INDEX daemon_leases_current ON daemon_leases (daemon_id) WHERE released_at IS NULL;

  CREATE TABLE commands (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES native_sessions(id),
    seq BIGINT NOT NULL,
    event_id TEXT NOT NULL,
    producer_actor_id TEXT NOT NULL,
    client_intent_id TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('prompt','cancel','spawn_session')),
    target_turn_id TEXT,
    scope TEXT,
    barrier_seq BIGINT,
    ciphertext TEXT,
    turn_id TEXT,
    disposition TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('queued','delivered','applied','cancelled','rejected','indeterminate')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (session_id, producer_actor_id, client_intent_id)
  );
  CREATE INDEX commands_queue ON commands (session_id, state, kind, seq);

  CREATE TABLE turns (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES native_sessions(id),
    prompt_command_id TEXT NOT NULL REFERENCES commands(id),
    request_seq BIGINT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('queued','dispatching','running','cancelling','orphaned','terminal')),
    terminal_state TEXT CHECK (terminal_state IN ('completed','failed','cancelled','interrupted')),
    terminal_meta JSONB,
    cancel_requested BOOLEAN NOT NULL DEFAULT FALSE,
    cancel_seq BIGINT,
    lease_epoch BIGINT,
    run_token TEXT,
    transcript_uuid TEXT,
    started_at TIMESTAMPTZ,
    terminal_at TIMESTAMPTZ,
    last_progress_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX turns_by_session ON turns (session_id, state, request_seq);

  CREATE TABLE deliveries (
    id TEXT PRIMARY KEY,
    command_id TEXT NOT NULL REFERENCES commands(id),
    daemon_id TEXT NOT NULL,
    lease_epoch BIGINT NOT NULL,
    lane TEXT NOT NULL CHECK (lane IN ('work','control')),
    attempt INT NOT NULL,
    offered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    received_at TIMESTAMPTZ,
    submitted_at TIMESTAMPTZ,
    receipted_at TIMESTAMPTZ,
    disposition TEXT
  );
  CREATE INDEX deliveries_by_command ON deliveries (command_id, lease_epoch);

  CREATE TABLE session_events (
    session_id TEXT NOT NULL REFERENCES native_sessions(id),
    seq BIGINT NOT NULL,
    event_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    command_id TEXT,
    turn_id TEXT,
    origin_actor_id TEXT,
    origin_client_intent_id TEXT,
    origin_request_hash TEXT,
    runtime_event_id TEXT,
    ciphertext TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (session_id, seq)
  );
  -- daemon fact idempotency: the same runtime event never lands twice
  CREATE UNIQUE INDEX session_events_runtime ON session_events (session_id, runtime_event_id)
    WHERE runtime_event_id IS NOT NULL;
  `,
  // 002 — review fixes: at most ONE execution-bearing turn per session is a
  // database invariant, not just coordinator discipline; session creation
  // stores its full request hash for idempotency-mismatch detection.
  `
  CREATE UNIQUE INDEX turns_one_executing ON turns (session_id)
    WHERE state IN ('dispatching','running','cancelling','orphaned');
  ALTER TABLE native_sessions ADD COLUMN creation_request_hash TEXT;
  `,
  // 003 — v2 attachments: device-born content that must propagate across
  // devices with the machine dead. Ciphertext only; dedupe per (session,hash);
  // cascade on session purge; unreferenced rows swept after a TTL.
  `
  CREATE TABLE attachments (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES native_sessions(id),
    account_id TEXT NOT NULL,
    cipher_hash TEXT NOT NULL,
    size INT NOT NULL,
    body BYTEA NOT NULL,
    referenced_by TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (session_id, cipher_hash)
  );
  CREATE INDEX attachments_by_session ON attachments (session_id);
  `,
  // 004 — spawn directory-creation approval (v1 parity for the durable queue):
  // a spawn whose cwd is missing FAILS with a reason the client can read, then
  // the client RETRIES with create_dir set. spawn_failure surfaces the reason;
  // spawn_create_dir rides the next work offer so the daemon creates the dir.
  `
  ALTER TABLE native_sessions ADD COLUMN spawn_failure TEXT;
  ALTER TABLE native_sessions ADD COLUMN spawn_create_dir BOOLEAN NOT NULL DEFAULT FALSE;
  `,
  // 005 — the account plane goes native: accounts (identity = ed25519 public
  // key, uppercase hex), pairing requests (sealed responses, first write
  // wins), machines (sealed metadata/daemonState with CAS versions) and Expo
  // push tokens. Account ids are opaque strings so rows imported from an
  // earlier authority keep their ids and every existing token stays valid.
  `
  CREATE TABLE accounts (
    id TEXT PRIMARY KEY,
    public_key TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE auth_requests (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('terminal','account')),
    public_key TEXT NOT NULL,
    supports_v2 BOOLEAN NOT NULL DEFAULT FALSE,
    response TEXT,
    response_account_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (kind, public_key)
  );

  CREATE TABLE machines (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    metadata TEXT NOT NULL,
    metadata_version INT NOT NULL DEFAULT 1,
    daemon_state TEXT,
    daemon_state_version INT NOT NULL DEFAULT 0,
    data_encryption_key TEXT,
    seq BIGINT NOT NULL DEFAULT 0,
    last_active_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX machines_by_account ON machines (account_id, last_active_at DESC);

  CREATE TABLE push_tokens (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    token TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (account_id, token)
  );
  `,
  // Pairing answers are collected ONCE (#70): the requester's first authorized
  // poll consumes the request; later polls with the same public key get no
  // token. Answered requests also age out fast (see accounts.sweepPairings).
  `ALTER TABLE auth_requests ADD COLUMN consumed_at TIMESTAMPTZ;`,
  // 007 — attachment references become a JOIN TABLE (#58): one blob may be
  // cited by several prompts (a re-upload dedupes to the same id, a second
  // message reuses it), and the single `referenced_by` column kept only the
  // first — every later offer lost its authorization. Existing references
  // migrate as rows. `uploaded_at` is the orphan clock (#611): a retried
  // upload of an aged, unreferenced blob renews it, so the sweep cannot eat
  // an upload the client was just told succeeded.
  `
  CREATE TABLE attachment_refs (
    attachment_id TEXT NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
    ref TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (attachment_id, ref)
  );
  CREATE INDEX attachment_refs_by_ref ON attachment_refs (ref);
  INSERT INTO attachment_refs (attachment_id, ref)
    SELECT id, referenced_by FROM attachments WHERE referenced_by IS NOT NULL;
  ALTER TABLE attachments DROP COLUMN referenced_by;
  ALTER TABLE attachments ADD COLUMN uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now();
  UPDATE attachments SET uploaded_at = created_at;
  `,
];

/** Exclusive ownership of a data directory. Two relay processes opening the
 *  same directory (overlapping restart, duplicate launch) each got their own
 *  PGlite cache and the later close silently discarded the other's committed
 *  rows (#615). The lock is an O_EXCL file holding the owner's pid; a stale
 *  lock (owner pid gone) is reclaimed by RENAMING it away first — rename is
 *  atomic, so of two concurrent reclaimers only one proceeds to create. */
function acquireDataDirLock(dataDir) {
  // Canonical directory: /x/data and /x/data/. must contend for ONE lock
  // (Astra on 372f7d54). The directory may not exist yet — create it first.
  mkdirSync(dataDir, { recursive: true });
  const canon = realpathSync(dataDir).replace(/\/+$/, '');
  const path = `${canon}.lock`; // beside the dir: PGlite refuses a non-empty data dir that is not yet a database
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = openSync(path, 'wx');
      writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
      closeSync(fd);
      return () => { try { unlinkSync(path); } catch { /* already gone */ } };
    } catch (e) {
      if (e?.code !== 'EEXIST') throw e;
      let holder = null; let raw = '';
      try { raw = readFileSync(path, 'utf8'); holder = JSON.parse(raw); } catch { /* partial write: treat as in-progress */ }
      const pid = Number(holder?.pid);
      if (!holder) {
        // No pid yet: the other opener is mid-write, not stale (a half-written
        // lock is an owner, not a leftover).
        throw new Error(`relay data directory ${dataDir} is being opened by another process`);
      }
      if (pidAlive(pid)) throw new Error(`relay data directory ${dataDir} is owned by pid ${pid}`);
      // Stale (owner dead). Reclaim under a mutex so two reclaimers cannot
      // both proceed, re-reading under it and unlinking only the byte-identical
      // record — never a lock a racer published meanwhile. The mutex is stolen
      // only from a DEAD holder, never by age (same protocol as the daemon's
      // singleton; Astra on af76c787/372f7d54).
      if (!reclaimStale(path, raw)) continue;
    }
  }
  throw new Error(`relay data directory ${dataDir} is locked`);
}

function reclaimStale(path, staleRaw) {
  const mutex = `${path}.reclaiming`;
  let fd;
  try {
    fd = openSync(mutex, 'wx');
  } catch (e) {
    if (e?.code !== 'EEXIST') throw e;
    let holderPid = NaN;
    try { holderPid = Number(readFileSync(mutex, 'utf8').trim()); } catch { return false; }
    if (Number.isInteger(holderPid) && holderPid > 0 && pidAlive(holderPid)) throw new Error(`relay data directory lock ${path} is being reclaimed by pid ${holderPid}`);
    let age = Infinity;
    try { age = Date.now() - statSync(mutex).mtimeMs; } catch { return false; }
    if (!(Number.isInteger(holderPid) && holderPid > 0) && age < 30_000) throw new Error(`relay data directory lock ${path} is being reclaimed by another process`);
    try { unlinkSync(mutex); } catch { /* racer */ }
    return false;
  }
  try {
    writeSync(fd, `${process.pid}\n`); closeSync(fd);
    let current = null;
    try { current = readFileSync(path, 'utf8'); } catch { return false; }
    if (current !== staleRaw) return false;
    try { unlinkSync(path); } catch { return false; }
    return true;
  } finally {
    try { unlinkSync(mutex); } catch { /* best effort */ }
  }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e?.code === 'EPERM'; }
}

export async function openDb(dataDir) {
  const release = dataDir === ':memory:' ? () => {} : acquireDataDirLock(dataDir);
  let pg;
  try { pg = dataDir === ':memory:' ? new PGlite() : new PGlite(dataDir); }
  catch (e) { release(); throw e; }
  await pg.query(`CREATE TABLE IF NOT EXISTS _migrations (idx INT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  const { rows } = await pg.query(`SELECT max(idx) AS n FROM _migrations`);
  const applied = Number(rows[0].n ?? -1);
  for (let i = applied + 1; i < MIGRATIONS.length; i++) {
    await pg.transaction(async (t) => {
      await t.exec(MIGRATIONS[i]);
      await t.query(`INSERT INTO _migrations (idx) VALUES ($1)`, [i]);
    });
  }
  return {
    query: (sql, params) => pg.query(sql, params),
    /** Serialized read-modify-write. PGlite runs one tx at a time; the
     *  callback gets a tx handle with query/exec. Throw to roll back. */
    tx: (fn) => pg.transaction(fn),
    close: async () => { try { await pg.close(); } finally { release(); } },
  };
}
