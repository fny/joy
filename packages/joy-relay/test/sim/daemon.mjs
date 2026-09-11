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
const CANCEL_CLASS = new Set([
  'turn_cancelled', 'turn_terminal', 'session_archived', 'session_failed',
  'session_event_budget_exhausted', 'no_current_delivery',
]);
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
    if (r.status === 401 || r.status === 412 || LEASE_DEATH.has(r.code)) { this.lease = null; this.offers.clear(); return true; }
    return false;
  }

  // ── lifecycle of the process ─────────────────────────────────────────────

  /** The process dies. Memory goes; disk and the agents stay. */
  crash() { this.alive = false; this.lease = null; this.offers.clear(); return { status: 0, code: 'crashed' }; }
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
    const localSessionId = `local-${this.id}-${this.nextLocal++}`;
    const r = await this.call('POST', '/joy/v2/sessions', {
      body: { mode: 'announce_existing', creationIntentId: `announce:${localSessionId}`, daemonId: this.id, localSessionId, sessionKeyEnvelope: 'wrapped-key' },
    });
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
        const fresh = { deliveryId: offer.deliveryId, state: 'received', submittedAcked: false, cancelRequested: false, terminalState: null, epoch: this.lease.epoch };
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
      } else if (offer.kind === 'cancel') {
        const row = this.ledger.get(offer.targetTurnId);
        if (row && row.state !== 'terminal' && row.state !== 'dropped') row.cancelRequested = true;
      }
      return r;
    }
    if (r.status === 409) {
      // delivery_superseded: the message changed under the offer (an edit,
      // a move, an archive). Whatever this daemon had of it is stale.
      const row = offer.kind === 'prompt' ? this.ledger.get(offer.turnId) : null;
      if (row && row.state === 'received') row.state = 'dropped';
      return r;
    }
    this.leaseDied(r);
    return r;
  }

  // ── turns ────────────────────────────────────────────────────────────────

  /** Hand the prompt to the agent: the ledger row and the agent come first,
   *  then the relay is told. The order is the real one — it is why a crash
   *  right here leaves a running agent the relay only knows as queued. */
  async submit(turnId) {
    const row = this.ledger.get(turnId);
    if (row.state === 'received') { row.state = 'submitted'; this.runtime.set(turnId, 'executing'); }
    const r = await this.call('POST', `/joy/v2/daemon/turns/${turnId}/submitted`, { headers: this.headers() });
    if (r.status === 200) { row.submittedAcked = true; return r; }
    if (r.status === 409) { this.drop(row, r.code); return r; }
    this.leaseDied(r);
    return r;
  }
  async start(turnId) {
    const row = this.ledger.get(turnId);
    const r = await this.call('POST', `/joy/v2/daemon/turns/${turnId}/start`, {
      body: { runtimeEventId: `start:${turnId}` }, headers: this.headers(),
    });
    if (r.status === 200) { row.state = 'started'; return r; }
    if (r.status === 409) {
      if (CANCEL_CLASS.has(r.code)) this.drop(row, r.code);
      // not_queue_head / another_turn_active / turn_orphaned_reconcile_first: try again later.
      return r;
    }
    this.leaseDied(r);
    return r;
  }
  async output(turnId) {
    const r = await this.call('POST', `/joy/v2/daemon/turns/${turnId}/facts`, {
      body: { type: 'output', ciphertext: 'o', runtimeEventId: `out:${turnId}:${this.world.trace.length}` }, headers: this.headers(),
    });
    if (r.status !== 200 && r.status !== 409 && r.status !== 429) this.leaseDied(r);
    return r;
  }
  /** The agent finished (or was interrupted after a cancel). */
  async finish(turnId) {
    const row = this.ledger.get(turnId);
    const terminalState = row.cancelRequested ? 'cancelled' : (row.terminalState ?? 'completed');
    row.terminalState = terminalState;
    this.runtime.set(turnId, 'done');
    const r = await this.call('POST', `/joy/v2/daemon/turns/${turnId}/facts`, {
      body: { type: 'terminal', terminalState, runtimeEventId: `end:${turnId}` }, headers: this.headers(),
    });
    if (r.status === 200 || r.status === 409) { row.state = 'terminal'; this.runtime.delete(turnId); return r; }
    this.leaseDied(r);
    return r;
  }
  drop(row, code) { row.state = 'dropped'; row.dropCode = code; this.runtime.delete(row.turnId); }

  /** After a new lease: every turn a previous incarnation left open is
   *  resolved — adopted when its agent still runs here, closed as
   *  interrupted when it doesn't. A turn the relay still counts as the old
   *  epoch's (not yet swept) answers turn_not_orphaned; it is tried again. */
  async reconcile(turnId) {
    const row = this.ledger.get(turnId);
    const executing = this.runtime.get(turnId) === 'executing';
    const body = executing
      ? { resolution: 'running', runtimeEventId: `start:${turnId}`, meta: { reason: 'daemon_restart' } }
      : { resolution: 'terminal', terminalState: 'interrupted', meta: { reason: 'daemon_restart' } };
    const r = await this.call('POST', `/joy/v2/daemon/turns/${turnId}/reconcile`, { body, headers: this.headers() });
    if (r.status === 200) {
      row.epoch = this.lease.epoch;
      if (r.json.state === 'terminal') { row.state = 'terminal'; row.terminalState = r.json.terminalState; this.runtime.delete(turnId); }
      else { row.state = 'started'; row.submittedAcked = true; if (r.json.state === 'cancelling') row.cancelRequested = true; }
      return r;
    }
    if (r.status === 409) {
      if (CANCEL_CLASS.has(r.code)) this.drop(row, r.code);
      // turn_not_orphaned / another_turn_active: not yet — try again later.
      return r;
    }
    this.leaseDied(r);
    return r;
  }

  // ── what could happen next ───────────────────────────────────────────────

  /** Turns this incarnation inherited and has not resolved. */
  inherited() {
    const out = [];
    for (const row of this.ledger.values()) {
      if ((row.state === 'submitted' || row.state === 'started') && row.epoch !== this.lease?.epoch) out.push(row);
    }
    return out;
  }
  sessionsIdle() {
    const busy = new Set();
    for (const row of this.ledger.values()) if (row.state === 'submitted' || row.state === 'started') busy.add(row.sessionId);
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
      else if (row.state === 'submitted') A.push({ name: 'start', detail: row.turnId, run: () => this.start(row.turnId) });
      else if (row.state === 'started') {
        A.push({ name: 'output', detail: row.turnId, run: () => this.output(row.turnId) });
        A.push({ name: 'finish', detail: row.turnId, run: () => this.finish(row.turnId) });
      }
    }
    for (const sid of this.sessionsIdle()) A.push({ name: 'archive', detail: sid, run: () => this.archive(sid) });
    return A;
  }
}
