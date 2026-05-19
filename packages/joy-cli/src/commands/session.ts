import { randomUUID } from 'node:crypto';
import { ControlClient } from '../control/client';
import { ensureDaemon, findAgentBin } from '../ensureDaemon';
import { b64encode, randomBytesU8 } from 'joy-daemon/src/relay/encryption';
import type {
    AttachInputResult,
    SessionStartResult,
    ProjectionGetResult,
} from 'joy-daemon/src/control/protocol';

async function withClient<T>(fn: (c: ControlClient) => Promise<T>): Promise<T> {
    await ensureDaemon();
    const c = new ControlClient();
    await c.connect();
    try {
        return await fn(c);
    } finally {
        c.close();
    }
}

export async function sessionList(): Promise<void> {
    await withClient(async (c) => {
        const r = await c.request<{ sessions: string[] }>('session.list');
        for (const s of r.sessions) process.stdout.write(s + '\n');
    });
}

export interface StartOpts {
    sessionId?: string;
    sessionKeyB64?: string;
    variant?: 'legacy' | 'dataKey';
    agentBin?: string;
    cwd?: string;
}

export async function sessionStart(opts: StartOpts = {}): Promise<void> {
    const sessionId = opts.sessionId ?? randomUUID();
    const sessionKeyB64 = opts.sessionKeyB64 ?? b64encode(randomBytesU8(32));
    const variant = opts.variant ?? 'legacy';
    const agentBin = opts.agentBin ?? findAgentBin();
    const agentEnv: Record<string, string> = {};
    if (opts.cwd) agentEnv.JOY_CWD = opts.cwd;
    await withClient(async (c) => {
        const r = await c.request<SessionStartResult>('session.start', {
            sessionId, sessionKeyB64, variant, agentBin, agentEnv,
        });
        process.stdout.write(JSON.stringify(r, null, 2) + '\n');
    });
}

export async function sessionStop(sessionId: string, reason?: string): Promise<void> {
    await withClient(async (c) => {
        await c.request('session.stop', { sessionId, reason });
    });
}

export async function sessionSend(sessionId: string, text: string): Promise<void> {
    await withClient(async (c) => {
        const event = { type: 'user-message', payload: { messageId: randomUUID(), content: text } };
        const r = await c.request<AttachInputResult>('session.attachInput', { sessionId, event });
        process.stdout.write(`appended ${r.eventId}\n`);
    });
}

export async function sessionCancel(sessionId: string, target?: string): Promise<void> {
    await withClient(async (c) => {
        const event = { type: 'cancel', payload: { targetTurnId: target ?? '*' } };
        const r = await c.request<AttachInputResult>('session.attachInput', { sessionId, event });
        process.stdout.write(`appended ${r.eventId}\n`);
    });
}

export async function sessionSteer(sessionId: string, targetTurnId: string, text: string): Promise<void> {
    await withClient(async (c) => {
        const event = { type: 'steer', payload: { targetTurnId, content: text } };
        const r = await c.request<AttachInputResult>('session.attachInput', { sessionId, event });
        process.stdout.write(`appended ${r.eventId}\n`);
    });
}

export async function sessionProjection(sessionId: string): Promise<void> {
    await withClient(async (c) => {
        const r = await c.request<ProjectionGetResult>('session.projection', { sessionId });
        process.stdout.write(JSON.stringify(r.projection, null, 2) + '\n');
    });
}
