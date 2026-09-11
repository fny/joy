// A device: the app as a client of the session plane. It keeps only what a
// real device keeps — the sessions and messages it has seen and the status
// it last read for each — and acts on THAT, so it edits messages the daemon
// may already hold and cancels turns that may already be over. The relay's
// 409s to those are the contract, not errors.
export class SimApp {
  constructor(world, name, { token = 'app-token' } = {}) {
    this.world = world;
    this.name = name;
    this.token = token;
    this.sessions = new Map(); // sessionId -> { daemonId, state, messages: Map<messageId, { turnId, status }> }
    this.nextIntent = 1;
  }
  get label() { return `app:${this.name}`; }
  call(method, path, opts = {}) { return this.world.call(this.label, method, path, { token: this.token, ...opts }); }
  intent(prefix) { return `${this.name}:${prefix}:${this.nextIntent++}`; }

  /** Another actor created a session on the account; this device learns of it. */
  see(sessionId, daemonId, state = 'active') {
    if (!this.sessions.has(sessionId)) this.sessions.set(sessionId, { daemonId, state, messages: new Map(), pendingIntent: null });
  }

  async spawn(daemonId) {
    const r = await this.call('POST', '/joy/v2/sessions', {
      body: { mode: 'spawn', creationIntentId: this.intent('spawn'), daemonId, spawnSpec: '{"cwd":"/sim"}' },
    });
    if (r.status === 200) this.see(r.json.sessionId, daemonId, r.json.state);
    return r;
  }
  async send(sessionId) {
    const s = this.sessions.get(sessionId);
    // A send whose answer was lost is retried under the SAME intent (the
    // app's sendKey): the relay replays the accepted message instead of
    // queueing a second one.
    const clientIntentId = s.pendingIntent ?? this.intent('m');
    s.pendingIntent = clientIntentId;
    const r = await this.call('POST', `/joy/v2/sessions/${sessionId}/messages`, {
      body: { ciphertext: 'm', clientIntentId },
    });
    s.pendingIntent = null;
    if (r.status === 202) s.messages.set(r.json.messageId, { turnId: r.json.turnId, status: 'queued' });
    return r;
  }
  async edit(sessionId, messageId) {
    const r = await this.call('PATCH', `/joy/v2/sessions/${sessionId}/messages/${messageId}`, { body: { ciphertext: 'm2' } });
    this.learn(sessionId, messageId, r);
    return r;
  }
  async move(sessionId, messageId, position) {
    const r = await this.call('PATCH', `/joy/v2/sessions/${sessionId}/messages/${messageId}`, { body: { position } });
    this.learn(sessionId, messageId, r);
    return r;
  }
  async remove(sessionId, messageId) {
    const r = await this.call('DELETE', `/joy/v2/sessions/${sessionId}/messages/${messageId}`);
    const m = this.sessions.get(sessionId).messages.get(messageId);
    if (r.status === 200) m.status = 'cancelled';
    else if (r.json?.error?.status) m.status = r.json.error.status;
    return r;
  }
  async cancel(sessionId, turnId) {
    return this.call('POST', `/joy/v2/sessions/${sessionId}/turns/${turnId}/cancellations`, {
      body: { clientIntentId: this.intent('c'), scope: 'turn' },
    });
  }
  async retry(sessionId, messageId) {
    const r = await this.call('POST', `/joy/v2/sessions/${sessionId}/messages/${messageId}/retry`);
    if (r.status === 202) this.sessions.get(sessionId).messages.get(messageId).status = 'queued';
    return r;
  }
  async retrySpawn(sessionId) {
    const r = await this.call('POST', `/joy/v2/sessions/${sessionId}/spawn/retry`, { body: { createDir: true } });
    if (r.status === 200) this.sessions.get(sessionId).state = 'provisioning';
    return r;
  }
  /** Re-read a session: state, and the status of every message. */
  async refresh(sessionId) {
    const s = this.sessions.get(sessionId);
    const st = await this.call('GET', `/joy/v2/sessions/${sessionId}`);
    if (st.status === 200) s.state = st.json.sessionState;
    const r = await this.call('GET', `/joy/v2/sessions/${sessionId}/messages?limit=500`);
    if (r.status === 200) for (const m of r.json.messages) { const known = s.messages.get(m.id); if (known) known.status = m.status; }
    return r;
  }
  learn(sessionId, messageId, r) {
    const m = this.sessions.get(sessionId).messages.get(messageId);
    if (r.status === 200 && r.json?.status) m.status = r.json.status;
    else if (r.json?.error?.status) m.status = r.json.error.status;
  }

  actions(daemonIds) {
    const A = [];
    for (const daemonId of daemonIds) A.push({ name: 'spawn', detail: daemonId, run: () => this.spawn(daemonId) });
    for (const [sid, s] of this.sessions) {
      // As this device last saw it: a session it read as archived or not
      // yet bound gets no prompts. One it has not re-read may be either.
      if (!['archived', 'failed', 'provisioning'].includes(s.state)) A.push({ name: 'send', detail: sid, run: () => this.send(sid) });
      A.push({ name: 'refresh', detail: sid, run: () => this.refresh(sid) });
      if (s.state === 'failed') A.push({ name: 'retrySpawn', detail: sid, run: () => this.retrySpawn(sid) });
      const queued = [...s.messages].filter(([, m]) => m.status === 'queued');
      for (const [mid, m] of s.messages) {
        if (m.status === 'queued') {
          A.push({ name: 'edit', detail: mid, run: () => this.edit(sid, mid) });
          A.push({ name: 'remove', detail: mid, run: () => this.remove(sid, mid) });
          if (queued.length > 1) A.push({ name: 'move', detail: mid, run: (rng) => this.move(sid, mid, rng.int(queued.length)) });
        } else if (m.status === 'delivering' || m.status === 'delivered') {
          A.push({ name: 'cancel', detail: m.turnId, run: () => this.cancel(sid, m.turnId) });
        } else if (m.status === 'failed') {
          A.push({ name: 'retry', detail: mid, run: () => this.retry(sid, mid) });
        }
      }
    }
    return A;
  }
}
