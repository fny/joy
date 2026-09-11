import { describe, it, expect } from 'vitest';
import { composerSlots } from './composerSlots';

const base = { turnProcessing: false, hasContent: false, isSending: false, isSendBlocked: false, canSaveDraft: true };

describe('composerSlots', () => {
    it('idle, empty box: nothing but the send slot', () => {
        expect(composerSlots(base)).toEqual({ abortSlot: false, secondaryAbort: false, saveDraft: false });
    });
    it('idle, typing: save-draft appears, no stop anywhere', () => {
        expect(composerSlots({ ...base, hasContent: true })).toEqual({ abortSlot: false, secondaryAbort: false, saveDraft: true });
    });
    it('turn processing, empty box: the send slot IS stop', () => {
        expect(composerSlots({ ...base, turnProcessing: true })).toEqual({ abortSlot: true, secondaryAbort: false, saveDraft: false });
    });
    it('turn processing, typing: the slot is send, stop sits beside it, and save-draft yields to keep one extra icon', () => {
        expect(composerSlots({ ...base, turnProcessing: true, hasContent: true })).toEqual({ abortSlot: false, secondaryAbort: true, saveDraft: false });
    });
    it('turn processing, an attachment and no text counts as content', () => {
        expect(composerSlots({ ...base, turnProcessing: true, hasContent: true, canSaveDraft: false })).toMatchObject({ secondaryAbort: true, saveDraft: false });
    });
    it('a send in flight during a turn: the slot shows the spinner, stop stays beside it', () => {
        expect(composerSlots({ ...base, turnProcessing: true, hasContent: true, isSending: true })).toEqual({ abortSlot: false, secondaryAbort: true, saveDraft: false });
    });
    it('send blocked: no stop in either place (the lock owns the slot)', () => {
        expect(composerSlots({ ...base, turnProcessing: true, hasContent: true, isSendBlocked: true })).toMatchObject({ abortSlot: false, secondaryAbort: false });
        expect(composerSlots({ ...base, turnProcessing: true, isSendBlocked: true })).toMatchObject({ abortSlot: false });
    });
    it('no save-draft handler: never shown', () => {
        expect(composerSlots({ ...base, hasContent: true, canSaveDraft: false }).saveDraft).toBe(false);
    });
});
