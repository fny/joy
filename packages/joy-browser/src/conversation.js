// Session events (the relay's, or the daemon's in Direct mode) → the rows
// the chat panel shows. Pure.
//
// The panel is a view of ONE session, the way the app's chat is — except that
// the browser's own machinery is folded down: an agent's script is one line,
// and so is the answer the extension sent back for it.
import { displaySegments, browserMessageBody } from './tags.js';
import { agentEventOf, payloadOf } from './watcher.js';

/** One event → zero or one row, plus what it says about the turn. */
/** One of OUR messages to the agent. The attach notice is not an answer to
 *  anything, so it reads as a quiet line rather than a result. */
function browserRow(seq, body) {
  if (body.startsWith('A browser is now attached')) return { seq, role: 'tool', text: 'this browser attached to the session' };
  return { seq, role: 'browser', ok: !/^status: error$/m.test(body), text: body };
}

export function rowOf(event, key) {
  const seq = Number(event?.seq);
  if (!Number.isSafeInteger(seq) || seq < 1) return null;
  // The relay's own lifecycle events are the authority on whether a turn is
  // running: an adapter's turn-end record can be missing, a terminal never is.
  if (event?.kind === 'turn.started') return { seq, role: 'turn', working: true };
  if (event?.kind === 'turn.terminal') return { seq, role: 'turn', working: false, status: null };
  const p = payloadOf(event, key);
  if (!p) return null;
  if (p.t === 'plain') {
    // A queued prompt: the person's words, or one of our own answers.
    const ours = browserMessageBody(p.text);
    return ours !== null ? browserRow(seq, ours) : { seq, role: 'user', text: p.text };
  }
  const rec = p.record;
  if (!rec || typeof rec !== 'object') return null;
  if (rec.role === 'user') {
    const text = typeof rec.content?.text === 'string' ? rec.content.text : null;
    if (text === null) return null;
    const ours = browserMessageBody(text);
    return ours !== null ? browserRow(seq, ours) : { seq, role: 'user', text };
  }
  const ev = agentEventOf(rec); // the same reader the watcher trusts: what is shown as the agent IS the agent
  if (!ev) return null;
  if (ev.t === 'text' && typeof ev.text === 'string' && !ev.thinking) {
    const segments = displaySegments(ev.text);
    return segments.length ? { seq, role: 'agent', segments } : null;
  }
  if (ev.t === 'tool-call-start') return { seq, role: 'tool', text: String(ev.name ?? 'tool') };
  if (ev.t === 'turn-start') return { seq, role: 'turn', working: true };
  if (ev.t === 'turn-end') return { seq, role: 'turn', working: false, status: ev.status ?? null };
  return null;
}

/** Events → { rows, working }. `turn` rows steer `working` and are not shown. */
export function foldEvents(events, key, working = false) {
  const rows = [];
  for (const e of [...(events ?? [])].sort((a, b) => Number(a?.seq) - Number(b?.seq))) {
    const r = rowOf(e, key);
    if (!r) continue;
    if (r.role === 'turn') { working = r.working; continue; }
    if (r.role === 'user' || r.role === 'browser') working = true; // queued work: a turn is coming
    rows.push(r);
  }
  return { rows, working };
}
