// PGlite-backed store for the native protocol. One embedded postgres, one
// process, one writer — every mutation runs inside tx(), which PGlite
// serializes by construction, so "lock the session row" is structural rather
// than something we can get wrong. The reserved postgres quadlet stays
// available if this ever needs to move to a real server; the SQL is plain.
import { PGlite } from '@electric-sql/pglite';

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
];

export async function openDb(dataDir) {
  const pg = dataDir === ':memory:' ? new PGlite() : new PGlite(dataDir);
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
    close: () => pg.close(),
  };
}
