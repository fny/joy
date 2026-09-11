// The account as this server sees it: every session on every machine, opened
// with the content key, with the app's own state ladder on top — and the
// event feed a client waits on (turn ended, needs input, session ended).
//
// Ids: the app and the CLI address a session by its daemon-local id (eight
// hex characters, `joy__sessionId` on the card, `localSessionId` on the relay
// row). The relay's own id is a UUID. Tools accept either, or a unique prefix.
import { EventEmitter } from 'node:events';
import { openSessionKeyEnvelope, openCard, openMachineKey, openMachineMetadata, openPayload, sealText } from './crypto.mjs';

const FRESH_MS = 5 * 60_000;

/** The app's ladder (sessionFacts.ts statusState), on relay row + card. */
export function stateOf(row, meta, { unread = false, execution = null } = {}) {
  const online = !!row.online;
  const lifecycle = meta?.joy__state;
  if (online && lifecycle === 'detached') return 'detached';
  if (lifecycle === 'archived') return 'archived';
  if (!online) return 'disconnected';
  if (meta?.joy__login) return 'blocked';
  if (meta?.joy__dialog) return 'blocked';
  if (meta?.joy__codexApproval) return 'blocked';
  if (unread) return 'unread';
  if (meta?.joy__retry) return 'retrying';
  if (meta?.joy__compacting) return 'compacting';
  const busy = meta?.joy__thinking != null || execution === 'running' || execution === 'dispatching' || execution === 'cancelling';
  if (meta?.joy__stalled && busy) return 'stalled';
  if (busy) return 'thinking';
  if (meta?.joy__agents && meta.joy__agents.total > 0) return 'agents';
  if (meta?.joy__tasks && meta.joy__tasks.total > 0) return 'tasks';
  return 'waiting';
}

/** What `check` says for a ladder state, before the question read. */
export function checkStateOf(state) {
  switch (state) {
    case 'blocked': return 'needs_input';
    case 'thinking': case 'agents': case 'tasks': case 'retrying': case 'compacting': case 'stalled': return 'busy';
    case 'detached': case 'archived': return 'ended';
    case 'disconnected': return 'unreachable';
    default: return 'idle';
  }
}

export function blockedOf(meta) {
  if (meta?.joy__login) return { kind: 'login', ...(meta.joy__login.url ? { url: meta.joy__login.url } : {}), ...(meta.joy__login.code ? { code: meta.joy__login.code } : {}) };
  if (meta?.joy__dialog) return { kind: 'dialog', title: meta.joy__dialog.title ?? null, options: meta.joy__dialog.options ?? [] };
  if (meta?.joy__codexApproval) return { kind: 'approval', title: meta.joy__codexApproval.title };
  return null;
}

/** The record behind one relay event, if it opens. */
export function recordOf(e, key) {
  if (!e.content) return null;
  return openPayload(e.content.ciphertext, key);
}

const OPTIONS_RE = /<joy-options>[\s\S]*?<\/joy-options>\s*$/;
export function questionOf(text) {
  if (typeof text !== 'string' || !OPTIONS_RE.test(text.trim())) return null;
  const t = text.trim();
  const question = t.replace(/<joy-options>[\s\S]*$/, '').trim().split('\n').slice(-3).join('\n');
  const options = [...t.matchAll(/<joy-option>([\s\S]*?)<\/joy-option>/g)].map((m) => m[1].trim());
  return { question, options };
}

/** Fold relay events into the conversation the app shows. */
export function foldMessages(events, key) {
  const out = [];
  for (const e of events) {
    const seq = Number(e.seq);
    const p = recordOf(e, key);
    if (e.kind === 'turn.queued') {
      if (p?.t === 'plain') out.push({ seq, role: 'user', text: p.text, at: e.createdAt, turn: e.turnId ?? null, from: joyMessageFrom(p.text) });
      continue;
    }
    if (!p) continue;
    if (p.t === 'plain') { const text = stripDirectives(p.text); if (text) out.push({ seq, role: 'assistant', text, at: e.createdAt, turn: e.turnId ?? null }); continue; }
    const ev = p.record?.content?.data?.ev;
    if (!ev || typeof ev !== 'object') continue;
    const at = typeof p.record.content.data.time === 'number' ? p.record.content.data.time : e.createdAt;
    const turn = p.record.content.data.turn ?? e.turnId ?? null;
    if (ev.t === 'text' && typeof ev.text === 'string' && !ev.thinking) { const text = stripDirectives(ev.text); if (text) out.push({ seq, role: 'assistant', text, at, turn }); }
    else if (ev.t === 'tool-call-start') out.push({ seq, role: 'tool', text: `${ev.name ?? 'tool'}${summarizeArgs(ev.args)}`, at, turn });
  }
  return out;
}
function summarizeArgs(args) {
  if (!args || typeof args !== 'object') return '';
  const s = JSON.stringify(args);
  return s.length > 2 ? ` ${s.length > 160 ? s.slice(0, 157) + '…' : s}` : '';
}
function joyMessageFrom(text) {
  const m = /^<joy-message\b[^>]*\bfrom="([^"]+)"/.exec(String(text));
  return m ? m[1] : undefined;
}

/** Is this event the end of a turn? Returns { turn, status } or null. */
export function turnEndOf(e, key) {
  // The relay's turn id is the one `send` returned; the daemon's own runtime
  // turn id (inside the record) is a fallback for rows that lack it.
  if (e.kind === 'turn.terminal') {
    const p = recordOf(e, key);
    const ev = p?.t === 'record' ? p.record?.content?.data?.ev : null;
    return { turn: e.turnId ?? p?.record?.content?.data?.turn ?? null, status: ev?.status ?? null, marker: true };
  }
  const p = recordOf(e, key);
  const ev = p?.t === 'record' ? p.record?.content?.data?.ev : null;
  if (ev?.t === 'turn-end') return { turn: e.turnId ?? p.record.content.data.turn ?? null, status: ev.status ?? 'completed', marker: false };
  return null;
}

/** App directives an agent emits for the joy app — a title, a push, an image,
 *  a file chip — are not part of the reply a client should read. Options
 *  (a question with offered answers) stay: they ARE the reply. */
const DIRECTIVE_RE = /<joy-(?:title|notify|bg|img|file)\b[^>]*\/?>\s*/g;
export function stripDirectives(text) {
  return typeof text === 'string' ? text.replace(DIRECTIVE_RE, '').trim() : text;
}

export class SessionIndex extends EventEmitter {
  /** @param {{ relay: import('./relay.mjs').RelayClient, contentSecret: Uint8Array, log?: (s: string) => void, pollMs?: number }} opts */
  constructor({ relay, contentSecret, log = () => {}, pollMs = 15_000 }) {
    super();
    this.relay = relay;
    this.contentSecret = contentSecret;
    this.log = log;
    this.pollMs = pollMs;
    this.rows = new Map();        // relay session id → row
    this.cards = new Map();       // relay session id → { envelope, key, meta }
    this.machines = new Map();    // machine id → { id, name, online, key, meta }
    this.lastSeq = new Map();     // relay session id → highest seq scanned for events
    this.lastReadSeq = new Map(); // relay session id → seq the last `session()` read reached
    this.lastEndSeq = new Map();  // relay session id → seq of the last turn end seen
    this.prevCheck = new Map();   // relay session id → last check state emitted
    this.feed = [];               // { cursor, at, session, kind, ... }
    this.cursor = 0;
    this.execution = new Map();   // relay session id → execution.state (from sessionState)
    this.pendingText = new Map(); // relay session id → assistant text of the turn in progress (across scans)
    this.endedTurns = new Map();  // relay session id → Set of relay turn ids already reported ended
    this.#stop = null;
    this.#timer = null;
    this.#pending = new Set();
    this.#refreshing = null;
  }
  #stop; #timer; #pending; #refreshing;

  // ── keys and cards ───────────────────────────────────────────────────────
  keyFor(row) {
    const c = this.cards.get(row.sessionId);
    if (c && c.envelope === row.sessionKeyEnvelope) return c.key;
    const key = openSessionKeyEnvelope(row.sessionKeyEnvelope, this.contentSecret);
    this.cards.set(row.sessionId, { envelope: row.sessionKeyEnvelope, key, meta: null, metaSrc: null });
    return key;
  }
  metaFor(row) {
    const key = this.keyFor(row);
    const c = this.cards.get(row.sessionId);
    if (c.metaSrc === row.encryptedMetadata) return c.meta;
    c.meta = openCard(row.encryptedMetadata, key);
    c.metaSrc = row.encryptedMetadata;
    return c.meta;
  }

  // ── refresh ──────────────────────────────────────────────────────────────
  async refresh() {
    if (this.#refreshing) return this.#refreshing;
    this.#refreshing = (async () => {
      const [{ sessions }, { machines }] = await Promise.all([this.relay.listSessions(), this.relay.listMachines()]);
      for (const m of machines) {
        const prev = this.machines.get(m.id);
        const key = prev?.keySrc === m.dataEncryptionKey ? prev.key : openMachineKey(m.dataEncryptionKey, this.contentSecret);
        const meta = prev?.metaVersion === m.metadataVersion ? prev.meta : openMachineMetadata(m.metadata, key);
        const name = meta?.displayName || meta?.host || m.id.slice(0, 8);
        this.machines.set(m.id, { id: m.id, name, online: !!(m.active || m.leaseAlive), key, keySrc: m.dataEncryptionKey, meta, metaVersion: m.metadataVersion, capabilities: meta?.capabilities ?? null, activeAt: m.activeAt });
      }
      const seen = new Set();
      for (const row of sessions) {
        seen.add(row.sessionId);
        const prev = this.rows.get(row.sessionId);
        this.rows.set(row.sessionId, row);
        if (!prev) this.lastSeq.set(row.sessionId, Number(row.headSeq) || 0); // history is not news
        this.metaFor(row);
      }
      for (const id of [...this.rows.keys()]) if (!seen.has(id)) { this.rows.delete(id); this.cards.delete(id); }
      return this.views();
    })().finally(() => { this.#refreshing = null; });
    return this.#refreshing;
  }

  // ── views ────────────────────────────────────────────────────────────────
  viewOf(row) {
    const meta = this.metaFor(row);
    const machine = this.machines.get(row.daemonId);
    const unread = (this.lastEndSeq.get(row.sessionId) ?? 0) > (this.lastReadSeq.get(row.sessionId) ?? 0);
    const state = stateOf(row, meta, { unread, execution: this.execution.get(row.sessionId) ?? null });
    const q = meta?.joy__queue;
    return {
      id: row.localSessionId ?? row.sessionId,
      relay_id: row.sessionId,
      machine: { id: row.daemonId, name: machine?.name ?? row.daemonId.slice(0, 8), online: machine?.online ?? !!row.online },
      harness: meta?.flavor ?? 'claude',
      cwd: meta?.path ?? null,
      title: meta?.summary?.text ?? null,
      state,
      check_state: checkStateOf(state),
      blocked: blockedOf(meta),
      unread,
      online: !!row.online,
      relay_state: row.state,
      queue: q ? { depth: q.queue?.length ?? 0, in_flight: q.inFlight != null, paused: !!q.paused, ...(q.pauseReason ? { pause_reason: q.pauseReason } : {}) } : null,
      model: meta?.currentModelCode ?? meta?.model ?? null,
      effort: meta?.currentEffortCode ?? null,
      mode: meta?.currentOperatingModeCode ?? meta?.permissionMode ?? null,
      headless: meta?.joy__headless === true,
      muted: meta?.joy__muted === true,
      active_at: row.online ? Date.now() : (row.lastTurnAt ?? row.updatedAt),
      created_at: row.createdAt,
      readable: this.keyFor(row) !== null || !row.encryptedMetadata,
    };
  }
  views() {
    return [...this.rows.values()].map((r) => this.viewOf(r)).sort((a, b) => b.active_at - a.active_at);
  }
  /** Resolve a relay id, a local id, or a unique prefix of either. */
  resolve(id) {
    if (!id) return null;
    const rows = [...this.rows.values()];
    const exact = rows.find((r) => r.sessionId === id || r.localSessionId === id);
    if (exact) return exact;
    const m = rows.filter((r) => r.sessionId.startsWith(id) || (r.localSessionId ?? '').startsWith(id));
    if (m.length === 1) return m[0];
    if (m.length > 1) throw new ModelError('ambiguous_session', `${m.length} sessions match "${id}"`);
    return null;
  }
  row(id) { return this.resolve(id); }
  machine(id) { return this.machines.get(id) ?? [...this.machines.values()].find((m) => m.id.startsWith(id) || m.name === id) ?? null; }

  // ── messages ─────────────────────────────────────────────────────────────
  /** Newest-last page. `before` is a seq; `older` is the cursor for the next page back. */
  async messages(row, { before, limit = 50 } = {}) {
    const key = this.keyFor(row);
    const raw = before !== undefined ? 400 : Math.max(200, limit * 4);
    const page = await this.relay.events(row.sessionId, before !== undefined ? { before, limit: raw } : { before: Number(row.headSeq) + 1, limit: raw });
    const events = page.messages ?? [];
    const folded = foldMessages(events, key);
    const messages = folded.slice(-limit);
    const first = events[0];
    const older = page.hasMore && first ? Number(first.seq) : (messages.length && folded.length > limit ? messages[0].seq : null);
    if (before === undefined) {
      const top = events.length ? Number(events[events.length - 1].seq) : Number(row.headSeq) || 0;
      this.lastReadSeq.set(row.sessionId, Math.max(this.lastReadSeq.get(row.sessionId) ?? 0, top));
    }
    return { messages, older: older ?? null };
  }
  /** The last assistant text, for the question read. */
  async lastReply(row) {
    const key = this.keyFor(row);
    const page = await this.relay.events(row.sessionId, { before: Number(row.headSeq) + 1, limit: 60 });
    const folded = foldMessages(page.messages ?? [], key).filter((m) => m.role === 'assistant');
    return folded.length ? folded[folded.length - 1].text : null;
  }
  sealFor(row, text) { return sealText(text, this.keyFor(row)); }
  /** Prompts the RELAY still holds for this session (its durable queue),
   *  oldest first — the daemon only sees them once it claims each. */
  async relayQueued(row) {
    const key = this.keyFor(row);
    const { messages = [] } = await this.relay.messages(row.sessionId, { status: 'queued', limit: 100 });
    return messages.map((m) => { const p = openPayload(m.ciphertext ?? m.content?.ciphertext, key); return { turn: m.turnId ?? null, message: m.id ?? m.messageId ?? null, text: p?.t === 'plain' ? p.text : null, status: m.status }; });
  }

  // ── the feed ─────────────────────────────────────────────────────────────
  start() {
    if (this.#stop) return;
    this.#stop = this.relay.stream({
      onHello: (sessions) => { for (const s of sessions) if (!this.lastSeq.has(s.sessionId)) this.lastSeq.set(s.sessionId, Number(s.headSeq) || 0); this.#schedule(); },
      onPoke: (sessionId) => { this.#pending.add(sessionId); this.#schedule(); },
      onClose: () => this.log('stream closed; reconnecting'),
      onError: (e) => this.log(`stream: ${e?.message ?? e}`),
    });
    this.#timer = setInterval(() => { for (const id of this.rows.keys()) this.#pending.add(id); this.#schedule(); }, this.pollMs);
  }
  stop() { this.#stop?.(); this.#stop = null; if (this.#timer) clearInterval(this.#timer); this.#timer = null; }
  #scheduled = null;
  #schedule() {
    if (this.#scheduled) return;
    this.#scheduled = setTimeout(() => { this.#scheduled = null; this.#drain().catch((e) => this.log(`drain: ${e?.message ?? e}`)); }, 150);
  }
  async #drain() {
    await this.refresh();
    const ids = [...this.#pending]; this.#pending.clear();
    for (const id of ids) {
      const row = this.rows.get(id);
      if (!row) continue;
      try { await this.#scan(row); } catch (e) { this.log(`scan ${id.slice(0, 8)}: ${e?.message ?? e}`); }
    }
    // Every row's check state is watched, poked or not: a card change (a
    // dialog appearing) arrives as a poke too, but the poll catches what a
    // dropped stream missed.
    for (const row of this.rows.values()) this.#observeCheck(row);
  }
  async #scan(row) {
    const key = this.keyFor(row);
    let after = this.lastSeq.get(row.sessionId) ?? 0;
    const head = Number(row.headSeq) || 0;
    if (head <= after) return;
    // A turn's output and its end can arrive in different scans (one poke
    // each): the text accumulates per session until the end is seen.
    const texts = this.pendingText.get(row.sessionId) ?? [];
    this.pendingText.set(row.sessionId, texts);
    let ended = null;
    while (after < head) {
      const page = await this.relay.events(row.sessionId, { after, limit: 200 });
      const events = page.messages ?? [];
      if (!events.length) break;
      for (const e of events) {
        after = Math.max(after, Number(e.seq));
        const end = turnEndOf(e, key);
        if (end) {
          // One end per turn: the daemon's turn-end record and the relay's
          // terminal marker both arrive; whichever comes first ends it.
          const seen = this.endedTurns.get(row.sessionId) ?? new Set();
          this.endedTurns.set(row.sessionId, seen);
          if (end.turn && seen.has(end.turn)) continue;
          if (end.turn) { seen.add(end.turn); if (seen.size > 500) seen.delete(seen.values().next().value); }
          const text = stripDirectives(texts.join('\n\n'));
          const q = questionOf(text);
          ended = { ...end, seq: Number(e.seq) };
          this.#emit(row, { kind: 'turn_ended', turn: end.turn, status: end.status ?? 'completed', text, ...(q ? { question: q.question, options: q.options } : {}) });
          texts.length = 0;
          this.lastEndSeq.set(row.sessionId, Number(e.seq));
          continue;
        }
        const p = recordOf(e, key);
        const ev = p?.t === 'record' ? p.record?.content?.data?.ev : null;
        if (ev?.t === 'text' && typeof ev.text === 'string' && !ev.thinking) texts.push(ev.text);
        else if (p?.t === 'plain' && e.kind !== 'turn.queued') texts.push(p.text);
      }
      if (!page.hasMore) break;
    }
    this.lastSeq.set(row.sessionId, after);
    if (ended) {
      try { const st = await this.relay.sessionState(row.sessionId); this.execution.set(row.sessionId, st.execution?.state ?? null); } catch { /* keep */ }
    }
  }
  #observeCheck(row) {
    const view = this.viewOf(row);
    const prev = this.prevCheck.get(row.sessionId);
    const cur = view.check_state;
    this.prevCheck.set(row.sessionId, cur);
    if (prev === undefined || prev === cur) return;
    if (cur === 'needs_input') this.#emit(row, { kind: 'needs_input', blocked: view.blocked });
    else if (cur === 'ended' || cur === 'unreachable') this.#emit(row, { kind: cur === 'ended' ? 'ended' : 'unreachable', state: view.state });
  }
  #emit(row, ev) {
    const entry = { cursor: ++this.cursor, at: Date.now(), session: row.localSessionId ?? row.sessionId, relay_id: row.sessionId, ...ev };
    this.feed.push(entry);
    if (this.feed.length > 5000) this.feed.splice(0, this.feed.length - 5000);
    this.emit('event', entry);
  }
  updatesSince(cursor, limit = 100) {
    const events = this.feed.filter((e) => e.cursor > cursor).slice(0, limit);
    const last = events.length ? events[events.length - 1].cursor : Math.max(cursor, this.cursor);
    return { events, cursor: last, more: this.feed.some((e) => e.cursor > last) };
  }
  /** Resolve on the first feed event for one of `relayIds` (null = any)
   *  after `sinceCursor`, or at the deadline. */
  waitFor(relayIds, timeoutMs, sinceCursor = this.cursor) {
    const match = (e) => (!relayIds || relayIds.includes(e.relay_id)) && e.cursor > sinceCursor && (e.kind === 'turn_ended' || e.kind === 'needs_input' || e.kind === 'ended');
    const already = this.feed.filter(match);
    if (already.length) return Promise.resolve({ outcome: 'answered', events: already, cursor: already[already.length - 1].cursor });
    return new Promise((resolve) => {
      const done = (r) => { clearTimeout(t); this.off('event', on); resolve(r); };
      const on = (e) => { if (match(e)) done({ outcome: e.kind === 'needs_input' ? 'needs_input' : 'answered', events: [e], cursor: e.cursor }); };
      const t = setTimeout(() => done({ outcome: 'timeout', events: [], cursor: this.cursor }), timeoutMs);
      this.on('event', on);
    });
  }
}

export class ModelError extends Error {
  constructor(code, message) { super(message ?? code); this.code = code; }
}
