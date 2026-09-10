// What only the daemon knows — check, approvals, the queue, abort, kill,
// harness capabilities — reached over the sealed tunnel through the relay,
// exactly as the app does (sources/sync/v2/machine.ts).
import { deriveTunnelKey, sealTunnelRequest, openTunnelResponse, TunnelError, utf8, fromUtf8 } from './crypto.mjs';
import { RelayError } from './relay.mjs';

const RETRYABLE = new Set(['relay_busy', 'daemon_busy']);

export class DaemonTunnel {
  /** @param {{ relay: import('./relay.mjs').RelayClient, index: import('./model.mjs').SessionIndex, from?: string }} opts */
  constructor({ relay, index, from = 'mcp' }) {
    this.relay = relay; this.index = index; this.from = from;
    this.keys = new Map(); // machine id → tunnel key
  }

  tunnelKey(machineId) {
    const hit = this.keys.get(machineId);
    if (hit) return hit;
    const m = this.index.machine(machineId);
    if (!m?.key) throw new TunnelError(403, 'machine_key_unavailable', `no key for machine ${machineId}`);
    const k = deriveTunnelKey(m.key, machineId);
    this.keys.set(machineId, k);
    return k;
  }

  /** One JSON request to the daemon's local HTTP surface: { status, data }. */
  async json(machineId, method, path, body) {
    const key = this.tunnelKey(machineId);
    const bodyBytes = body === undefined ? new Uint8Array(0) : utf8(JSON.stringify(body));
    for (let attempt = 1; ; attempt++) {
      const { wire, binding } = sealTunnelRequest(key, { m: method, p: path, h: body === undefined ? {} : { 'content-type': 'application/json' }, t: Date.now() }, bodyBytes);
      let res;
      try { res = await this.relay.tunnel(machineId, wire); }
      catch (e) {
        if (e instanceof RelayError && e.status === 503 && RETRYABLE.has(e.code) && attempt < 3) { await new Promise((r) => setTimeout(r, 1000 * attempt)); continue; }
        if (e instanceof RelayError && e.code === 'daemon_offline') throw new TunnelError(503, 'machine_unreachable', `the daemon on ${machineId.slice(0, 8)} is not answering`);
        throw e;
      }
      const { head, body: out } = openTunnelResponse(key, res.bytes, binding);
      const text = fromUtf8(out);
      let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = null; }
      return { status: head.s, data };
    }
  }

  #local(row) { return row.localSessionId; }

  async check(row) {
    const r = await this.json(row.daemonId, 'GET', `/v2/sessions/${this.#local(row)}/check`);
    return r.data ?? { state: 'unknown' };
  }
  async info(row) { return (await this.json(row.daemonId, 'GET', `/v2/sessions/${this.#local(row)}`)).data; }
  async approvals(row) { return (await this.json(row.daemonId, 'GET', `/v2/sessions/${this.#local(row)}/approvals`)).data?.approvals ?? []; }
  async answer(row, requestId, decision) {
    return (await this.json(row.daemonId, 'POST', `/v2/sessions/${this.#local(row)}/approvals`, { requestId, decision })).data ?? { ok: false };
  }
  async abort(row) { return (await this.json(row.daemonId, 'POST', `/v2/sessions/${this.#local(row)}/abort`, {})).data ?? { ok: false }; }
  async queue(row) { return (await this.json(row.daemonId, 'GET', `/v2/sessions/${this.#local(row)}/queue`)).data ?? {}; }
  async queueCancel(row, qid) { return (await this.json(row.daemonId, 'DELETE', `/v2/sessions/${this.#local(row)}/queue/${encodeURIComponent(qid)}`)).data ?? { ok: false }; }
  async queueResume(row) { return (await this.json(row.daemonId, 'POST', `/v2/sessions/${this.#local(row)}/queue/resume`, {})).data ?? { ok: false }; }
  async kill(row, ifStatus) {
    const r = await this.json(row.daemonId, 'DELETE', `/v2/sessions/${this.#local(row)}${ifStatus ? `?ifStatus=${encodeURIComponent(ifStatus)}` : ''}`);
    return { status: r.status, ...(r.data ?? {}) };
  }
  async harnesses(machineId) { return (await this.json(machineId, 'GET', '/v2/harnesses')).data?.harnesses ?? []; }
  /** A mid-turn steer (or any daemon-owned slash command) goes over the
   *  tunnel so it lands in the running turn instead of queueing behind it. */
  async steer(row, text, { exclusive = false, replyTo } = {}) {
    const body = { session_id: this.#local(row), text, from: this.from, exclusive, ...(replyTo === null ? { replyTo: null } : {}) };
    return (await this.json(row.daemonId, 'POST', '/v2/send', body)).data ?? { error: 'no_answer' };
  }
}

export { TunnelError };
