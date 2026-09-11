// What must be true of the relay's state after every step, and of the relay
// and the daemons' ledgers TOGETHER — the two-sides-agree properties that
// no single-process test can state. Each check answers a list of violation
// strings; empty means it holds. The engine runs them after each step and
// stops at the first violation with the trace as the reproduction.
//
// Every check names the rule it enforces and where the relay states it, so
// a violation reads as "this rule, broken here", not as a failed assertion.

const EXECUTING = new Set(['dispatching', 'running', 'cancelling', 'orphaned']);
const LIVE = new Set(['dispatching', 'running', 'cancelling']);

/** One consistent read of everything the checks need. */
export async function readState(world) {
  const q = async (sql, params) => (await world.db.query(sql, params)).rows;
  const [sessions, turns, commands, deliveries, leases, eventStats] = await Promise.all([
    q(`SELECT * FROM native_sessions`),
    q(`SELECT * FROM turns`),
    q(`SELECT * FROM commands`),
    q(`SELECT * FROM deliveries`),
    q(`SELECT *, (expires_at < now()) AS is_expired FROM daemon_leases ORDER BY acquired_at`),
    q(`SELECT session_id, count(*)::int AS n, max(seq) AS max_seq, min(seq) AS min_seq FROM session_events GROUP BY session_id`),
  ]);
  const byId = (rows) => new Map(rows.map((r) => [r.id, r]));
  const turnsBySession = new Map();
  for (const t of turns) { const l = turnsBySession.get(t.session_id) ?? []; l.push(t); turnsBySession.set(t.session_id, l); }
  const currentLease = new Map(); // daemon_id -> the unreleased lease (or undefined)
  for (const l of leases) if (!l.released_at) currentLease.set(l.daemon_id, l);
  return {
    sessions, turns, commands, deliveries, leases, eventStats,
    session: byId(sessions), turn: byId(turns), command: byId(commands), turnsBySession, currentLease,
  };
}

/** The daemon holds a lease the RELAY still honours: alive, the lease it
 *  remembers is the daemon's current one, and the clock has not passed its
 *  expiry. A daemon that stopped renewing is presumed dead by design — its
 *  work is orphaned and the ledger it still holds no longer binds the relay. */
function leaseLive(S, d) {
  if (!d.alive || !d.lease) return false;
  const l = S.currentLease.get(d.id);
  return !!l && l.id === d.lease.leaseId && !l.is_expired;
}

const INVARIANTS = [
  {
    name: 'one_executing_turn_per_session',
    doc: 'turns_one_executing index (migration 002): at most one dispatching/running/cancelling/orphaned turn per session',
    check(S) {
      const out = [];
      for (const [sid, ts] of S.turnsBySession) {
        const ex = ts.filter((t) => EXECUTING.has(t.state));
        if (ex.length > 1) out.push(`session ${sid}: ${ex.length} executing turns (${ex.map((t) => `${t.id.slice(0, 8)}:${t.state}`).join(', ')})`);
      }
      return out;
    },
  },
  {
    name: 'active_turn_points_at_executing_turn',
    doc: 'native_sessions.active_turn_id is set by /start and adoption and cleared by terminalization; while set it names a running/cancelling/orphaned turn of that session',
    check(S) {
      const out = [];
      for (const s of S.sessions) {
        if (!s.active_turn_id) continue;
        const t = S.turn.get(s.active_turn_id);
        if (!t || t.session_id !== s.id) out.push(`session ${s.id}: active_turn_id ${s.active_turn_id} is not one of its turns`);
        else if (!['running', 'cancelling', 'orphaned'].includes(t.state)) out.push(`session ${s.id}: active_turn_id ${t.id.slice(0, 8)} is ${t.state}`);
      }
      return out;
    },
  },
  {
    name: 'terminal_iff_terminal_state',
    doc: 'terminalizeTurn sets both; nothing sets one without the other',
    check(S) {
      return S.turns.filter((t) => (t.state === 'terminal') !== (t.terminal_state != null))
        .map((t) => `turn ${t.id.slice(0, 8)}: state=${t.state} terminal_state=${t.terminal_state}`);
    },
  },
  {
    name: 'one_current_lease_per_daemon_and_epochs_increase',
    doc: 'daemon_leases_current index; acquireLease releases the previous lease and takes epoch+1',
    check(S) {
      const out = [];
      const seen = new Map();
      for (const l of S.leases) {
        const prev = seen.get(l.daemon_id);
        if (prev && Number(l.epoch) <= Number(prev.epoch)) out.push(`daemon ${l.daemon_id}: epoch ${l.epoch} after ${prev.epoch}`);
        if (prev && !prev.released_at && !l.released_at) out.push(`daemon ${l.daemon_id}: two unreleased leases (${prev.epoch}, ${l.epoch})`);
        seen.set(l.daemon_id, l);
      }
      return out;
    },
  },
  {
    name: 'live_delivery_only_for_head_or_executing',
    doc: 'claimWork offers only the queue head; an edit, a move or an archive supersedes deliveries of everything else. A prompt delivery with disposition NULL belongs to the head queued turn, an executing turn, or a terminal turn whose delivery nobody superseded.',
    check(S) {
      const out = [];
      for (const d of S.deliveries) {
        if (d.disposition) continue;
        const c = S.command.get(d.command_id);
        if (!c || c.kind !== 'prompt') continue;
        const t = S.turn.get(c.turn_id);
        if (!t || t.state !== 'queued') continue;
        const head = S.turnsBySession.get(t.session_id).filter((x) => x.state === 'queued').sort((a, b) => Number(a.request_seq) - Number(b.request_seq))[0];
        if (head.id !== t.id) out.push(`delivery ${d.id.slice(0, 8)} live for queued non-head turn ${t.id.slice(0, 8)} (head ${head.id.slice(0, 8)})`);
      }
      return out;
    },
  },
  {
    name: 'command_state_agrees_with_turn_state',
    doc: 'a queued/dispatching turn has a queued|delivered prompt command; running ⇒ applied (turn.start applies it; adoption too) — cancelling may still carry a delivered command when the cancel landed during dispatch; cancelled-before-start/by-barrier/by-archive ⇒ command cancelled',
    check(S) {
      const out = [];
      for (const t of S.turns) {
        const c = S.command.get(t.prompt_command_id);
        if (!c) { out.push(`turn ${t.id.slice(0, 8)}: prompt command missing`); continue; }
        const bad = (why) => out.push(`turn ${t.id.slice(0, 8)} ${t.state}${t.terminal_state ? ':' + t.terminal_state : ''} vs command ${c.state}/${c.disposition}: ${why}`);
        if ((t.state === 'queued' || t.state === 'dispatching') && !['queued', 'delivered'].includes(c.state)) bad('open turn with a settled command');
        if (t.state === 'running' && c.state !== 'applied') bad('running turn with an unapplied command');
        if (t.state === 'cancelling' && !['applied', 'delivered', 'queued'].includes(c.state)) bad('cancelling turn with a settled command');
        if (t.state === 'terminal' && t.terminal_state === 'cancelled' && t.terminal_meta?.mode && !['cancelled', 'applied'].includes(c.state)) bad('cancelled turn with a live command');
      }
      return out;
    },
  },
  {
    name: 'session_state_bounds_turns',
    doc: 'provisioning/failed sessions accept no prompts (session_not_ready); archiving cancels every queued turn in the same transaction (#614)',
    check(S) {
      const out = [];
      for (const s of S.sessions) {
        const ts = S.turnsBySession.get(s.id) ?? [];
        if ((s.state === 'provisioning') && ts.length) out.push(`session ${s.id} ${s.state} has ${ts.length} turns`);
        if (s.state === 'archived' && ts.some((t) => t.state === 'queued')) out.push(`archived session ${s.id} still has queued turns`);
      }
      return out;
    },
  },
  {
    name: 'event_seq_dense',
    doc: 'nextSeq allocates next_seq-1 and every caller appends exactly one event in the same transaction: seqs are 1..next_seq-1 with no holes',
    check(S) {
      const out = [];
      for (const e of S.eventStats) {
        const s = S.session.get(e.session_id);
        const expect = Number(s.next_seq) - 1;
        if (Number(e.n) !== expect || Number(e.max_seq) !== expect || Number(e.min_seq) !== 1) {
          out.push(`session ${e.session_id}: ${e.n} events, seq ${e.min_seq}..${e.max_seq}, next_seq ${s.next_seq}`);
        }
      }
      return out;
    },
  },
  {
    name: 'recovery_required_implies_orphan',
    doc: 'the sweep sets recovery_required when it orphans; reconcile (either resolution) and message retry clear it',
    check(S) {
      return S.sessions.filter((s) => s.recovery_required && !(S.turnsBySession.get(s.id) ?? []).some((t) => t.state === 'orphaned'))
        .map((s) => `session ${s.id}: recovery_required with no orphaned turn`);
    },
  },
  {
    name: 'post_sweep_no_executing_turn_under_dead_epoch',
    doc: 'sweepExpiredLeases orphans every dispatching/running/cancelling turn whose daemon lease is gone, expired, or older than the current epoch — checked only right after a sweep',
    afterAction: 'sweep',
    check(S) {
      const out = [];
      for (const t of S.turns) {
        if (!LIVE.has(t.state)) continue;
        const s = S.session.get(t.session_id);
        const l = S.currentLease.get(s.owner_daemon_id);
        if (!l || l.is_expired || t.lease_epoch == null || Number(t.lease_epoch) < Number(l.epoch)) {
          out.push(`turn ${t.id.slice(0, 8)} ${t.state} under epoch ${t.lease_epoch}, lease ${l ? `${l.epoch}${l.is_expired ? ' expired' : ''}` : 'none'}`);
        }
      }
      return out;
    },
  },
  // ── relay ↔ daemon ledger ─────────────────────────────────────────────
  {
    name: 'daemon_started_implies_relay_running',
    doc: 'a daemon that got 200 from /start (or adopted the turn) under its CURRENT lease holds a turn the relay has as running/cancelling under that epoch — nothing but the owner\'s terminal fact closes an executing turn while its lease lives',
    check(S, { daemons }) {
      const out = [];
      for (const d of daemons) {
        if (!leaseLive(S, d)) continue;
        for (const row of d.ledger.values()) {
          // 'waived': the machine let the runtime finish without a /start the
          // relay would take (the relay has its answer); the relay may hold
          // the turn dispatching until the terminal fact.
          if (row.state !== 'started' || row.epoch !== d.lease.epoch) continue;
          // The terminal fact is on the wire (sent, answer not yet seen):
          // the relay may already have closed the turn.
          if (row.terminalState) continue;
          const t = S.turn.get(row.turnId);
          if (!t) { out.push(`${d.label}: started turn ${row.turnId.slice(0, 8)} unknown to the relay`); continue; }
          if (!['running', 'cancelling'].includes(t.state) || String(t.lease_epoch) !== d.lease.epoch) {
            out.push(`${d.label}: ledger has ${row.turnId.slice(0, 8)} started under epoch ${row.epoch}; relay has ${t.state}${t.terminal_state ? ':' + t.terminal_state : ''} under epoch ${t.lease_epoch}`);
          }
        }
      }
      return out;
    },
  },
  {
    name: 'relay_running_under_live_epoch_implies_daemon_worker',
    doc: 'a turn the relay has running/cancelling under a daemon\'s CURRENT lease is one that daemon\'s ledger holds as submitted, started, or owing a cancel (a lost /start answer leaves it submitted until the retry replays) — otherwise the relay authorizes work nobody is doing. An archived/failed session is exempt: its executing turn is closed by the owner\'s terminal or the sweep, and nothing new can queue behind it',
    check(S, { daemons }) {
      const out = [];
      for (const d of daemons) {
        if (!leaseLive(S, d)) continue;
        for (const t of S.turns) {
          if (!['running', 'cancelling'].includes(t.state)) continue;
          const s = S.session.get(t.session_id);
          if (s.owner_daemon_id !== d.id || String(t.lease_epoch) !== d.lease.epoch) continue;
          if (s.state === 'archived' || s.state === 'failed') continue;
          const row = d.ledger.get(t.id);
          if (!row || !['submitted', 'started', 'waived', 'terminal_owed'].includes(row.state)) {
            out.push(`${d.label}: relay has ${t.id.slice(0, 8)} ${t.state} under its epoch ${d.lease.epoch}; ledger has ${row ? row.state : 'nothing'}`);
          }
        }
      }
      return out;
    },
  },
  {
    name: 'daemon_terminal_implies_relay_terminal',
    doc: 'once the terminal fact is acknowledged (200, or 409 turn_terminal) the relay turn is terminal',
    check(S, { daemons }) {
      const out = [];
      for (const d of daemons) {
        for (const row of d.ledger.values()) {
          if (row.state !== 'terminal') continue;
          const t = S.turn.get(row.turnId);
          if (t && t.state !== 'terminal') out.push(`${d.label}: ledger closed ${row.turnId.slice(0, 8)} ${row.terminalState}; relay has ${t.state}`);
        }
      }
      return out;
    },
  },
];

export class InvariantViolation extends Error {
  constructor(violations) {
    super(`invariant violation:\n${violations.map((v) => `  [${v.name}] ${v.detail}\n      rule: ${v.doc}`).join('\n')}`);
    this.violations = violations;
  }
}

/** Run every applicable check; throw on the first non-empty set. */
export async function checkInvariants(world, actors, { afterAction = null } = {}) {
  const S = await readState(world);
  const violations = [];
  for (const inv of INVARIANTS) {
    if (inv.afterAction && inv.afterAction !== afterAction) continue;
    for (const detail of inv.check(S, actors)) violations.push({ name: inv.name, doc: inv.doc, detail });
  }
  if (violations.length) throw new InvariantViolation(violations);
  return S;
}

export const INVARIANT_NAMES = INVARIANTS.map((i) => i.name);
