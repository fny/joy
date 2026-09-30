// The loop that turns an agent's tag into a run and an answer.
// Everything chrome-specific is injected (`execute`, `store`), so this runs
// under `node --test` against a scripted relay.
//
// Three rules carry the safety of the whole extension:
//
//  1. ONLY THE AGENT'S OWN TEXT RUNS. A tag is honoured in a daemon-written
//     record whose role is `agent` and whose event is non-thinking text.
//     Prompts (`turn.queued`), mirrored user records and legacy plain payloads
//     never run — otherwise a page could print a tag into a result, the result
//     would be queued as a prompt, and the extension would execute its own
//     echo in a loop.
//  2. HISTORY IS NOT NEWS. Attaching starts at the session's head: a tag from
//     an hour ago must not fire because a browser just connected.
//  3. AT MOST ONCE. The cursor is saved BEFORE a script runs. A service worker
//     can die at any moment; re-running a script (a click, a form submit) on
//     restart is worse than the agent having to ask again.
import { openPayload } from './crypto.js';
import { extractBrowserTags, describeResult, browserMessage } from './tags.js';

/** An event's payload: already open when it came straight from the daemon
 *  (Direct mode), sealed under the session key when it came from the relay. */
export const payloadOf = (event, key) => event?.payload ?? (event?.content ? openPayload(event.content.ciphertext, key) : null);

/** The agent's visible text in one event, or null. */
export function agentTextOf(event, key) {
  if (event?.kind === 'turn.queued') return null;
  const p = payloadOf(event, key);
  if (!p || p.t !== 'record') return null;
  const ev = agentEventOf(p.record);
  return ev && ev.t === 'text' && typeof ev.text === 'string' && !ev.thinking ? ev.text : null;
}

/** The agent's event inside a wire record, or null for anything else. The
 *  daemon wraps agent events as { role: 'session', content: { type: 'session',
 *  data: { role: 'agent', ev } } }; a flat { role: 'agent', content: { data: { ev } } }
 *  is accepted too. A user's mirrored text ({ role: 'user' }) is never the agent. */
export function agentEventOf(rec) {
  if (!rec || typeof rec !== 'object') return null;
  const data = rec.content?.data;
  const fromAgent = rec.role === 'agent' || (rec.role === 'session' && rec.content?.type === 'session' && data?.role === 'agent');
  return fromAgent && data?.ev && typeof data.ev === 'object' ? data.ev : null;
}

export class Watcher {
  /** `execute(tag)` runs a script now; `remember(tag)` saves one for later and
   *  answers with `{ note }`; `onEvents(events, key)` sees every new event, in
   *  order, BEFORE anything in it runs — the chat shows the agent's words at
   *  once and the outcome when it lands. */
  constructor({ relay, store, execute, remember = null, onEvents = null, log = () => {} }) {
    this.relay = relay; this.store = store; this.execute = execute; this.remember = remember; this.onEvents = onEvents; this.log = log;
    this.running = null; this.again = false; this.stopped = false;
  }

  stop() { this.stopped = true; this.again = false; }
  note(text) { try { Promise.resolve(this.log(text)).catch(() => {}); } catch { /* diagnostic only */ } }

  /** Pokes and alarms overlap; polls must not. A request that arrives while a
   *  poll runs asks for exactly one more after it. */
  poll() {
    if (this.stopped) return Promise.resolve();
    if (this.running) { this.again = true; return this.running; }
    this.running = (async () => {
      try { do { this.again = false; await this.#once(); } while (this.again && !this.stopped); }
      finally { this.running = null; }
    })();
    return this.running;
  }

  async #once() {
    const state = await this.store.load();
    if (!state?.sessionId) return;
    const { sessionId, key } = state;
    const pending = state.pendingResult;
    if (pending && !this.stopped) {
      // `ciphertext` is a result saved before 0.3, sealed already.
      if (pending.ciphertext) await this.relay.sendCiphertext(sessionId, pending.ciphertext, pending.id);
      else await this.relay.sendText(sessionId, pending.text, key, pending.id);
      if (this.stopped || await this.store.clearResult?.(pending.id, state) === false) return;
    }
    let cursor = Number(state.cursor) || 0;
    while (!this.stopped) {
      const page = await this.relay.events(sessionId, cursor, 200);
      if (this.stopped) return;
      const raw = page?.messages ?? [];
      if (!raw.length) return;
      if (raw.some((e) => !Number.isSafeInteger(Number(e?.seq)) || Number(e.seq) < 1)) throw new Error('relay returned an invalid event sequence');
      const events = raw.filter((e) => Number(e.seq) > cursor).sort((a, b) => Number(a.seq) - Number(b.seq));
      if (!events.length) throw new Error('relay event page did not advance');
      try { await this.onEvents?.(events, key); } catch { /* a view must never stop the work */ }
      for (const e of events) {
        if (this.stopped) return;
        const seq = Number(e.seq);
        if (!(seq > cursor)) continue;
        cursor = seq;
        if (await this.store.saveCursor(cursor, state) === false || this.stopped) return; // claim only the still-linked session
        const tags = extractBrowserTags(agentTextOf(e, key) ?? '');
        if (!tags.length) continue;
        const results = [];
        for (const tag of tags) {
          if (this.stopped) return;
          try {
            if (tag.kind === 'remember') {
              this.note(`asked to remember "${tag.attrs.name ?? 'untitled script'}"`);
              results.push(this.remember ? await this.remember(tag) : { note: 'this browser cannot save scripts' });
            } else {
              this.note(`running ${tag.attrs.url ? `on ${tag.attrs.url}` : tag.attrs.tab ? `in tab ${tag.attrs.tab}` : 'in the active tab'} (${tag.code.length} chars)`);
              results.push(await this.execute(tag));
            }
          } catch (err) { results.push({ tab: null, error: err?.message ?? String(err) }); }
        }
        const body = results.map((r, i) => describeResult(r, i, results.length)).join('\n\n');
        const result = { id: crypto.randomUUID(), text: browserMessage(body) };
        if (this.stopped || await this.store.saveResult?.(result, state) === false) return;
        await this.relay.sendText(sessionId, result.text, key, result.id);
        await this.store.clearResult?.(result.id, state);
        this.note(`answered with ${results.length} result${results.length === 1 ? '' : 's'}${results.some((r) => r.error) ? ' (with errors)' : ''}`);
      }
    }
  }
}
