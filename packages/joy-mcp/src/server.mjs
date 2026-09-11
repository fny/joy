// The MCP surface: fifteen tools, four resources, and the notifications that
// turn the relay's doorbell into "your session finished". One McpServer per
// connection (the SDK's transport-per-session shape); the hub fans feed
// events out to the connections subscribed to a session.
//
// Semantics are the CLI's — packages/joy-daemon/src/cli.matrix.oracle.ts is
// the table each tool description quotes from.
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SubscribeRequestSchema, UnsubscribeRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { sealSpawnSpec } from './crypto.mjs';
import { ModelError, questionOf } from './model.mjs';
import { TunnelError } from './daemon.mjs';
import { RelayError } from './relay.mjs';

const OUTCOMES = 'Outcomes: answered · needs_input · timeout · gone · error.';
// A tool call is one HTTP request; MCP clients cut long ones (the SDK at 60 s,
// the Claude app around there). So the waits default well under that and a
// timeout is a normal outcome: the caller calls again with the cursor / the
// turn, it is not an error.
const WAIT_DEFAULT_S = 45;
const WAIT_MAX_S = 300;
const WAIT_NOTE = 'Defaults to 45 s and returns outcome "timeout" when the deadline passes — call again to keep waiting (a tool call cannot outlive the client\'s request timeout).';

export class ToolError extends Error {
  constructor(code, message, next) { super(message); this.code = code; this.next = next; }
}

/** One result shape for every tool: JSON as text (for models) + structured. */
function ok(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }], structuredContent: data };
}
function fail(code, message, next) {
  const data = { error: code, message, ...(next ? { next } : {}) };
  return { isError: true, content: [{ type: 'text', text: JSON.stringify(data, null, 2) }], structuredContent: data };
}

/** Everything the tools share. */
export class Hub {
  /** @param {{ index: import('./model.mjs').SessionIndex, tunnel: import('./daemon.mjs').DaemonTunnel, relay: import('./relay.mjs').RelayClient, log?: (s: string) => void }} opts */
  constructor({ index, tunnel, relay, log = () => {} }) {
    this.index = index; this.tunnel = tunnel; this.relay = relay; this.log = log;
    this.connections = new Set(); // { server, subs: Set<uri> }
    index.on('event', (e) => this.#fanout(e));
  }
  #fanout(e) {
    const uris = new Set(['joy://sessions', `joy://sessions/${e.session}`, `joy://sessions/${e.session}/state`]);
    for (const c of this.connections) {
      for (const uri of uris) {
        if (!c.subs.has(uri)) continue;
        c.server.server.sendResourceUpdated({ uri }).catch(() => {});
      }
      if (c.logging) {
        const text = e.kind === 'turn_ended' ? `${e.session}: turn ${e.status}${e.text ? ` — ${e.text.slice(0, 200)}` : ''}`
          : e.kind === 'needs_input' ? `${e.session}: needs input (${e.blocked?.kind ?? 'question'})`
          : `${e.session}: ${e.kind}`;
        c.server.server.sendLoggingMessage({ level: e.kind === 'needs_input' ? 'warning' : 'info', logger: 'joy', data: text }).catch(() => {});
      }
    }
  }

  /** Resolve a session argument to a relay row, with the CLI's errors. */
  row(id) {
    const r = this.index.resolve(id);
    if (!r) throw new ToolError('session_not_found', `no session matching "${id}" on this account`, 'list_sessions');
    return r;
  }
  view(row) { return this.index.viewOf(row); }

  /** `check` as the daemon computes it when reachable, else from the card. */
  async check(row) {
    const view = this.view(row);
    if (view.check_state === 'ended' || view.check_state === 'unreachable') {
      return { state: view.check_state, session: view.id, ladder: view.state, queue: view.queue?.depth ?? 0, mode: view.mode };
    }
    try {
      const d = await this.tunnel.check(row);
      const relayQueued = Number(row.queuedTurns) || 0;
      const out = { session: view.id, ladder: view.state, ...d, queue: (Number(d.queue) || 0) + relayQueued, ...(relayQueued ? { relay_queued: relayQueued } : {}) };
      if (out.state === 'idle' && view.blocked) { out.state = 'needs_input'; out.blocked = view.blocked; }
      if (out.state === 'idle' && relayQueued) out.state = 'busy'; // the relay is about to hand the daemon a turn
      return out;
    } catch (e) {
      if (e instanceof TunnelError || e instanceof RelayError) {
        // The card's reading, with the question read the daemon would do.
        const base = { session: view.id, ladder: view.state, state: view.check_state, queue: view.queue?.depth ?? 0, mode: view.mode, ...(view.blocked ? { blocked: view.blocked } : {}), via: 'relay', reason: e.code ?? e.message };
        if (base.state === 'idle') {
          const q = questionOf(await this.index.lastReply(row));
          if (q) return { ...base, state: 'needs_input', ...q };
        }
        return base;
      }
      throw e;
    }
  }

  async send(row, text, { exclusive = false, replyTo = null, from }) {
    const view = this.view(row);
    if (view.check_state === 'ended') throw new ToolError('session_ended', 'a detached session takes no text', 'new_session with resume, or the app\'s Resume');
    if (view.check_state === 'unreachable') throw new ToolError('machine_unreachable', `the daemon on ${view.machine.name} is not answering`, 'machines shows who is online');
    const before = await this.check(row).catch(() => null);
    const busy = before && before.state !== 'idle';
    const cmd = /^\/(steer|btw|title|login-code|joy-prompt)\b/.exec(text.trim());
    if (exclusive) {
      if (busy) throw new ToolError('busy', `session ${view.id} is busy (${before.state})`, 'send without no_queue, or wait');
      const mode = before?.permissionMode ?? view.mode;
      if (mode && mode !== 'bypassPermissions' && mode !== 'yolo' && mode !== 'plan' && mode !== 'read-only') throw new ToolError('mode_not_scriptable', `mode "${mode}" is neither yolo nor read-only`, 'a plain send, or change the mode in the app');
    }
    if (cmd && busy) {
      // A daemon-owned command mid-turn goes over the tunnel, like the app's steer.
      const r = await this.tunnel.steer(row, text, { exclusive, replyTo });
      if (r.error) throw new ToolError(r.error, `the daemon refused: ${r.error}`);
      return { turn: r.queued_id ?? null, queued: false, via: 'tunnel', check: before };
    }
    const wrapped = wrap(text, from, replyTo);
    const accepted = await this.relay.sendCiphertext(row.sessionId, this.index.sealFor(row, wrapped));
    // `queued` is judged after the relay accepted the row, not from the
    // snapshot before: three sends racing from two clients all saw an idle
    // session, yet only one could go first. Ahead of this row: the turn the
    // relay has running (if it is not ours) and every earlier row still
    // waiting to be picked up.
    let ahead = 0;
    try {
      const [st, q, d] = await Promise.all([
        this.relay.sessionState(row.sessionId),
        this.relay.messages(row.sessionId, { status: 'queued', limit: 500 }),
        this.relay.messages(row.sessionId, { status: 'delivering', limit: 500 }),
      ]);
      const active = st.execution?.turnId ?? null;
      this.index.execution.set(row.sessionId, st.execution?.state ?? null);
      if (active && active !== accepted.turnId) ahead += 1;
      for (const m of [...(q.messages ?? []), ...(d.messages ?? [])]) {
        if (m.id !== accepted.messageId && m.turnId !== active && Number(m.seq) < Number(accepted.seq)) ahead += 1;
      }
    } catch { /* the snapshot verdict stands */ }
    const queued = !!busy || ahead > 0;
    return { turn: accepted.turnId, message: accepted.messageId, queued, ahead, ...(busy ? { check: before } : {}) };
  }
}

/** The provenance wrapper the daemon stamps for CLI sends; here the server
 *  is the sender, so it stamps the same shape with an mcp:* identity. */
function wrap(text, from, replyTo) {
  const body = text.trim().replace(/^<joy-message\b[^>]*>\s*/i, '').replace(/\s*<\/joy-message>\s*$/i, '');
  // A connected client speaks FOR the account's owner, so by default the
  // text goes in as the human's — unwrapped, like the app's own sends. The
  // peer wrapper is stamped only when reply_to names a joy session that
  // should answer: the agents' instruction line reads a wrapper with no
  // reply-to as "read it and move on", and Codex did exactly that — empty
  // replies to every ask (lab, 2026-09-11).
  if (!replyTo) return body;
  const attrs = `from="${from}" reply-to="${replyTo}"`;
  const cmd = /^\/(steer|btw)\s+([\s\S]+)$/.exec(body);
  if (cmd) return `/${cmd[1]} <joy-message ${attrs}>\n${cmd[2].trim()}\n</joy-message>`;
  if (/^\/(title|login-code|joy-prompt)\b/.test(body)) return body;
  return `<joy-message ${attrs}>\n${body}\n</joy-message>`;
}

const SESSION = z.string().describe('The session: its joy id (eight hex characters, as the app and CLI show it), the relay id, or a unique prefix of either.');

/** Build the McpServer for one connection. */
export function createMcpServer(hub, { clientLabel = 'mcp' } = {}) {
  const server = new McpServer({ name: 'joy', version: '0.1.0' }, {
    capabilities: { resources: { subscribe: true, listChanged: false }, logging: {}, tools: {} },
    instructions: [
      'joy runs coding agents (Claude Code, Codex, opencode, pi) in terminal sessions on the user\'s machines. This server sees and drives every session on the account.',
      'Sessions are addressed by their joy id (eight hex characters). Start with list_sessions or session.',
      'send queues behind a running turn and returns at once; ask sends and waits for that turn\'s reply; wait_for_turns watches sessions until one finishes or needs a human.',
      'A session that needs input (an approval, a login, a dialog in the terminal, or a question with offered answers) is waiting on a human: approve/deny answers approvals, send answers a question, the rest is answered in the app or terminal.',
      'What you send arrives at the agent as its human\'s message (you act for the account\'s owner); with reply_to it arrives as a peer message the agent answers to that joy session.',
    ].join(' '),
  });
  const conn = { server, subs: new Set(), logging: false };
  hub.connections.add(conn);
  server.server.onclose = () => hub.connections.delete(conn);
  server.server.setRequestHandler(SubscribeRequestSchema, async ({ params }) => { conn.subs.add(params.uri); return {}; });
  server.server.setRequestHandler(UnsubscribeRequestSchema, async ({ params }) => { conn.subs.delete(params.uri); return {}; });
  server.server.oninitialized = () => { conn.logging = true; };
  const from = `mcp:${clientLabel}`;

  const guard = (fn) => async (args, extra) => {
    try { return ok(await fn(args ?? {}, extra)); }
    catch (e) {
      if (e instanceof ToolError) return fail(e.code, e.message, e.next);
      if (e instanceof ModelError) return fail(e.code, e.message, 'list_sessions');
      if (e instanceof TunnelError) return fail(e.code === 'machine_unreachable' ? 'machine_unreachable' : `tunnel_${e.code}`, e.message, 'retry later; machines shows who is online');
      if (e instanceof RelayError) return fail(e.code === 'session_not_found' ? 'session_not_found' : `relay_${e.code}`, e.message);
      hub.log(`tool error: ${e?.stack ?? e}`);
      return fail('error', e?.message ?? String(e));
    }
  };

  // ── orientation ──────────────────────────────────────────────────────────
  server.registerTool('list_sessions', {
    title: 'List sessions',
    description: 'Every session on every machine, newest first, with machine, folder, title and state. Filters narrow; archived and headless sessions are omitted unless asked for.',
    inputSchema: {
      machine: z.string().optional().describe('Only this machine (id, prefix, or name).'),
      state: z.string().optional().describe('Only sessions in this ladder state (blocked, unread, thinking, waiting, detached, disconnected, …) or check state (idle, busy, needs_input, ended, unreachable).'),
      include_archived: z.boolean().optional(),
      include_headless: z.boolean().optional(),
    },
  }, guard(async (a) => {
    await hub.index.refresh();
    let views = hub.index.views();
    if (!a.include_archived) views = views.filter((v) => v.relay_state !== 'archived' && v.state !== 'archived');
    if (!a.include_headless) views = views.filter((v) => !v.headless);
    if (a.machine) { const m = hub.index.machine(a.machine); views = views.filter((v) => v.machine.id === (m?.id ?? a.machine)); }
    if (a.state) views = views.filter((v) => v.state === a.state || v.check_state === a.state);
    return { sessions: views.map(({ relay_id, relay_state, readable, ...v }) => v), count: views.length };
  }));

  server.registerTool('session', {
    title: 'Session in full',
    description: 'One session: its row, status as check computes it, pending approvals, the queue, and the conversation newest-last (user, assistant and one-line tool rows). Page backwards with before = the older cursor.',
    inputSchema: { session: SESSION, before: z.number().optional().describe('Page back from this seq (the older cursor of a previous call).'), limit: z.number().int().min(1).max(200).optional() },
  }, guard(async (a) => {
    await hub.index.refresh();
    const row = hub.row(a.session);
    const view = hub.view(row);
    const [check, page, approvals, queue] = await Promise.all([
      hub.check(row),
      hub.index.messages(row, { before: a.before, limit: a.limit ?? 50 }),
      view.check_state === 'ended' || view.check_state === 'unreachable' ? [] : hub.tunnel.approvals(row).catch(() => []),
      view.check_state === 'ended' || view.check_state === 'unreachable' ? null : hub.tunnel.queue(row).catch(() => null),
    ]);
    const { relay_id, relay_state, readable, ...v } = hub.view(row); // re-read: messages() marked it read
    return { ...v, check, approvals, queue: queue ? { items: (queue.queue ?? []).map((q) => ({ turn: q.id, text: q.text })), paused: !!queue.paused, ...(queue.pauseReason ? { pause_reason: queue.pauseReason } : {}) } : v.queue, messages: page.messages, older: page.older };
  }));

  server.registerTool('check', {
    title: 'Can it be talked to right now?',
    description: 'The decision input before a send. state: idle | busy | needs_input | ended | unreachable, with what it is waiting on (approvals, a question with options, a login or dialog). A paused queue reads as idle with a count; queue names the pause.',
    inputSchema: { session: SESSION },
  }, guard(async (a) => { await hub.index.refresh(); return hub.check(hub.row(a.session)); }));

  // ── talking ──────────────────────────────────────────────────────────────
  server.registerTool('send', {
    title: 'Send text',
    description: `Deliver text through the durable queue. If a turn is running the text waits behind it and runs when it ends — the result then carries check so you see what it is behind. no_queue refuses instead (busy) and drives only yolo/read-only sessions. No reply-to is stamped unless reply_to names a joy session. Daemon-owned slash commands (/steer, /title, /joy-prompt) are intercepted daemon-side; /steer mid-turn lands in the running turn. Answer a question with offered options by sending the option's text or number.`,
    inputSchema: { session: SESSION, text: z.string().min(1), no_queue: z.boolean().optional(), reply_to: z.string().regex(/^joy:[0-9a-f]{8}$/).optional().describe('Deliver as a PEER message the agent answers to this joy session (joy:<id>). Without it the text goes in as the human\'s own, and the reply is the session\'s next turn (ask / wait_for_turns).') },
  }, guard(async (a) => {
    await hub.index.refresh();
    return hub.send(hub.row(a.session), a.text, { exclusive: !!a.no_queue, replyTo: a.reply_to ?? null, from });
  }));

  server.registerTool('ask', {
    title: 'Send and wait for the reply',
    description: `Send, wait for that turn, return what it said. The reply is the text of the turn the daemon ran for this send, never the tail of a turn already running. A session that needs a human ends the wait at once with needs_input; the sent text stays queued. On timeout the result carries the turn id: wait_for_turns on the session picks it up. ${WAIT_NOTE} ${OUTCOMES}`,
    inputSchema: { session: SESSION, text: z.string().min(1), timeout_s: z.number().min(1).max(WAIT_MAX_S).optional().describe(`Seconds to wait; default ${WAIT_DEFAULT_S}, max ${WAIT_MAX_S}.`), no_queue: z.boolean().optional() },
  }, guard(async (a) => {
    await hub.index.refresh();
    const row = hub.row(a.session);
    const since = hub.index.cursor;
    const sent = await hub.send(row, a.text, { exclusive: !!a.no_queue, from });
    if (!sent.turn) return { outcome: 'answered', text: '', turn: null, reason: 'handled by the daemon itself, no turn' };
    const deadline = Date.now() + (a.timeout_s ?? WAIT_DEFAULT_S) * 1000;
    let cursor = since;
    for (;;) {
      const left = deadline - Date.now();
      if (left <= 0) return { outcome: 'timeout', turn: sent.turn, text: '', check: await hub.check(row).catch(() => null) };
      const r = await hub.index.waitFor([row.sessionId], left, cursor);
      if (r.outcome === 'timeout') return { outcome: 'timeout', turn: sent.turn, text: '', check: await hub.check(row).catch(() => null) };
      cursor = r.cursor;
      const ev = r.events[r.events.length - 1];
      if (ev.kind === 'needs_input') return { outcome: 'needs_input', turn: sent.turn, text: '', check: await hub.check(row).catch(() => null) };
      if (ev.kind === 'ended') return { outcome: 'gone', turn: sent.turn, text: '', reason: ev.state };
      if (ev.kind === 'turn_ended' && (ev.turn === sent.turn || ev.turn == null)) {
        return { outcome: ev.status === 'completed' ? 'answered' : 'error', turn: sent.turn, text: ev.text ?? '', status: ev.status };
      }
      // Another turn ended (the one ahead of ours) — keep waiting for ours.
      const t = await hub.relay.turn(row.sessionId, sent.turn).catch(() => null);
      if (t && (t.state === 'completed' || t.terminalState) && ev.turn !== sent.turn) {
        // Ours already ended without a matching record turn id (older daemon): the latest text is the best answer.
        return { outcome: 'answered', turn: sent.turn, text: ev.text ?? '', status: t.terminalState ?? t.state, attribution: 'by order' };
      }
    }
  }));

  server.registerTool('wait_for_turns', {
    title: 'Wait until a session finishes or needs a human',
    description: `Block until any watched session finishes a turn, comes to need input, or ends — the long-poll that makes "tell me when it's done" work in every client. No sessions means every session on the account. Returns the events and a cursor for updates_since. ${WAIT_NOTE} ${OUTCOMES}`,
    inputSchema: { sessions: z.array(z.string()).optional(), timeout_s: z.number().min(1).max(WAIT_MAX_S).optional().describe(`Seconds to wait; default ${WAIT_DEFAULT_S}, max ${WAIT_MAX_S}.`), since: z.number().int().min(0).optional().describe('A cursor from a previous call: events after it are returned even if they happened before this call.') },
  }, guard(async (a) => {
    await hub.index.refresh();
    const ids = a.sessions?.length ? a.sessions.map((s) => hub.row(s).sessionId) : null;
    const r = await hub.index.waitFor(ids, (a.timeout_s ?? WAIT_DEFAULT_S) * 1000, a.since ?? hub.index.cursor);
    return { outcome: r.outcome, events: r.events.map(publicEvent), cursor: r.cursor };
  }));

  server.registerTool('updates_since', {
    title: 'Updates since a cursor',
    description: 'The same events as a page from a cursor (0 = the start of this server\'s memory), for clients that poll: turn_ended (with the reply text), needs_input, ended, unreachable.',
    inputSchema: { cursor: z.number().int().min(0), limit: z.number().int().min(1).max(500).optional() },
  }, guard(async (a) => { const r = hub.index.updatesSince(a.cursor, a.limit ?? 100); return { ...r, events: r.events.map(publicEvent) }; }));

  server.registerTool('events', {
    title: 'Raw records',
    description: 'The raw adapter records behind the conversation — text, tool calls with arguments, turn lifecycle, usage — for when the folded messages in session are not enough.',
    inputSchema: { session: SESSION, last: z.number().int().min(1).max(500).optional().describe('Default 12.') },
  }, guard(async (a) => {
    await hub.index.refresh();
    const row = hub.row(a.session);
    const page = await hub.relay.events(row.sessionId, { before: Number(row.headSeq) + 1, limit: a.last ?? 12 });
    const key = hub.index.keyFor(row);
    const { recordOf } = await import('./model.mjs');
    return { records: (page.messages ?? []).map((e) => ({ seq: Number(e.seq), kind: e.kind, turn: e.turnId, at: e.createdAt, payload: recordOf(e, key) })) };
  }));

  // ── decisions ────────────────────────────────────────────────────────────
  server.registerTool('approvals', {
    title: 'Held approvals',
    description: 'The approvals the agent is holding for a human, oldest first: { request_id, kind: command | patch, title, detail?, since }. A permission prompt reported by a hook (Claude\'s terminal dialog) is answered in the terminal or the app and does not appear here.',
    inputSchema: { session: SESSION },
  }, guard(async (a) => { await hub.index.refresh(); return { approvals: (await hub.tunnel.approvals(hub.row(a.session))).map(pubApproval) }; }));

  for (const [name, decision, title] of [['approve', 'allow', 'Approve'], ['deny', 'deny', 'Deny']]) {
    server.registerTool(name, {
      title: `${title} an approval`,
      description: `${title} the head approval, or a named one. { ok, request_id }, or { ok: true, none: true } when nothing was pending. After approve the agent carries on with its turn; after deny it stops.`,
      inputSchema: { session: SESSION, request_id: z.string().optional() },
    }, guard(async (a) => {
      await hub.index.refresh();
      const row = hub.row(a.session);
      let id = a.request_id;
      if (!id) { const list = await hub.tunnel.approvals(row); if (!list.length) return { ok: true, none: true }; id = list[0].requestId; }
      const r = await hub.tunnel.answer(row, id, decision === 'allow');
      if (!r.ok) throw new ToolError('no_such_approval', `no approval ${id} is pending`, 'approvals');
      return { ok: true, request_id: id, decision };
    }));
  }

  // ── control ──────────────────────────────────────────────────────────────
  server.registerTool('abort', {
    title: 'Interrupt the running turn',
    description: 'Interrupt the running turn. Queued rows survive and run next. { ok:false } when there is no runtime to interrupt (a detached session). On an idle session the daemon still sends a session-wide Escape, since a turn started in the terminal is invisible to it.',
    inputSchema: { session: SESSION },
  }, guard(async (a) => { await hub.index.refresh(); return hub.tunnel.abort(hub.row(a.session)); }));

  server.registerTool('queue', {
    title: 'The queue',
    description: 'The rows waiting behind the running turn, and whether the queue is paused (a dispatch gave up on the pane).',
    inputSchema: { session: SESSION },
  }, guard(async (a) => {
    await hub.index.refresh();
    const row = hub.row(a.session);
    const [q, held] = await Promise.all([hub.tunnel.queue(row), hub.index.relayQueued(row).catch(() => [])]);
    // Two places a row can wait: the relay's durable queue (until the daemon
    // claims it — one turn at a time) and the daemon's own queue behind a
    // running turn. Both are "queued" to a caller.
    const items = [...held.map((h) => ({ turn: h.turn, text: h.text, at: 'relay' })), ...(q.queue ?? []).map((x) => ({ turn: x.id, text: x.text, at: 'daemon', ...(x.from ? { from: x.from, ...(x.fromLabel ? { from_label: x.fromLabel } : {}) } : {}) }))];
    return { items, pending: items.length, running: q.running ? { turn: q.running.id, text: q.running.text } : null, paused: !!q.paused, ...(q.pauseReason ? { pause_reason: q.pauseReason } : {}) };
  }));
  server.registerTool('queue_cancel', {
    title: 'Drop a queued row', description: 'Drop one queued row by its turn id (the id send returned).',
    inputSchema: { session: SESSION, turn: z.string() },
  }, guard(async (a) => { await hub.index.refresh(); const r = await hub.tunnel.queueCancel(hub.row(a.session), a.turn); if (r.ok === false) throw new ToolError('not_queued', `${a.turn} is not a queued row`, 'queue'); return { ok: true, turn: a.turn }; }));
  server.registerTool('queue_resume', {
    title: 'Resume a paused queue', description: 'Release a queue the daemon paused because a dispatch timed out, mismatched, or found the input box dirty; the stuck row is dispatched.',
    inputSchema: { session: SESSION },
  }, guard(async (a) => { await hub.index.refresh(); const r = await hub.tunnel.queueResume(hub.row(a.session)); return { ok: r.ok !== false, pending: r.pendingCount ?? 0 }; }));

  server.registerTool('kill', {
    title: 'End a session',
    description: 'End the session and its terminal window. Queued rows are dropped with it. if_state refuses with status_mismatch when the session is no longer in that state, so a cleanup never kills a session that just restarted.',
    inputSchema: { session: SESSION, if_state: z.enum(['starting', 'active', 'ended']).optional() },
  }, guard(async (a) => {
    await hub.index.refresh();
    const row = hub.row(a.session);
    const view = hub.view(row);
    if (view.check_state === 'unreachable') {
      // No daemon to ask: the relay record can still go.
      await hub.relay.deleteSession(row.sessionId);
      return { ok: true, via: 'relay' };
    }
    const r = await hub.tunnel.kill(row, a.if_state);
    if (r.error === 'status_mismatch') throw new ToolError('status_mismatch', `the session is ${r.status}, not ${a.if_state}`, 'check');
    if (r.ok === false) throw new ToolError('kill_failed', r.error ?? 'the daemon refused');
    return { ok: true };
  }));

  // ── creating ─────────────────────────────────────────────────────────────
  server.registerTool('machines', {
    title: 'Machines',
    description: 'The machines on the account and which harnesses each can run (models, permission modes, the default mode), from the daemon\'s capability table.',
    inputSchema: {},
  }, guard(async () => {
    await hub.index.refresh();
    const out = [];
    for (const m of hub.index.machines.values()) {
      let harnesses = [];
      if (m.online) harnesses = (await hub.tunnel.harnesses(m.id).catch(() => [])).map((h) => ({ name: h.name ?? h.harness, ...(h.capabilities ? { models: h.capabilities.models, permission_modes: h.capabilities.permissions?.modes?.map((x) => x.key), default_mode: h.capabilities.permissions?.default } : {}) }));
      out.push({ id: m.id, name: m.name, online: m.online, host: m.meta?.host ?? null, platform: m.meta?.platform ?? null, daemon_version: m.meta?.joyDaemonVersion ?? null, harnesses });
    }
    return { machines: out };
  }));

  server.registerTool('new_session', {
    title: 'Spawn a session',
    description: 'Spawn a session in a folder on a machine. No mode means the harness\'s own no-prompts mode. With message the first turn starts at once. headless keeps it out of the app\'s list and sends no turn-done push (it still surfaces when it needs a human).',
    inputSchema: {
      machine: z.string(), dir: z.string(), agent: z.enum(['claude', 'codex', 'opencode', 'pi', 'agy']).optional(),
      model: z.string().optional(), effort: z.string().optional(), mode: z.string().optional(), headless: z.boolean().optional(),
      message: z.string().optional(), continue: z.boolean().optional(), resume: z.string().optional(), create_dir: z.boolean().optional(),
    },
  }, guard(async (a) => {
    await hub.index.refresh();
    const m = hub.index.machine(a.machine);
    if (!m) throw new ToolError('machine_not_found', `no machine matching "${a.machine}"`, 'machines');
    if (!m.online) throw new ToolError('machine_unreachable', `${m.name} is offline`, 'machines');
    const spec = { cwd: a.dir, agent: a.agent ?? 'claude', createDir: a.create_dir !== false, ...(a.model ? { model: a.model } : {}), ...(a.effort ? { effort: a.effort } : {}), ...(a.mode ? { permissionMode: a.mode } : {}), ...(a.continue ? { continue: true } : {}), ...(a.resume ? { resume_id: a.resume } : {}), ...(a.headless ? { headless: true } : {}) };
    const sealed = m.capabilities?.spawnSpecSealed ? sealSpawnSpec(spec, m.key, m.id) : sealSpawnSpec(spec, null, m.id);
    const created = await hub.relay.createSession(m.id, sealed);
    const relayId = created.sessionId ?? created.session?.sessionId ?? created.id;
    // Wait for the daemon to bind it (local id + key envelope), briefly.
    // A fresh harness takes a while to announce its local id (Claude: the
    // trust dialog, the first transcript line); 20 s was not always enough
    // and the tool then answered with the relay's id where the caller
    // expected the session id every other tool speaks. Wait longer, and say
    // when the id is still the relay's.
    let row = null;
    let retried = false;
    for (let i = 0; i < 120 && !row?.localSessionId; i++) {
      await new Promise((r) => setTimeout(r, 500)); await hub.index.refresh(); row = hub.index.rows.get(relayId) ?? null;
      if (row?.state === 'failed') {
        // The daemon reported the spawn failed. A missing directory is the
        // one failure the caller already answered (create_dir): retry with
        // the relay's own create flag, the way the app's "Create it?" does.
        const st = await hub.relay.sessionState(relayId).catch(() => null);
        const why = st?.spawnFailure ?? 'spawn_failed';
        if (String(why).startsWith('dir_missing') && a.create_dir !== false && !retried) { retried = true; await hub.relay.retrySpawn(relayId, true); continue; }
        throw new ToolError('spawn_failed', `the daemon could not start the session: ${why}`, `fix the cause, then new_session again (this row stays as ${relayId.slice(0, 8)}, failed)`);
      }
    }
    if (!row) throw new ToolError('spawn_pending', 'the relay accepted the spawn but the daemon has not announced it yet', `list_sessions, then session ${relayId}`);
    const out = { ...hub.view(row), ...(row.localSessionId ? {} : { pending: true, note: 'the daemon has not announced the session id yet; this is the relay id, which every tool also accepts' }) };
    delete out.relay_id; delete out.relay_state; delete out.readable;
    if (a.message && row.localSessionId) {
      const sent = await hub.send(row, a.message, { from });
      return { ...out, turn: sent.turn };
    }
    return out;
  }));

  // ── resources ────────────────────────────────────────────────────────────
  server.registerResource('sessions', 'joy://sessions', { title: 'Session index', description: 'One line per session: id, state, machine, folder, title.', mimeType: 'text/plain' }, async (uri) => {
    await hub.index.refresh();
    const lines = hub.index.views().filter((v) => v.relay_state !== 'archived').map((v) => `${v.id}  ${v.state.padEnd(12)} ${v.machine.name.padEnd(12)} ${v.harness.padEnd(8)} ${v.title ?? ''}  ${v.cwd ?? ''}`);
    return { contents: [{ uri: uri.href, mimeType: 'text/plain', text: lines.join('\n') || '(no sessions)' }] };
  });
  server.registerResource('session', new ResourceTemplate('joy://sessions/{id}', { list: undefined }), { title: 'Session transcript', description: 'The conversation, newest last; tool calls folded to one line.', mimeType: 'text/plain' }, async (uri, { id }) => {
    await hub.index.refresh();
    const row = hub.row(String(id));
    const { messages } = await hub.index.messages(row, { limit: 100 });
    const text = messages.map((m) => `[${new Date(m.at).toISOString()}] ${m.role}${m.from ? ` (${m.from})` : ''}: ${m.text}`).join('\n\n');
    return { contents: [{ uri: uri.href, mimeType: 'text/plain', text }] };
  });
  server.registerResource('session-state', new ResourceTemplate('joy://sessions/{id}/state', { list: undefined }), { title: 'Session state', description: 'The check record as JSON.', mimeType: 'application/json' }, async (uri, { id }) => {
    await hub.index.refresh();
    return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(await hub.check(hub.row(String(id))), null, 2) }] };
  });
  server.registerResource('machines', 'joy://machines', { title: 'Machines', mimeType: 'application/json' }, async (uri) => {
    await hub.index.refresh();
    return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify([...hub.index.machines.values()].map((m) => ({ id: m.id, name: m.name, online: m.online })), null, 2) }] };
  });

  return server;
}

function publicEvent(e) { const { relay_id, ...rest } = e; return rest; }
function pubApproval(a) { return { request_id: a.requestId, kind: a.kind, title: a.title, ...(a.detail ? { detail: a.detail } : {}), since: a.since }; }
