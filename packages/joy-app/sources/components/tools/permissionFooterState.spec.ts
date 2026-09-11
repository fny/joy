import { describe, it, expect } from 'vitest';
import { IDLE, canAct, nextFooterState, submittingAnswer, type AnswerKind, type FooterEvent, type FooterState } from './permissionFooterState';

const ANSWERS: AnswerKind[] = ['allow', 'deny', 'abort', 'all_edits', 'bypass', 'for_session'];
const STATES: FooterState[] = [IDLE, ...ANSWERS.map((answer) => ({ kind: 'submitting' as const, answer }))];
const EVENTS: FooterEvent[] = [...ANSWERS.map((answer) => ({ type: 'press' as const, answer })), { type: 'settled' }];

describe('permission footer state (table)', () => {
    // Every (state × event) pair has one expected answer; a missing pair fails.
    const expected = (s: FooterState, ev: FooterEvent): FooterState => {
        if (ev.type === 'settled') return IDLE;
        return s.kind === 'idle' ? { kind: 'submitting', answer: ev.answer } : s;
    };
    for (const s of STATES) for (const ev of EVENTS) {
        it(`${s.kind}${s.kind === 'submitting' ? `(${s.answer})` : ''} × ${ev.type}${ev.type === 'press' ? `(${ev.answer})` : ''}`, () => {
            expect(nextFooterState(s, ev)).toEqual(expected(s, ev));
        });
    }
});

describe('canAct', () => {
    it('only idle and pending', () => {
        expect(canAct(IDLE, { status: 'pending' })).toBe(true);
        expect(canAct(IDLE, { status: 'approved' })).toBe(false);
        expect(canAct({ kind: 'submitting', answer: 'allow' }, { status: 'pending' })).toBe(false);
    });
    it('a refused answer (#381) settles back to idle with the request still pending, so the user can press again', () => {
        const pressed = nextFooterState(IDLE, { type: 'press', answer: 'allow' });
        expect(canAct(pressed, { status: 'pending' })).toBe(false);
        const settled = nextFooterState(pressed, { type: 'settled' });
        expect(canAct(settled, { status: 'pending' })).toBe(true);
        expect(submittingAnswer(settled)).toBeNull();
        expect(submittingAnswer(pressed)).toBe('allow');
    });
});
