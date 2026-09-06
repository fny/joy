/**
 * Message to Event Parser
 *
 * Certain content blocks of an agent message are lifecycle events rather than
 * chat content (an EnterPlanMode call, a usage-limit marker). They are
 * converted to events; every OTHER block of the same message keeps flowing
 * through normal processing — converting the whole message dropped the
 * explanatory text and the sibling tool calls that arrived with it.
 */

import { NormalizedMessage } from "../typesRaw";
import { AgentEvent } from "../typesRaw";

type AgentContent = Extract<NormalizedMessage, { role: 'agent' }>['content'][number];

/** The event a single content block stands for, or null. */
export function contentToEvent(content: AgentContent): AgentEvent | null {
    if (content.type === 'text') {
        const limitMatch = content.text.match(/^Claude AI usage limit reached\|(\d+)$/);
        if (limitMatch) {
            const timestamp = parseInt(limitMatch[1], 10);
            if (!isNaN(timestamp)) {
                return {
                    type: 'limit-reached',
                    endsAt: timestamp
                } as AgentEvent;
            }
        }
    }
    if (content.type === 'tool-call' && (content.name === 'EnterPlanMode' || content.name === 'enter_plan_mode')) {
        return {
            type: 'message',
            message: 'Entering plan mode',
        } as AgentEvent;
    }
    return null;
}

/**
 * Split a message into the events its blocks stand for and the remainder
 * (the same message with only its non-event blocks), or `remainder: null`
 * when nothing else was in it.
 */
export function splitMessageEvents(msg: NormalizedMessage): { events: AgentEvent[]; remainder: NormalizedMessage | null } {
    if (msg.isSidechain || msg.role !== 'agent') {
        return { events: [], remainder: msg };
    }
    const events: AgentEvent[] = [];
    const rest: AgentContent[] = [];
    for (const content of msg.content) {
        const event = contentToEvent(content);
        if (event) {
            events.push(event);
        } else {
            rest.push(content);
        }
    }
    if (events.length === 0) {
        return { events, remainder: msg };
    }
    // A message reduced to nothing but events still carries usage; the caller
    // reads it from the original message.
    return { events, remainder: rest.length > 0 ? { ...msg, content: rest } : null };
}

/**
 * Parses a normalized message to determine if it should be converted to an event.
 *
 * @param msg - The normalized message to parse
 * @returns The first AgentEvent one of its blocks stands for, null otherwise
 */
export function parseMessageAsEvent(msg: NormalizedMessage): AgentEvent | null {
    const { events } = splitMessageEvents(msg);
    return events[0] ?? null;
}

/**
 * Checks if a message consists ONLY of event blocks (nothing else to process).
 */
export function shouldSkipNormalProcessing(msg: NormalizedMessage): boolean {
    const { events, remainder } = splitMessageEvents(msg);
    return events.length > 0 && remainder === null;
}
