/**
 * Local control-channel protocol between joy-cli and joy-daemon.
 *
 * Wire: newline-delimited JSON over a Unix domain socket (named pipe on
 * Windows). Each message is one JSON object on its own line.
 *
 * Every request carries a `requestId` (client-generated); the daemon's
 * response uses the same id. Async notifications (status, projection tail)
 * carry `event: true` instead of `requestId`.
 */

export const CONTROL_PROTOCOL_VERSION = 1;

export interface Hello {
    type: 'hello';
    clientProtocolVersion: number;
}
export interface Welcome {
    type: 'welcome';
    daemonProtocolVersion: number;
    daemonId: string;
    daemonPid: number;
}

export interface CtlRequest<P = unknown> {
    requestId: string;
    method: string;
    params: P;
}
export interface CtlOk<R = unknown> {
    requestId: string;
    ok: true;
    result: R;
}
export interface CtlErr {
    requestId: string;
    ok: false;
    error: { code: string; message: string };
}
export type CtlResponse<R = unknown> = CtlOk<R> | CtlErr;

export interface CtlNotification<P = unknown> {
    event: true;
    name: string;
    payload: P;
}

export type CtlFrame = Hello | Welcome | CtlRequest | CtlResponse | CtlNotification;

// ── Request/response shapes ────────────────────────────────────────────────

export interface DaemonStatusResult {
    daemonId: string;
    pid: number;
    protocolVersion: number;
    startedAt: number;
    sessions: string[];
}

/**
 * Two modes:
 *   - `create`: daemon registers a new session with the relay using `tag` +
 *     `metadata`, learns the canonical sessionId + content key from the
 *     server response, and adopts them.
 *   - `adopt`:  caller already knows the sessionId and the content key
 *     (e.g. from `~/.happy/sessions.json`); daemon skips the create step.
 *
 * The CLI emits one or the other based on whether `--session-id` was given.
 */
export type SessionStartParams =
    | {
          mode: 'create';
          /** Idempotency / dedup key for the relay. */
          tag: string;
          /** Encrypted-on-the-wire session metadata (e.g. `{ path, host }`). */
          metadata: Record<string, unknown>;
          agentBin: string;
          agentArgs?: string[];
          agentEnv?: Record<string, string>;
      }
    | {
          mode: 'adopt';
          sessionId: string;
          /** Base64 of the 32-byte session key. */
          sessionKeyB64: string;
          /** Encryption variant the relay expects for this session. */
          variant: 'legacy' | 'dataKey';
          agentBin: string;
          agentArgs?: string[];
          agentEnv?: Record<string, string>;
      };
export interface SessionStartResult {
    sessionId: string;
    daemonId: string;
}

export interface SessionStopParams {
    sessionId: string;
    reason?: string;
}

export interface AttachInputParams {
    sessionId: string;
    /** Event body (type + payload). */
    event: { type: string; payload: unknown };
}
export interface AttachInputResult {
    eventId: string;
}

export interface ProjectionGetResult {
    sessionId: string;
    /** Projection snapshot (opaque object — consumers parse as needed). */
    projection: unknown;
}
