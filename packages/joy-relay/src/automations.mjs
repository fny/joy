// Automations: a saved intention — a folder, a prompt and a trigger — and the
// runs it produces.
//
// The relay's whole job here is scheduling and arbitration. It never sees what
// an automation does: `spec` is a SpawnSpec sealed under the TARGET MACHINE's
// key, because joy's daemon holds a machine key and no account key. The relay
// stores the ciphertext and hands it back to the one daemon that can open it.
//
// A run is not a new execution mechanism. It calls core.createSession with
// mode 'spawn', which puts a `spawn_session` command on the nucleus lane the
// daemon already polls — the same path the app's new-session screen uses. The
// run id is the creationIntentId, so the relay's existing idempotency makes a
// retried trigger incapable of spawning twice.
import { randomUUID } from 'node:crypto';
import { ApiError } from './core.mjs';
import { parseCron, nextCronAfter, cronOccurrencesBetween, CronError } from './cron.mjs';

/** Bounds. The spec is a sealed blob; the rest is metadata a human typed. */
const MAX_SPEC_CHARS = 256 * 1024;
const MAX_NAME_CHARS = 200;
const MAX_DIRECTORY_CHARS = 4096;
const MAX_TRIGGERS = 16;
const RUN_HISTORY_DEFAULT = 50;
const RUN_HISTORY_MAX = 200;

/** Shared with the daemon (domain/automationRun.ts) — a wire constant. */
export const AUTOMATION_INTENT_PREFIX = 'automation-run:';

// What is left after three were removed. `turn_done` and `machine_online`
// (012) were built, offered and wanted by nobody. `session_state` (013) went
// for a better reason: it could not have worked here — the states worth
// triggering on are computed by the app from SEALED card metadata the relay
// cannot read, so the component evaluating triggers never knew them.
const TRIGGER_KINDS = new Set(['manual', 'automation_done', 'schedule']);
/** How many missed occurrences a single catch-up will record before it stops
 *  counting. A machine offline for a month on a one-minute schedule owes
 *  43,200 of them; the number stops being informative long before that. */
const CATCH_UP_CAP = 200;
/** A run that has not reached a terminal state yet. */
const LIVE_RUN_STATES = ['queued', 'running'];

const str = (v) => (typeof v === 'string' ? v.trim() : '');

export function createAutomations(db, core, notify) {
  const rowOut = (a, triggers = []) => ({
    id: a.id,
    machineId: a.machine_id,
    directory: a.directory,
    name: a.name,
    enabled: a.enabled,
    spec: a.spec,
    specVersion: Number(a.spec_version),
    lastRunAt: a.last_run_at ? new Date(a.last_run_at).getTime() : null,
    createdAt: new Date(a.created_at).getTime(),
    updatedAt: new Date(a.updated_at).getTime(),
    triggers: triggers.map((t) => ({
      kind: t.kind,
      filter: t.filter,
      ...(t.timezone ? { timezone: t.timezone } : {}),
      ...(t.next_run_at ? { nextRunAt: new Date(t.next_run_at).getTime() } : {}),
    })),
  });

  const runOut = (r) => ({
    id: r.id,
    automationId: r.automation_id,
    state: r.state,
    triggerKind: r.trigger_kind,
    sessionId: r.session_id,
    errorCode: r.error_code,
    errorMessage: r.error_message,
    acknowledgedAt: r.acknowledged_at ? new Date(r.acknowledged_at).getTime() : null,
    startedAt: r.started_at ? new Date(r.started_at).getTime() : null,
    finishedAt: r.finished_at ? new Date(r.finished_at).getTime() : null,
    createdAt: new Date(r.created_at).getTime(),
  });

  /** Reject early and by name: every one of these is a client mistake the
   *  caller can fix, and a silent truncation would be worse than a 400. */
  function validate({ name, machineId, directory, spec, triggers }) {
    if (!str(name)) throw new ApiError(400, 'missing_name');
    if (str(name).length > MAX_NAME_CHARS) throw new ApiError(400, 'name_too_long');
    if (!str(machineId)) throw new ApiError(400, 'missing_machine_id');
    if (!str(directory)) throw new ApiError(400, 'missing_directory');
    if (str(directory).length > MAX_DIRECTORY_CHARS) throw new ApiError(400, 'directory_too_long');
    if (!str(spec)) throw new ApiError(400, 'missing_spec');
    if (spec.length > MAX_SPEC_CHARS) throw new ApiError(413, 'spec_too_large');
    if (!Array.isArray(triggers) || triggers.length === 0) throw new ApiError(400, 'missing_triggers');
    if (triggers.length > MAX_TRIGGERS) throw new ApiError(400, 'too_many_triggers');
    for (const t of triggers) {
      if (!t || !TRIGGER_KINDS.has(t.kind)) throw new ApiError(400, 'bad_trigger_kind');
      if (t.filter !== undefined && t.filter !== null && typeof t.filter !== 'string') {
        throw new ApiError(400, 'bad_trigger_filter');
      }
      // A schedule is checked HERE, at authoring time, where the person who
      // typed it is still looking. A bad expression accepted now is an
      // automation that silently never runs, and nothing later would say why.
      if (t.kind === 'schedule') {
        try { parseCron(t.filter); } catch (e) {
          throw new ApiError(400, { error: 'bad_cron', message: String(e?.message ?? e) });
        }
        if (t.timezone !== undefined && t.timezone !== null) {
          if (typeof t.timezone !== 'string') throw new ApiError(400, 'bad_timezone');
          try { new Intl.DateTimeFormat('en', { timeZone: t.timezone }); } catch {
            throw new ApiError(400, { error: 'bad_timezone', message: `unknown time zone "${t.timezone}"` });
          }
        }
      }
    }
  }

  async function loadOwned(t, accountId, id) {
    const { rows: [a] } = await t.query(`SELECT * FROM automations WHERE id = $1`, [id]);
    if (!a) throw new ApiError(404, 'automation_not_found');
    if (a.account_id !== accountId) throw new ApiError(404, 'automation_not_found');
    return a;
  }

  async function triggersOf(t, id) {
    const { rows } = await t.query(
      `SELECT kind, filter, timezone, next_run_at FROM automation_triggers WHERE automation_id = $1 ORDER BY kind, filter`, [id]);
    return rows;
  }

  async function writeTriggers(t, id, triggers) {
    await t.query(`DELETE FROM automation_triggers WHERE automation_id = $1`, [id]);
    for (const trig of triggers) {
      // A schedule's first `next_run_at` is computed on write, so the ticker
      // has something to scan from the moment it exists rather than needing a
      // separate "seed" pass.
      const tz = trig.kind === 'schedule' ? (str(trig.timezone) || 'UTC') : null;
      const next = trig.kind === 'schedule' ? nextCronAfter(str(trig.filter), tz, Date.now()) : null;
      await t.query(
        `INSERT INTO automation_triggers (automation_id, kind, filter, timezone, next_run_at)
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
        [id, trig.kind, str(trig.filter), tz, next === null ? null : new Date(next).toISOString()]);
    }
  }

  // ── CRUD ──────────────────────────────────────────────────────────────────

  async function list(accountId) {
    const { rows } = await db.query(
      `SELECT * FROM automations WHERE account_id = $1 ORDER BY updated_at DESC`, [accountId]);
    const out = [];
    for (const a of rows) {
      const { rows: trig } = await db.query(
        `SELECT kind, filter FROM automation_triggers WHERE automation_id = $1 ORDER BY kind, filter`, [a.id]);
      // The latest run, so a list can show an outcome without N round trips.
      const { rows: [latest] } = await db.query(
        `SELECT * FROM automation_runs WHERE automation_id = $1 ORDER BY created_at DESC LIMIT 1`, [a.id]);
      out.push({ ...rowOut(a, trig), latestRun: latest ? runOut(latest) : null });
    }
    return { automations: out };
  }

  async function get(accountId, id) {
    return db.tx(async (t) => {
      const a = await loadOwned(t, accountId, id);
      return { automation: rowOut(a, await triggersOf(t, id)) };
    });
  }

  async function create(accountId, body = {}) {
    validate(body);
    const id = randomUUID();
    return db.tx(async (t) => {
      await t.query(
        `INSERT INTO automations (id, account_id, machine_id, directory, name, enabled, spec)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [id, accountId, str(body.machineId), str(body.directory), str(body.name),
         body.enabled === undefined ? true : !!body.enabled, body.spec]);
      await writeTriggers(t, id, body.triggers);
      const a = await loadOwned(t, accountId, id);
      return { automation: rowOut(a, await triggersOf(t, id)) };
    });
  }

  /** Partial update. `expectedSpecVersion` makes the spec write conditional —
   *  two devices editing one automation is the same race the machine record
   *  already answers this way. */
  async function patch(accountId, id, body = {}) {
    return db.tx(async (t) => {
      const a = await loadOwned(t, accountId, id);
      if (body.expectedSpecVersion !== undefined && body.expectedSpecVersion !== null) {
        const expect = Number(body.expectedSpecVersion);
        if (!Number.isInteger(expect)) throw new ApiError(400, 'bad_expected_spec_version');
        if (expect !== Number(a.spec_version)) {
          throw new ApiError(409, { error: 'spec_version_mismatch', specVersion: Number(a.spec_version) });
        }
      }
      if (body.spec !== undefined) {
        if (!str(body.spec)) throw new ApiError(400, 'missing_spec');
        if (body.spec.length > MAX_SPEC_CHARS) throw new ApiError(413, 'spec_too_large');
      }
      if (body.name !== undefined && !str(body.name)) throw new ApiError(400, 'missing_name');
      if (body.directory !== undefined && !str(body.directory)) throw new ApiError(400, 'missing_directory');
      if (body.machineId !== undefined && !str(body.machineId)) throw new ApiError(400, 'missing_machine_id');

      await t.query(
        `UPDATE automations SET
           name = COALESCE($2, name),
           directory = COALESCE($3, directory),
           machine_id = COALESCE($4, machine_id),
           enabled = COALESCE($5, enabled),
           spec = COALESCE($6, spec),
           spec_version = CASE WHEN $6::text IS NULL THEN spec_version ELSE spec_version + 1 END,
           updated_at = now()
         WHERE id = $1`,
        [id,
         body.name === undefined ? null : str(body.name),
         body.directory === undefined ? null : str(body.directory),
         body.machineId === undefined ? null : str(body.machineId),
         body.enabled === undefined ? null : !!body.enabled,
         body.spec === undefined ? null : body.spec]);

      if (body.triggers !== undefined) {
        if (!Array.isArray(body.triggers) || body.triggers.length === 0) throw new ApiError(400, 'missing_triggers');
        if (body.triggers.length > MAX_TRIGGERS) throw new ApiError(400, 'too_many_triggers');
        for (const trig of body.triggers) {
          if (!trig || !TRIGGER_KINDS.has(trig.kind)) throw new ApiError(400, 'bad_trigger_kind');
        }
        await writeTriggers(t, id, body.triggers);
      }
      const updated = await loadOwned(t, accountId, id);
      return { automation: rowOut(updated, await triggersOf(t, id)) };
    });
  }

  /** The automation and its run history go; the SESSIONS its runs produced do
   *  not. Those are ordinary sessions with their own lifecycle, and deleting
   *  the thing that scheduled them is not a reason to destroy the work. */
  async function remove(accountId, id) {
    return db.tx(async (t) => {
      await loadOwned(t, accountId, id);
      await t.query(`DELETE FROM automation_triggers WHERE automation_id = $1`, [id]);
      await t.query(`DELETE FROM automation_runs WHERE automation_id = $1`, [id]);
      await t.query(`DELETE FROM automations WHERE id = $1`, [id]);
      return { ok: true };
    });
  }

  // ── runs ──────────────────────────────────────────────────────────────────

  /**
   * Fire one run.
   *
   * Two refusals worth naming, because both are recorded rather than silent:
   * a disabled automation refuses outright (409), and one whose previous run
   * is still going records a `cancelled` run with `error_code
   * 'skipped_overlap'`. Overlap is nearly always a mistake — an automation
   * triggering itself faster than it finishes — and a history that shows the
   * skip is far easier to debug than one where firings simply vanish.
   */
  async function trigger(accountId, actorId, id, opts = {}) {
    const triggerKind = TRIGGER_KINDS.has(opts.triggerKind) ? opts.triggerKind : 'manual';
    const prepared = await db.tx(async (t) => {
      const a = await loadOwned(t, accountId, id);
      if (!a.enabled) throw new ApiError(409, 'automation_disabled');

      const { rows: [live] } = await t.query(
        `SELECT id FROM automation_runs WHERE automation_id = $1 AND state = ANY($2) LIMIT 1`,
        [id, LIVE_RUN_STATES]);
      const runId = randomUUID();
      if (live) {
        await t.query(
          `INSERT INTO automation_runs (id, automation_id, account_id, state, trigger_kind, error_code, error_message, finished_at)
           VALUES ($1,$2,$3,'cancelled',$4,'skipped_overlap',$5, now())`,
          [runId, id, accountId, triggerKind, `run ${live.id} is still going`]);
        const { rows: [r] } = await t.query(`SELECT * FROM automation_runs WHERE id = $1`, [runId]);
        return { skipped: true, run: runOut(r) };
      }
      await t.query(
        `INSERT INTO automation_runs (id, automation_id, account_id, state, trigger_kind)
         VALUES ($1,$2,$3,'queued',$4)`,
        [runId, id, accountId, triggerKind]);
      return { skipped: false, runId, automation: a };
    });
    if (prepared.skipped) return { run: prepared.run, skipped: true };

    // Outside the transaction: createSession runs its own, and a spawn that
    // fails must leave the run recorded as failed rather than roll away.
    const a = prepared.automation;
    try {
      const created = await core.createSession(accountId, actorId, {
        mode: 'spawn',
        daemonId: a.machine_id,
        // Namespaced so the daemon can tell an automation run from an
        // ordinary spawn without a schema change or a new wire field: the
        // intent id IS the run, and saying so costs nothing. Still unique,
        // so the relay's existing idempotency still means one run, one spawn.
        creationIntentId: `${AUTOMATION_INTENT_PREFIX}${prepared.runId}`,
        spawnSpec: a.spec,
      });
      const { rows: [r] } = await db.query(
        `UPDATE automation_runs SET state = 'running', session_id = $2, started_at = now()
         WHERE id = $1 RETURNING *`, [prepared.runId, created.sessionId]);
      await db.query(`UPDATE automations SET last_run_at = now() WHERE id = $1`, [a.id]);
      return { run: runOut(r) };
    } catch (e) {
      const code = e instanceof ApiError ? String(e.code?.error ?? e.code) : 'spawn_failed';
      const { rows: [r] } = await db.query(
        `UPDATE automation_runs SET state = 'failed', error_code = $2, error_message = $3, finished_at = now()
         WHERE id = $1 RETURNING *`, [prepared.runId, code, String(e?.message ?? e).slice(0, 500)]);
      return { run: runOut(r) };
    }
  }

  /** The daemon's word on how a run ended. Terminal states are final: a late
   *  report cannot move a finished run, which is what keeps a retried report
   *  (or a second daemon) from rewriting history. */
  async function report(accountId, runId, body = {}) {
    const state = str(body.state);
    if (!['running', 'succeeded', 'failed', 'cancelled'].includes(state)) throw new ApiError(400, 'bad_run_state');
    // Collected inside, fired outside — a chained automation spawns a session.
    const chained = [];
    const out = await db.tx(async (t) => {
      const { rows: [r] } = await t.query(`SELECT * FROM automation_runs WHERE id = $1`, [runId]);
      if (!r || r.account_id !== accountId) throw new ApiError(404, 'run_not_found');
      if (['succeeded', 'failed', 'cancelled'].includes(r.state)) {
        return { run: runOut(r), alreadyFinal: true };
      }
      const finished = state !== 'running';
      const { rows: [updated] } = await t.query(
        `UPDATE automation_runs SET state = $2, error_code = $3, error_message = $4,
           finished_at = CASE WHEN $5 THEN now() ELSE finished_at END
         WHERE id = $1 RETURNING *`,
        [runId, state, str(body.errorCode) || null, str(body.errorMessage) || null, finished]);
      if (finished) chained.push({ automationId: updated.automation_id, state });
      return { run: runOut(updated) };
    });
    for (const c of chained) {
      // `automation_done` fires with the FINISHED automation's id as the
      // filter, so a chain is written as "when THAT one ends, run this".
      void onEvent('automation_done', { accountId, filters: [c.automationId] });
    }
    return out;
  }

  async function listRuns(accountId, id, limit) {
    const n = Math.min(RUN_HISTORY_MAX, Math.max(1, Number(limit) || RUN_HISTORY_DEFAULT));
    return db.tx(async (t) => {
      await loadOwned(t, accountId, id);
      const { rows } = await t.query(
        `SELECT * FROM automation_runs WHERE automation_id = $1 ORDER BY created_at DESC LIMIT $2`, [id, n]);
      return { runs: rows.map(runOut) };
    });
  }

  /** Every failure the user has not dismissed — what the sidebar's top tier
   *  renders, and the reason `acknowledged_at` exists at all. */
  async function unacknowledgedFailures(accountId) {
    const { rows } = await db.query(
      `SELECT r.*, a.name AS automation_name FROM automation_runs r
       JOIN automations a ON a.id = r.automation_id
       WHERE r.account_id = $1 AND r.state = 'failed' AND r.acknowledged_at IS NULL
       ORDER BY r.created_at DESC LIMIT 100`, [accountId]);
    return { failures: rows.map((r) => ({ ...runOut(r), automationName: r.automation_name })) };
  }

  async function acknowledge(accountId, runId) {
    const { rows: [r] } = await db.query(
      `UPDATE automation_runs SET acknowledged_at = now()
       WHERE id = $1 AND account_id = $2 RETURNING *`, [runId, accountId]);
    if (!r) throw new ApiError(404, 'run_not_found');
    return { run: runOut(r) };
  }

  // ── the clock ─────────────────────────────────────────────────────────────

  /**
   * Fire every schedule that is due, and decide what to do about the ones
   * that came due while nobody was listening.
   *
   * The catch-up question is the whole reason a scheduler is more awkward
   * than a trigger. A machine offline for a week on a five-minute schedule
   * owes 2,016 firings when it comes back, and there are three answers:
   * replay them all (a stampede), forget them (a silent hole), or fire once
   * and SAY what was skipped.
   *
   * Joy does the third, the same way an overlapping firing is handled: the
   * run that happens is a real run, and the ones that did not are recorded
   * as `cancelled` with `missed_schedule` and a count. A firing that did
   * nothing still happened, and a history with holes in it cannot be
   * debugged.
   */
  async function tick(nowMs = Date.now()) {
    const now = new Date(nowMs).toISOString();
    const { rows: due } = await db.query(
      `SELECT t.automation_id, t.filter, t.timezone, t.next_run_at, a.account_id, a.enabled
       FROM automation_triggers t
       JOIN automations a ON a.id = t.automation_id
       WHERE t.kind = 'schedule' AND t.next_run_at IS NOT NULL AND t.next_run_at <= $1
       ORDER BY t.next_run_at`, [now]);

    let fired = 0;
    let skipped = 0;
    for (const row of due) {
      const tz = row.timezone || 'UTC';
      const wasDueAt = new Date(row.next_run_at).getTime();
      // Advance the clock FIRST. A schedule whose run throws must not be
      // retried every tick forever — the next occurrence is the next
      // occurrence whatever happened to this one.
      let next = null;
      try { next = nextCronAfter(row.filter, tz, nowMs); } catch { next = null; }
      await db.query(
        `UPDATE automation_triggers SET next_run_at = $4
         WHERE automation_id = $1 AND kind = 'schedule' AND filter = $2 AND next_run_at = $3`,
        [row.automation_id, row.filter, row.next_run_at, next === null ? null : new Date(next).toISOString()]);

      if (!row.enabled) continue;

      // Everything between the occurrence that was due and now, minus the one
      // we are about to run.
      let missed = 0;
      try {
        missed = Math.max(0, cronOccurrencesBetween(row.filter, tz, wasDueAt, nowMs, CATCH_UP_CAP).length);
      } catch { missed = 0; }

      try {
        await trigger(row.account_id, 'schedule', row.automation_id, { triggerKind: 'schedule' });
        fired++;
      } catch { /* disabled or vanished between the scan and here */ }

      if (missed > 0) {
        skipped += missed;
        // Recorded, not replayed. The count is the honest thing to keep: what
        // matters is that the schedule was not running, not 2,016 identical
        // rows saying so.
        await db.query(
          `INSERT INTO automation_runs (id, automation_id, account_id, state, trigger_kind, error_code, error_message, finished_at)
           VALUES ($1,$2,$3,'cancelled','schedule','missed_schedule',$4, now())`,
          [randomUUID(), row.automation_id, row.account_id,
           `${missed}${missed >= CATCH_UP_CAP ? '+' : ''} occurrence${missed === 1 ? '' : 's'} passed while nothing was listening; ran once instead`]);
      }
    }
    return { fired, skipped };
  }

  // ── triggers ──────────────────────────────────────────────────────────────

  /**
   * An event happened; fire whatever listens for it.
   *
   * This is the whole scheduler. There is no clock and no cron: a trigger is a
   * subscription to events the relay already writes, evaluated when they
   * happen. Dropping cron dropped the timezone column, DST, and the question
   * of what to do when a machine has been offline for a week — an interval
   * scheduler owes 2,016 firings on reconnect, and a `machine_online` trigger
   * owes exactly one.
   *
   * Never throws and never blocks the caller: core fires this after its
   * transaction commits and ignores the result. A trigger that cannot run is
   * recorded as a failed run, not an exception in somebody else's write.
   */
  async function onEvent(kind, ctx = {}) {
    if (!TRIGGER_KINDS.has(kind) || kind === 'manual') return { fired: 0 };
    if (!ctx.accountId) return { fired: 0 };
    try {
      // A session an automation PRODUCED must not fire triggers back into it.
      // turn_done on a run whose own turn just finished is an infinite loop,
      // and automation_done makes a cycle trivial to write by accident. One
      // rule, checked here rather than trusted from the caller, closes both.
      if (ctx.sessionId) {
        const { rows: [own] } = await db.query(
          `SELECT id FROM automation_runs WHERE session_id = $1 LIMIT 1`, [ctx.sessionId]);
        if (own) return { fired: 0 };
      }

      // The filter narrows: a machine id for machine_online and turn_done, an
      // automation id for automation_done. An empty filter means "any".
      const named = [ctx.machineId, ...(ctx.filters ?? [])].filter((f) => typeof f === 'string' && f);
      const filters = ['', ...named];
      const { rows } = await db.query(
        `SELECT a.id FROM automations a
         JOIN automation_triggers t ON t.automation_id = a.id
         WHERE a.account_id = $1 AND a.enabled = TRUE AND t.kind = $2 AND t.filter = ANY($3)`,
        [ctx.accountId, kind, filters]);

      let fired = 0;
      for (const { id } of rows) {
        try {
          await trigger(ctx.accountId, ctx.actorId ?? 'automation', id, { triggerKind: kind });
          fired++;
        } catch { /* a disabled or vanished automation is not this event's problem */ }
      }
      return { fired };
    } catch {
      return { fired: 0 };
    }
  }

  return { list, get, create, patch, remove, trigger, report, listRuns, unacknowledgedFailures, acknowledge, onEvent, tick };
}
