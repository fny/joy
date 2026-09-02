import type { Session } from '@/sync/storageTypes';
import type { Message } from '@/sync/typesMessage';
import { compareMessagesOldestFirst } from '@/sync/messageOrdering';
import { getSessionName } from '@/utils/sessionUtils';
import { VOICE_CONFIG } from '../voiceConfig';

function agentLabel(session: Session | undefined): string {
    const flavor = session?.metadata?.flavor;
    switch (flavor) {
        case 'codex': return 'Codex';
        case 'opencode': return 'OpenCode';
        case 'pi': return 'pi';
        case 'claude': return 'Claude Code';
        default: return 'The agent';
    }
}

function clip(text: string): string {
    const max = VOICE_CONFIG.MAX_MESSAGE_CHARS;
    return text.length > max ? text.slice(0, max) + ' …' : text;
}

/** Strip joy tags the voice agent should never read out; keep option lists
 *  readable as a numbered list. */
export function cleanAgentText(text: string): string {
    const opts = parseJoyOptions(text);
    let out = text
        .replace(/<joy-options>[\s\S]*?<\/joy-options>/g, '')
        .replace(/<joy-(title|notify|bg|img|file)[^>]*>[\s\S]*?<\/joy-\1>/g, '')
        .replace(/<\/?joy-[a-z]+[^>]*>/g, '')
        .trim();
    if (opts) {
        out += `\n\nOptions:\n${opts.map((o, i) => `${i + 1}. ${o}`).join('\n')}`;
    }
    return out;
}

/** The option labels of a trailing <joy-options> block, or null. */
export function parseJoyOptions(text: string): string[] | null {
    const m = /<joy-options>([\s\S]*?)<\/joy-options>/.exec(text);
    if (!m) return null;
    const opts: string[] = [];
    const re = /<joy-option[^>]*>([\s\S]*?)<\/joy-option>/g;
    let mm: RegExpExecArray | null;
    while ((mm = re.exec(m[1])) !== null) {
        const label = mm[1].trim();
        if (label) opts.push(label);
    }
    return opts.length ? opts : null;
}

export function formatMessage(message: Message, session?: Session): string | null {
    const who = agentLabel(session);
    if (message.kind === 'agent-text') {
        if (message.isThinking) return null;
        const text = cleanAgentText(message.text);
        return text ? `${who}:\n<text>${clip(text)}</text>` : null;
    }
    if (message.kind === 'user-text') {
        const from = message.meta?.from;
        const label = from && from !== 'app' ? `Message from ${from}` : 'User sent';
        return `${label}:\n<text>${clip(message.text)}</text>`;
    }
    if (message.kind === 'tool-call') {
        if (VOICE_CONFIG.LIMITED_TOOL_CALLS) {
            const desc = message.tool.description ? ` — ${message.tool.description}` : '';
            return `${who} used ${message.tool.name}${desc}`;
        }
        return `${who} used ${message.tool.name} with <arguments>${JSON.stringify(message.tool.input)}</arguments>`;
    }
    return null;
}

export function formatNewMessages(sessionId: string, messages: Message[], session?: Session): string | null {
    const formatted = [...messages].sort(compareMessagesOldestFirst).map(m => formatMessage(m, session)).filter(Boolean);
    if (formatted.length === 0) return null;
    return `New in session "${sessionTitle(session, sessionId)}" (${sessionId}):\n\n${formatted.join('\n\n')}`;
}

export function formatHistory(session: Session, messages: Message[]): string {
    // messages arrive newest-first; take the newest N, then present oldest-first
    const recent = messages.slice(0, VOICE_CONFIG.MAX_HISTORY_MESSAGES);
    const formatted = [...recent].sort(compareMessagesOldestFirst).map(m => formatMessage(m, session)).filter(Boolean);
    return formatted.length ? formatted.join('\n\n') : '(no messages yet)';
}

export function sessionTitle(session: Session | undefined, fallback: string): string {
    return session ? getSessionName(session) : fallback;
}

export function formatSessionFull(session: Session, messages: Message[]): string {
    const lines: string[] = [];
    lines.push(`## Session "${getSessionName(session)}" (id ${session.id})`);
    lines.push(`Agent: ${agentLabel(session)}`);
    if (session.metadata?.path) lines.push(`Project: ${session.metadata.path}`);
    lines.push(`State: ${session.thinking ? 'working' : 'idle'}`);
    lines.push('');
    lines.push('Recent messages:');
    lines.push(formatHistory(session, messages));
    return lines.join('\n');
}

export function formatSessionFocus(sessionId: string, session?: Session): string {
    return `The user is now looking at session "${sessionTitle(session, sessionId)}" (${sessionId}). Requests go there unless another session is named.`;
}

export function formatReadyEvent(sessionId: string, session?: Session): string {
    return `${agentLabel(session)} finished working in session "${sessionTitle(session, sessionId)}" (${sessionId}). The previous message(s) are its summary. Report this to the user now, in one or two sentences.`;
}

export function formatPermissionRequest(sessionId: string, requestId: string, toolName: string, toolArgs: unknown, session?: Session): string {
    const args = toolArgs === undefined ? '' : `\n<tool_args>${clip(JSON.stringify(toolArgs))}</tool_args>`;
    return `${agentLabel(session)} in session "${sessionTitle(session, sessionId)}" is asking permission to use ${toolName}. Ask the user; answer with processPermissionRequest.\n<request_id>${requestId}</request_id>\n<tool_name>${toolName}</tool_name>${args}`;
}

export function formatQuestion(sessionId: string, question: string, options: string[], session?: Session): string {
    return `${agentLabel(session)} in session "${sessionTitle(session, sessionId)}" (${sessionId}) is waiting for an answer:\n<text>${clip(question)}</text>\nOptions:\n${options.map((o, i) => `${i + 1}. ${o}`).join('\n')}\nRead the question and options to the user; when they choose, send the option's exact text to that session.`;
}
