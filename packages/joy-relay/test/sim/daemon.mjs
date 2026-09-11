// A daemon as the relay sees it — a legal client of the daemon protocol with
// the three layers the real one has, because crashes cut between them:
//
//   disk     the ledger (turns it acknowledged, and how far each got) and
//            the window records (sessions it owns). Survives everything.
//   memory   the lease and the offers it has claimed but not yet
//            acknowledged. Lost when the process dies.
//   runtime  the agents (tmux keeps them alive across a daemon crash, a
//            machine reboot takes them too).
//
// Each method is one protocol step from the daemon's point of view, with the
// response handled the way nucleusLane.ts handles it: a superseded delivery
// is dropped, a cancel-class refusal at /start interrupts the agent, a lease
// death parks everything until a new lease, a turn inherited from an earlier
// incarnation is reconciled — adopted when the agent still runs, closed as
// interrupted when it doesn't. The methods never throw on a 4xx: a 4xx is an
// answer, and what the daemon does with it is the behaviour under test.
//
// `actions()` lists what this daemon could do next; the engine picks.
//
// The TURN decisions are not this file's: every relay answer about a turn is
// an event to the real daemon's turn machine (joy-daemon/src/relay/
// relayTurnMachine.ts — the module nucleusLane.ts drives), and this daemon
// does what the transition says: its effects (cancel locally, adopt, cancel
// the command) are the actions it takes next, its phase is checked against
// the ledger row after every event (`ModelDisagreement` stops the run), and
// an event the machine answers null to is what the real lane treats as a
// lane error. So a campaign exercises the daemon's protocol logic as
// shipped, against the relay as shipped, under the sim's faults.
import {
  nextTurnState, initialTurnState, resumedTurnState, projectTurnState, START_CANCEL_CLASS,
} from '../../../joy-daemon/src/relay/relayTurnMachine.ts';

export class ModelDisagreement extends Error {
  constructor(daemon, row, why) {
    super(`${daemon}: ledger row ${row.turnId.slice(0, 8)} is '${row.state}' but the turn machine is ${JSON.stringify(row.turn)} — ${why}`);
  }
}

const LEASE_DEATH = new Set(['lease_unknown', 'lease_expired', 'lease_epoch_stale', 'missing_lease_credentials']);

export class SimDaemon {
  constructor(world, daemonId, { token = 'app-token' } = {}) {
    this.world = world;
    this.id = daemonId;
    this.token = token;
    // disk
    this.ledger = new Map();   // turnId -> row
    this.records = new Map();  // relaySessionId -> { localSessionId, archived }
    this.nextLocal = 1;
    this.pendingAnnounce = null; // an announce whose answer never came
    // memory
    this.alive = true;
    this.lease = null;         // { leaseId, token, epoch }
    this.offers = new Map();   // deliveryId -> offer (claimed, unacked)
    // runtime
    this.runtime = new Map();  // turnId -> 'executing' | 'done'
  }

  get label() { return `daemon:${this.id}`; }
  headers() {
    return { 'x-joy-lease-id': this.lease.leaseId, 'x-joy-lease-token': this.lease.token, 'x-joy-lease-epoch': this.lease.epoch };
  }
  call(method, path, opts = {}) { return this.world.call(this.label, method, path, { token: this.token, ...opts }); }

  /** A lease-death answer: forget the lease; the next acquire fences a new epoch. */
  leaseDied(r) {
    if (r.status === 401 || r.status === 412 || LEASE_DEATH.has(r.code)) { this.lease = null; this.offers.clear(); this.forgetTurns(); return true; }
    return false;
  }
  /** Memory goes: every open turn's machine state with it. The LEDGER row
   *  stays, and the next lease resumes each open turn from it. */
  forgetTurns() {
    for (const row of this.ledger.values()) {
      if (['submitted', 'started', 'waived', 'terminal_owed'].includes(row.state)) { row.resumed = false; row.adoptOwed = false; }
    }
  }

  // ── lifecycle of the process ─────────────────────────────────────────────

  /** The process dies. Memory goes; disk and the agents stay. */
  crash() { this.alive = false; this.lease = null; this.offers.clear(); this.forgetTurns(); return { status: 0, code: 'crashed' }; }
  /** The machine goes down: crash plus every agent. */
  reboot() { this.crash(); this.runtime.clear(); return { status: 0, code: 'rebooted' }; }
  /** The process comes back (a new lease is the first thing it does). */
  async restart() { this.alive = true; return this.acquire(); }

  // ── lease ────────────────────────────────────────────────────────────────

  async acquire() {
    const r = await this.call('POST', '/joy/v2/daemon/leases', { body: { machineId: this.id } });
    if (r.status === 200) this.lease = { leaseId: r.json.leaseId, token: r.json.leaseToken, epoch: String(r.json.epoch) };
    return r;
  }
  async renew() {
    const r = await this.call('PUT', `/joy/v2/daemon/leases/${this.lease.leaseId}`, { headers: { 'x-joy-lease-token': this.lease.token } });
    if (r.status !== 200) this.leaseDied(r);
    return r;
  }

  // ── sessions ─────────────────────────────────────────────────────────────

  /** A session that already runs on this machine, announced to the relay. */
  async announce() {
    // The same intent until it is answered: a lost answer means the relay
    // may already hold the session, and the retry must replay, not double.
    const localSessionId = this.pendingAnnounce ?? `local-${this.id}-${this.nextLocal++}`;
    this.pendingAnnounce = localSessionId;
    const r = await this.call('POST', '/joy/v2/sessions', {
      body: { mode: 'announce_existing', creationIntentId: `announce:${localSessionId}`, daemonId: this.id, localSessionId, sessionKeyEnvelope: 'wrapped-key' },
    });
    this.pendingAnnounce = null;
    if (r.status === 200) this.records.set(r.json.sessionId, { localSessionId, archived: false });
    return r;
  }
  async bind(offer) {
    const ack = await this.ack(offer);
    if (ack.status !== 200) return ack;
    const localSessionId = `local-${this.id}-${this.nextLocal++}`;
    const r = await this.call('POST', `/joy/v2/daemon/sessions/${offer.sessionId}/bind`, {
      body: { spawnCommandId: offer.commandId, localSessionId, sessionKeyEnvelope: 'wrapped-key' }, headers: this.headers(),
    });
    if (r.status === 200) this.records.set(offer.sessionId, { localSessionId, archived: false });
    else this.leaseDied(r);
    return r;
  }
  async spawnFail(offer) {
    const ack = await this.ack(offer);
    if (ack.status !== 200) return ack;
    const r = await this.call('POST', `/joy/v2/daemon/sessions/${offer.sessionId}/spawn-failed`, {
      body: { reason: 'dir_missing:/sim', deliveryId: offer.deliveryId }, headers: this.headers(),
    });
    this.leaseDied(r);
    return r;
  }
  /** The agent has exited and the daemon closes the session. Only when no
   *  turn of it is still running here — the real daemon archives on exit. */
  async archive(sessionId) {
    const r = await this.call('PATCH', `/joy/v2/daemon/sessions/${sessionId}`, { body: { state: 'archived' }, headers: this.headers() });
    if (r.status === 200) this.records.get(sessionId).archived = true;
    else this.leaseDied(r);
    return r;
  }

  // ── claims ───────────────────────────────────────────────────────────────

  async claim(lane) {
    const r = await this.call('POST', `/joy/v2/daemon/leases/${this.lease.leaseId}/claims/${lane}`, {
      body: { noWait: true }, headers: { 'x-joy-lease-token': this.lease.token },
    });
    if (r.status !== 200) { this.leaseDied(r); return r; }
    for (const offer of r.json.offers ?? []) {
      // The same delivery again (an acknowledged head the daemon has not
      // submitted yet is re-offered on every claim): nothing new to do. A
      // NEW delivery of a turn already in the ledger — after a new lease,
      // or a requeue — must be acknowledged; ack() sorts the row out.
      if (offer.kind === 'prompt' && this.ledger.get(offer.turnId)?.deliveryId === offer.deliveryId) continue;
      this.offers.set(offer.deliveryId, offer);
    }
    return r;
  }
  async ack(offer) {
    const r = await this.call('POST', `/joy/v2/daemon/deliveries/${offer.deliveryId}/received`, { headers: this.headers() });
    this.offers.delete(offer.deliveryId);
    if (r.status === 200) {
      if (offer.kind === 'prompt') {
        const row = this.ledger.get(offer.turnId);
        const fresh = { deliveryId: offer.deliveryId, state: 'received', submittedAcked: false, cancelRequested: false, terminalState: null, epoch: this.lease.epoch, turn: initialTurnState(), adoptOwed: false, resumed: false };
        if (!row) {
          this.ledger.set(offer.turnId, { turnId: offer.turnId, sessionId: offer.sessionId, commandId: offer.commandId, ...fresh });
        } else if (row.deliveryId !== offer.deliveryId) {
          // A new attempt of a turn this daemon knew: the relay has it queued
          // again (a requeue after an orphan, or a claim under a new lease
          // before the old attempt was ever submitted). Whatever agent ran
          // the old attempt is no longer the one the relay is asking for.
          this.runtime.delete(offer.turnId);
          Object.assign(row, fresh);
        } else { row.epoch = this.lease.epoch; }
        const row2 = this.ledger.get(offer.turnId);
        if (row2.turn.phase === 'offered') this.step(row2, { type: 'received_ok' });
      } else if (offer.kind === 'cancel') {
        const row = this.ledger.get(offer.targetTurnId);
        if (row && row.state !== 'terminal' && row.state !== 'dropped') {
          row.cancelRequested = true;
          this.step(row, { type: 'cancel_requested' });
        }
      }
      return r;
    }
    if (r.status === 409) {
      // delivery_superseded: the message changed under the offer (an edit,
      // a move, an archive). Whatever this daemon had of it is stale.
      const row = offer.kind === 'prompt' ? this.ledger.get(offer.turnId) : null;
      if (row && row.state === 'received') this.step(row, { type: 'received_refused', status: 409 });
      return r;
    }
    this.leaseDied(r);
    return r;
  }

  // ── turns (decided by the real turn machine) ─────────────────────────────

  /** Feed one event to the row's turn machine and act on the transition.
   *  Null (the event means nothing in this phase) is what nucleusLane treats
   *  as a lane error: the turn closes cancelled and the terminal is owed. */
  step(row, ev) {
    let t = nextTurnState(row.turn, ev);
    if (t === null && !['terminal', 'dropped'].includes(row.turn.phase)) {
      t = nextTurnState(row.turn, { type: 'lane_error', detail: `${ev.type}${ev.code ? ':' + ev.code : ''}`, commandLive: true });
    }
    if (t === null) return; // closed turns answer nothing (F31: a closed turn is never re-closed)
    row.turn = t.to;
    for (const effect of t.effects ?? []) {
      if (effect === 'cancel_locally') this.owe(row, 'cancelled');
      else if (effect === 'adopt') row.adoptOwed = true;
      else if (effect === 'cancel_command') row.cancelRequested = true;
    }
    if (row.turn.phase === 'terminal' && row.state !== 'terminal' && row.state !== 'terminal_owed') this.owe(row, row.turn.state);
    if (row.turn.phase === 'dropped') this.drop(row, row.turn.code);
    // The machine waived the /start (the relay has its answer): the runtime
    // finishes and the outcome posts as the terminal.
    if (row.state === 'submitted' && ['running', 'cancelling'].includes(row.turn.phase) && row.turn.startPosted) row.state = 'waived';
    this.agree(row);
  }
  /** The runtime is interrupted; the terminal fact `state` is owed to the relay. */
  owe(row, state) {
    this.runtime.delete(row.turnId);
    row.state = 'terminal_owed'; row.terminalState = state; row.adoptOwed = false;
    if (state === 'cancelled') row.cancelRequested = true;
  }
  drop(row, code) { row.state = 'dropped'; row.dropCode = code; row.adoptOwed = false; this.runtime.delete(row.turnId); }

  /** The ledger row (what this daemon believes) and the machine (what the
   *  real daemon's logic concludes from the same answers) must describe the
   *  same turn. */
  agree(row) {
    const m = row.turn;
    const ok = (() => {
      switch (row.state) {
        case 'received': return m.phase === 'received';
        // Dispatched here, /start not yet acknowledged: the machine is at
        // received (the /submitted answer not seen), submitted, running
        // without a start, or parked on an adoption. A resumed turn re-enters
        // at submitted whether or not its /submitted was ever answered.
        case 'submitted': return ['received', 'submitted', 'adoption_pending'].includes(m.phase)
          || (['running', 'cancelling'].includes(m.phase) && !m.startPosted);
        case 'started': return ['running', 'cancelling'].includes(m.phase) && m.startPosted;
        case 'waived': return ['running', 'cancelling'].includes(m.phase) && m.startPosted;
        case 'terminal_owed': return m.phase === 'terminal';
        case 'terminal': return m.phase === 'terminal';
        case 'dropped': return m.phase === 'dropped' || m.phase === 'terminal';
      }
      return false;
    })();
    if (!ok) throw new ModelDisagreement(this.label, row, 'phase and ledger state do not correspond');
  }

  /** Hand the prompt to the agent: the ledger row and the agent come first,
   *  then the relay is told. The order is the real one — it is why a crash
   *  right here leaves a running agent the relay only knows as queued. */
  async submit(turnId) {
    const row = this.ledger.get(turnId);
    if (row.state === 'received') { row.state = 'submitted'; this.runtime.set(turnId, 'executing'); }
    const r = await this.call('POST', `/joy/v2/daemon/turns/${turnId}/submitted`, { headers: this.headers() });
    if (r.status === 200) {
      row.submittedAcked = true;
      this.step(row, { type: 'submitted_ok' });
      // The runtime's echo: the prompt is in the agent's box. Instant here.
      this.step(row, { type: 'delivery_confirmed' });
      return r;
    }
    if (r.status === 409) { this.step(row, { type: 'submitted_refused', code: r.code }); return r; }
    this.leaseDied(r);
    return r;
  }
  async start(turnId) {
    const row = this.ledger.get(turnId);
    const r = await this.call('POST', `/joy/v2/daemon/turns/${turnId}/start`, {
      body: { runtimeEventId: `start:${turnId}` }, headers: this.headers(),
    });
    if (r.status === 200) { row.state = 'started'; this.step(row, { type: 'start_ok' }); return r; }
    if (r.status === 409) {
      this.step(row, { type: 'start_refused', code: r.code });
      return r;
    }
    this.leaseDied(r);
    return r;
  }
  /** The machine asked for an adoption: reconcile{running}. Its answer is
   *  the next `adoption` event. */
  async adopt(turnId) {
    const row = this.ledger.get(turnId);
    const r = await this.call('POST', `/joy/v2/daemon/turns/${turnId}/reconcile`, {
      body: { resolution: 'running', runtimeEventId: `start:${turnId}`, meta: { reason: 'start_refused' } }, headers: this.headers(),
    });
    row.adoptOwed = false;
    const answer = adoptionAnswerOf(r);
    if (!answer) { this.leaseDied(r); return r; }
    if (answer.kind === 'running' || answer.kind === 'cancelling') { row.epoch = this.lease.epoch; row.submittedAcked = true; }
    this.step(row, { type: 'adoption', answer, now: this.world.clock.now() });
    return r;
  }
  async output(turnId) {
    const r = await this.call('POST', `/joy/v2/daemon/turns/${turnId}/facts`, {
      body: { type: 'output', ciphertext: 'o', runtimeEventId: `out:${turnId}:${this.world.trace.length}` }, headers: this.headers(),
    });
    if (r.status !== 200 && r.status !== 409 && r.status !== 429) this.leaseDied(r);
    return r;
  }
  /** The agent finished (or was interrupted after a cancel), or a terminal
   *  the machine decided is owed: post it. */
  async finish(turnId) {
    const row = this.ledger.get(turnId);
    const terminalState = row.cancelRequested ? 'cancelled' : (row.terminalState ?? 'completed');
    row.terminalState = terminalState;
    if (this.runtime.has(turnId)) this.runtime.set(turnId, 'done');
    if (row.turn.phase !== 'terminal') this.step(row, { type: 'turn_ended', status: terminalState, reason: null });
    const r = await this.call('POST', `/joy/v2/daemon/turns/${turnId}/facts`, {
      body: { type: 'terminal', terminalState, runtimeEventId: `end:${turnId}` }, headers: this.headers(),
    });
    if (r.status === 200 || r.status === 409) { row.state = 'terminal'; this.runtime.delete(turnId); this.agree(row); return r; }
    this.leaseDied(r);
    return r;
  }

  /** After a new lease: every turn a previous incarnation left open re-enters
   *  the machine as a resumed turn (the ledger is what survived) and is
   *  resolved — adopted when its agent still runs here, closed as
   *  interrupted when it doesn't. A turn the relay still counts as the old
   *  epoch's (not yet swept) answers turn_not_orphaned; it is tried again. */
  async reconcile(turnId) {
    const row = this.ledger.get(turnId);
    const executing = this.runtime.get(turnId) === 'executing';
    if (row.state === 'terminal_owed') return this.finish(turnId); // the owed terminal, under the new lease
    if (!row.resumed) {
      row.turn = resumedTurnState(row.state === 'started' || row.state === 'waived');
      if (executing) this.step(row, { type: 'delivery_confirmed' });
      row.resumed = true;
    }
    if (!executing) {
      const r = await this.call('POST', `/joy/v2/daemon/turns/${turnId}/reconcile`, {
        body: { resolution: 'terminal', terminalState: 'interrupted', meta: { reason: 'daemon_restart' } }, headers: this.headers(),
      });
      if (r.status === 200) {
        row.epoch = this.lease.epoch;
        this.step(row, { type: 'turn_ended', status: 'interrupted', reason: 'daemon_restart' });
        row.state = 'terminal'; row.terminalState = r.json.terminalState ?? 'interrupted'; this.runtime.delete(turnId); this.agree(row);
        return r;
      }
      if (r.status === 409) return r; // turn_not_orphaned / another_turn_active: after the sweep
      this.leaseDied(r);
      return r;
    }
    const r = await this.call('POST', `/joy/v2/daemon/turns/${turnId}/reconcile`, {
      body: { resolution: 'running', runtimeEventId: `start:${turnId}`, meta: { reason: 'daemon_restart' } }, headers: this.headers(),
    });
    const answer = adoptionAnswerOf(r);
    if (!answer) { this.leaseDied(r); return r; }
    if (answer.kind === 'running' || answer.kind === 'cancelling') { row.epoch = this.lease.epoch; row.submittedAcked = true; }
    if (answer.kind === 'terminal') row.epoch = this.lease.epoch;
    if (answer.kind === 'none' && answer.detail === 'dispatching') { row.epoch = this.lease.epoch; row.submittedAcked = true; }
    this.step(row, { type: 'adoption', answer, now: this.world.clock.now() });
    if (row.turn.phase === 'terminal' && row.state !== 'terminal') { row.state = 'terminal'; row.terminalState = row.turn.state; this.runtime.delete(turnId); this.agree(row); }
    else if (['running', 'cancelling'].includes(row.turn.phase)) { row.state = row.turn.startPosted ? 'started' : 'submitted'; this.agree(row); }
    return r;
  }

  // ── what could happen next ───────────────────────────────────────────────

  /** Turns this incarnation inherited and has not resolved. */
  inherited() {
    const out = [];
    for (const row of this.ledger.values()) {
      if (['submitted', 'started', 'waived', 'terminal_owed'].includes(row.state) && row.epoch !== this.lease?.epoch) out.push(row);
    }
    return out;
  }
  sessionsIdle() {
    const busy = new Set();
    for (const row of this.ledger.values()) if (['submitted', 'started', 'waived', 'terminal_owed'].includes(row.state)) busy.add(row.sessionId);
    return [...this.records].filter(([id, rec]) => !rec.archived && !busy.has(id)).map(([id]) => id);
  }

  actions() {
    const A = [];
    if (!this.alive) {
      A.push({ name: 'restart', run: () => this.restart() });
      return A;
    }
    if (!this.lease) {
      A.push({ name: 'acquire', run: () => this.acquire() });
      return A;
    }
    A.push({ name: 'renew', run: () => this.renew() });
    A.push({ name: 'claimWork', run: () => this.claim('work') });
    A.push({ name: 'claimControl', run: () => this.claim('control') });
    A.push({ name: 'announce', run: () => this.announce() });
    for (const offer of this.offers.values()) {
      if (offer.kind === 'spawn_session') {
        A.push({ name: 'bind', detail: offer.sessionId, run: () => this.bind(offer) });
        A.push({ name: 'spawnFail', detail: offer.sessionId, run: () => this.spawnFail(offer) });
      } else {
        A.push({ name: 'ack', detail: offer.deliveryId, run: () => this.ack(offer) });
      }
    }
    const inherited = new Set(this.inherited().map((r) => r.turnId));
    for (const row of this.ledger.values()) {
      if (inherited.has(row.turnId)) { A.push({ name: 'reconcile', detail: row.turnId, run: () => this.reconcile(row.turnId) }); continue; }
      if (row.state === 'received') {
        // Acknowledged under an older lease: its delivery is dead, and the
        // relay will offer a new one. Submitting the old one would only be
        // refused (no_current_delivery).
        if (row.epoch === this.lease.epoch) A.push({ name: 'submit', detail: row.turnId, run: () => this.submit(row.turnId) });
      }
      else if (row.state === 'submitted' && !row.submittedAcked) A.push({ name: 'submit', detail: row.turnId, run: () => this.submit(row.turnId) });
      else if (row.state === 'submitted' && row.adoptOwed) A.push({ name: 'adopt', detail: row.turnId, run: () => this.adopt(row.turnId) });
      else if (row.state === 'submitted') A.push({ name: 'start', detail: row.turnId, run: () => this.start(row.turnId) });
      else if (row.state === 'started' || row.state === 'waived') {
        A.push({ name: 'output', detail: row.turnId, run: () => this.output(row.turnId) });
        A.push({ name: 'finish', detail: row.turnId, run: () => this.finish(row.turnId) });
      } else if (row.state === 'terminal_owed') A.push({ name: 'finish', detail: row.turnId, run: () => this.finish(row.turnId) });
    }
    for (const sid of this.sessionsIdle()) A.push({ name: 'archive', detail: sid, run: () => this.archive(sid) });
    return A;
  }
}

/** The relay's reconcile answer as the daemon's Adoption union (the mapping
 *  nucleusLane.adoptRelayTurn makes); null = a lease-death answer. */
function adoptionAnswerOf(r) {
  if (r.status === 200) {
    const st = r.json.state;
    if (st === 'terminal') return { kind: 'terminal', terminalState: String(r.json.terminalState ?? 'interrupted') };
    if (st === 'cancelling') return { kind: 'cancelling' };
    if (st === 'running') return { kind: 'running' };
    return { kind: 'none', detail: st };
  }
  if (r.status === 409) {
    if (r.code === 'turn_not_orphaned' || r.code === 'another_turn_active') return { kind: 'none', detail: r.code };
    if (START_CANCEL_CLASS.has(r.code)) return { kind: 'refused', code: r.code };
    return { kind: 'unavailable', detail: r.code };
  }
  if (r.status >= 500) return { kind: 'unavailable', detail: String(r.status) };
  return null;
}
