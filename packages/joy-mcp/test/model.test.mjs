// The state ladder on relay rows + cards, message folding, turn-end
// detection and the question read — pure, no relay.
import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { stateOf, checkStateOf, foldMessages, turnEndOf, questionOf, blockedOf, stripDirectives } from '../src/model.mjs';
import { sealText, sealV2Json } from '../src/crypto.mjs';

const key = new Uint8Array(randomBytes(32));
const rec = (ev, turn = 'T1', time = 5) => ({ role: 'session', content: { type: 'session', data: { time, turn, ev } } });
const sealedRec = (ev, turn, time) => sealV2Json({ v: 1, t: 'record', record: rec(ev, turn, time) }, key);
let seq = 0;
const ev = (kind, ciphertext, extra = {}) => ({ id: `e${++seq}`, seq: String(seq), kind, turnId: extra.turnId ?? 'T1', commandId: null, origin: null, content: ciphertext ? { ciphertext } : null, createdAt: 1000 + seq, ...extra });

describe('ladder', () => {
  const online = { online: true };
  it('follows the app: offline → disconnected; detached; blocked (login, dialog, approval) above unread above active above waiting', () => {
    expect(stateOf({ online: false }, {})).toBe('disconnected');
    expect(stateOf(online, { joy__state: 'detached' })).toBe('detached');
    expect(stateOf(online, { joy__login: { url: 'x' }, joy__thinking: { since: 1 } })).toBe('blocked');
    expect(stateOf(online, { joy__dialog: { title: 'Switch model?', options: [] } })).toBe('blocked');
    expect(stateOf(online, { joy__codexApproval: { title: 'rm', kind: 'command' } })).toBe('blocked');
    expect(stateOf(online, { joy__thinking: { since: 1 } }, { unread: true })).toBe('unread');
    expect(stateOf(online, { joy__retry: { attempt: 1, total: 3 } })).toBe('retrying');
    expect(stateOf(online, { joy__compacting: { trigger: 'auto', since: 1 } })).toBe('compacting');
    expect(stateOf(online, { joy__thinking: { since: 1 }, joy__stalled: { since: 1, silentForMs: 1 } })).toBe('stalled');
    expect(stateOf(online, { joy__stalled: { since: 1, silentForMs: 1 } })).toBe('waiting'); // stalled needs a turn
    expect(stateOf(online, { joy__thinking: { since: 1 } })).toBe('thinking');
    expect(stateOf(online, {}, { execution: 'running' })).toBe('thinking');
    expect(stateOf(online, { joy__agents: { done: 0, total: 2 } })).toBe('agents');
    expect(stateOf(online, { joy__tasks: { done: 1, total: 2 } })).toBe('tasks');
    expect(stateOf(online, { joy__tasks: { done: 0, total: 0 } })).toBe('waiting');
    expect(stateOf(online, null)).toBe('waiting');
  });
  it('maps to check states', () => {
    expect(checkStateOf('blocked')).toBe('needs_input');
    for (const s of ['thinking', 'agents', 'tasks', 'retrying', 'compacting', 'stalled']) expect(checkStateOf(s)).toBe('busy');
    expect(checkStateOf('detached')).toBe('ended');
    expect(checkStateOf('disconnected')).toBe('unreachable');
    expect(checkStateOf('waiting')).toBe('idle');
    expect(checkStateOf('unread')).toBe('idle');
  });
  it('names what a blocked session is waiting on', () => {
    expect(blockedOf({ joy__login: { url: 'https://x', code: 'ABCD' } })).toEqual({ kind: 'login', url: 'https://x', code: 'ABCD' });
    expect(blockedOf({ joy__dialog: { title: 'Switch model?', options: ['Yes', 'No'] } })).toEqual({ kind: 'dialog', title: 'Switch model?', options: ['Yes', 'No'] });
    expect(blockedOf({})).toBeNull();
  });
});

describe('messages', () => {
  it('folds queued prompts, text records and tool calls; skips thinking and lifecycle', () => {
    const events = [
      ev('turn.queued', sealText('<joy-message from="mcp:claude">\nhello\n</joy-message>', key)),
      ev('turn.started', null),
      ev('output', sealedRec({ t: 'text', text: 'let me look', thinking: true })),
      ev('output', sealedRec({ t: 'tool-call-start', name: 'Bash', args: { command: 'ls' } })),
      ev('output', sealedRec({ t: 'text', text: 'done' })),
      ev('turn.terminal', sealedRec({ t: 'turn-end', status: 'completed' })),
    ];
    const m = foldMessages(events, key);
    expect(m.map((x) => [x.role, x.text])).toEqual([
      ['user', '<joy-message from="mcp:claude">\nhello\n</joy-message>'],
      ['tool', 'Bash {"command":"ls"}'],
      ['assistant', 'done'],
    ]);
    expect(m[0].from).toBe('mcp:claude');
  });
  it('spots a turn end on the relay\'s terminal kind and on the daemon\'s turn-end record', () => {
    expect(turnEndOf(ev('turn.terminal', sealedRec({ t: 'turn-end', status: 'cancelled' })), key)).toMatchObject({ turn: 'T1', status: 'cancelled', marker: true });
    // The relay's turn id on the event wins; the runtime id in the record is the fallback.
    expect(turnEndOf(ev('output', sealedRec({ t: 'turn-end', status: 'completed' }, 'R2')), key)).toMatchObject({ turn: 'T1', status: 'completed', marker: false });
    expect(turnEndOf(ev('output', sealedRec({ t: 'turn-end', status: 'completed' }, 'R2'), { turnId: null }), key)).toMatchObject({ turn: 'R2', status: 'completed' });
    // A bare terminal marker (no payload) still ends the turn, status unknown.
    expect(turnEndOf(ev('turn.terminal', null), key)).toMatchObject({ turn: 'T1', status: null, marker: true });
    expect(turnEndOf(ev('output', sealedRec({ t: 'text', text: 'x' })), key)).toBeNull();
  });
  it('strips app directives from reply text but keeps a question', () => {
    expect(stripDirectives('pong\n\n<joy-title value="MCP lab ping test" />')).toBe('pong');
    expect(stripDirectives('<joy-notify message="done" detail="x" />\nall good <joy-img src="/a.png" width="1" height="1" alt="a" />')).toBe('all good');
    expect(stripDirectives('Which?\n<joy-options>\n<joy-option>A</joy-option>\n</joy-options>')).toContain('<joy-options>');
  });

  it('reads a question with offered answers off the last reply', () => {
    expect(questionOf('Which one?\n<joy-options>\n<joy-option>A</joy-option>\n<joy-option>B</joy-option>\n</joy-options>')).toEqual({ question: 'Which one?', options: ['A', 'B'] });
    expect(questionOf('plain reply')).toBeNull();
    expect(questionOf(null)).toBeNull();
  });
});
