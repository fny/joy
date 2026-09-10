/**
 * Which way a message goes when the agent is mid-turn.
 *
 * A plain message is held app-side until the turn ends. A slash command is
 * sent at once — but "at once" over the RELAY means a prompt turn queued
 * behind the running one: the relay serialises turns per session
 * (`another_turn_active`) and the daemon is not even offered the next until
 * the current one closes. For `/steer` that is the opposite of the point.
 * fny 4477e540, 2026-09-10: a steer sat as `queuedTurns: 1` behind a
 * multi-minute Terminal tool, never seen by the daemon, while the app showed
 * it pending.
 *
 * The daemon's own send op (`joy-send` over the machine tunnel) accepts a
 * message immediately, intercepts `/steer` and friends at accept, types them
 * into the live pane, and mirrors the bubble to the chat on dispatch. So a
 * daemon-intercepted mid-turn command goes over the tunnel when the agent is
 * busy and the tunnel is up; everything else — including the same commands
 * on an idle session, where the relay delivers just as fast — keeps the
 * relay path with its durable queue and idempotency.
 */

/** Commands the daemon intercepts at accept and applies mid-turn. */
export const DAEMON_MID_TURN_COMMANDS = new Set(['steer', 'btw', 'title', 'login-code', 'joy-prompt']);

export function commandName(text: string): string | null {
    const m = /^\/([a-z-]+)/i.exec(text.trim());
    return m ? m[1].toLowerCase() : null;
}

export function steerRoute(input: { text: string; busy: boolean; tunnelAvailable: boolean }): 'tunnel' | 'relay' {
    const cmd = commandName(input.text);
    if (!cmd || !DAEMON_MID_TURN_COMMANDS.has(cmd)) return 'relay';
    if (!input.busy || !input.tunnelAvailable) return 'relay';
    return 'tunnel';
}
