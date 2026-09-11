/**
 * What the composer's action row shows, decided in one place. Pure,
 * import-free; AgentInput.tsx renders what this answers.
 *
 * The send slot is one button that changes meaning: while a turn is
 * processing and the box is empty it is STOP (one tap to abort); anything
 * typed or attached flips it back to SEND so mid-turn queueing and steering
 * stay one tap. That left no stop anywhere while you were typing during a
 * turn — Escape aborted on web, nothing did on mobile. So while a turn is
 * processing and the box has content, a second, smaller stop button sits
 * beside send. To keep the row to one extra icon, the save-draft button
 * (which also appears when there is text) yields to it during a turn.
 */
export interface ComposerSlotInput {
    /** A turn is processing and an abort handler exists. */
    turnProcessing: boolean;
    /** The box holds text or an attachment. */
    hasContent: boolean;
    /** A send is in flight. */
    isSending: boolean;
    /** Sending is locked (e.g. the session is not ready). */
    isSendBlocked: boolean;
    /** A save-draft handler exists. */
    canSaveDraft: boolean;
}

export interface ComposerSlots {
    /** The send slot is the stop button. */
    abortSlot: boolean;
    /** A stop button is shown beside the send slot. */
    secondaryAbort: boolean;
    /** The save-draft button is shown. */
    saveDraft: boolean;
}

export function composerSlots(i: ComposerSlotInput): ComposerSlots {
    const abortSlot = i.turnProcessing && !i.hasContent && !i.isSending && !i.isSendBlocked;
    const secondaryAbort = i.turnProcessing && i.hasContent && !i.isSendBlocked;
    // During a turn the one extra icon is stop; otherwise a typed draft can be stashed.
    const saveDraft = i.canSaveDraft && i.hasContent && !i.turnProcessing;
    return { abortSlot, secondaryAbort, saveDraft };
}
