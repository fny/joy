// Direct (peer-to-peer) access to the local HTTP surface over a WebRTC data
// channel. The relay carries only the setup: the client POSTs its SDP offer
// to /v2/rtc/connect THROUGH the sealed tunnel, so the relay can neither read
// nor swap the DTLS fingerprints. After that, requests and responses travel
// between the two peers and never touch the relay.
//
// The channel speaks HTTP in JSON frames and is dispatched exactly like the
// tunnel executor (tunnel/executor.ts): a real fetch against 127.0.0.1 with
// X-Joy-Token, so direct, tunneled and local requests cannot drift apart.
//
//   client → daemon  {t:"req", id, m, p, h?, b?}   b = base64 request body
//                    {t:"cancel", id}              stop a streaming response
//   daemon → client  {t:"head", id, s, h}
//                    {t:"data", id, b}             b = base64 body chunk
//                    {t:"end", id}
//                    {t:"err", id, e}              no head was sent
import { RTCPeerConnection, type RTCDataChannel, type RTCIceServer } from "werift";
import { resolveLocalPath, STRIP } from "../tunnel/executor";

export interface RtcOpts {
  targetBase: string;                       // e.g. http://127.0.0.1:4997
  targetHeaders: Record<string, string>;    // X-Joy-Token for the local API
  iceServers?: RTCIceServer[];
  log?: (line: string) => void;
}

/** Raw bytes per data frame (base64 makes it ~22 KB — far under every
 *  browser's message limit). */
const CHUNK = 16 * 1024;
/** Stop reading a response while this much is queued on the channel. */
const HIGH_WATER = 1024 * 1024;
const MAX_PEERS = 8;
const GATHER_TIMEOUT_MS = 5_000;

const peers = new Set<RTCPeerConnection>();

/** STUN servers from JOY_STUN_URLS (comma-separated), Cloudflare's by
 *  default. `JOY_STUN_URLS=off` gathers host candidates only (LAN). */
export function stunServers(): RTCIceServer[] {
  const raw = process.env.JOY_STUN_URLS ?? "stun:stun.cloudflare.com:3478";
  if (raw.trim() === "off") return [];
  return raw.split(",").map((s) => s.trim()).filter(Boolean).map((urls) => ({ urls }));
}

/** Answer an SDP offer. Resolves with the answer SDP once ICE gathering is
 *  done (no trickle: one round trip through the tunnel). */
export async function acceptRtcOffer(offerSdp: string, opts: RtcOpts): Promise<string> {
  if (peers.size >= MAX_PEERS) throw new Error("too_many_peers");
  const log = opts.log ?? (() => {});
  const pc = new RTCPeerConnection({ iceServers: opts.iceServers ?? stunServers() });
  peers.add(pc);
  const drop = () => { if (peers.delete(pc)) void pc.close().catch(() => {}); };
  pc.connectionStateChange.subscribe((state) => {
    if (state === "failed" || state === "closed" || state === "disconnected") drop();
  });
  pc.onDataChannel.subscribe((dc) => serveChannel(dc, opts, log));
  try {
    const gathered = new Promise<void>((resolve) => {
      if (pc.iceGatheringState === "complete") return resolve();
      pc.iceGatheringStateChange.subscribe((s) => { if (s === "complete") resolve(); });
      setTimeout(resolve, GATHER_TIMEOUT_MS); // answer with what we have
    });
    await pc.setRemoteDescription({ type: "offer", sdp: offerSdp });
    await pc.setLocalDescription(await pc.createAnswer());
    await gathered;
    const sdp = pc.localDescription?.sdp;
    if (!sdp) throw new Error("no_answer");
    // A peer that never connects is dropped rather than held forever.
    setTimeout(() => { if (pc.connectionState !== "connected") drop(); }, 30_000);
    return sdp;
  } catch (e) {
    drop();
    throw e;
  }
}

/** Close every direct peer (tests, shutdown). */
export async function closeAllRtcPeers(): Promise<void> {
  const all = [...peers];
  peers.clear();
  await Promise.all(all.map((pc) => pc.close().catch(() => {})));
}

export const rtcPeerCount = (): number => peers.size;

function serveChannel(dc: RTCDataChannel, opts: RtcOpts, log: (line: string) => void): void {
  const live = new Map<string, AbortController>();
  dc.bufferedAmountLowThreshold = HIGH_WATER / 4;
  const send = (frame: object) => { if (dc.readyState === "open") dc.send(JSON.stringify(frame)); };
  const drained = () => new Promise<void>((resolve) => {
    if (dc.bufferedAmount <= HIGH_WATER || dc.readyState !== "open") return resolve();
    dc.bufferedAmountLow.once(() => resolve());
    dc.stateChanged.once(() => resolve());
  });

  dc.stateChanged.subscribe((s) => {
    if (s === "closed") { for (const c of live.values()) c.abort(); live.clear(); }
  });

  dc.onMessage.subscribe((msg) => {
    let f: { t?: string; id?: unknown; m?: unknown; p?: unknown; h?: unknown; b?: unknown };
    try { f = JSON.parse(typeof msg === "string" ? msg : msg.toString("utf8")); } catch { return; }
    if (typeof f.id !== "string" || !f.id) return;
    const id = f.id;
    if (f.t === "cancel") { live.get(id)?.abort(); live.delete(id); return; }
    if (f.t !== "req" || live.has(id)) return;
    const ctl = new AbortController();
    live.set(id, ctl);
    void dispatch(id, f, ctl).catch((e) => log(`rtc ${id}: ${e instanceof Error ? e.message : String(e)}`)).finally(() => live.delete(id));
  });

  async function dispatch(id: string, f: { m?: unknown; p?: unknown; h?: unknown; b?: unknown }, ctl: AbortController): Promise<void> {
    const target = resolveLocalPath(opts.targetBase, f.p);
    if (target === null) return send({ t: "err", id, e: "bad_path" });
    const h: Record<string, string> = { ...opts.targetHeaders };
    if (f.h && typeof f.h === "object") {
      for (const [k, v] of Object.entries(f.h as Record<string, unknown>)) {
        if (typeof v === "string" && !STRIP.has(k.toLowerCase()) && k.toLowerCase() !== "x-joy-token") h[k] = v;
      }
    }
    const body = typeof f.b === "string" && f.b ? Buffer.from(f.b, "base64") : undefined;
    let resp: Response;
    try {
      resp = await fetch(target, { method: typeof f.m === "string" ? f.m : "GET", headers: h, body, signal: ctl.signal });
    } catch {
      return send({ t: "err", id, e: ctl.signal.aborted ? "cancelled" : "daemon_fetch_failed" });
    }
    const respHeaders: Record<string, string> = {};
    resp.headers.forEach((v, k) => { if (!STRIP.has(k.toLowerCase())) respHeaders[k] = v; });
    send({ t: "head", id, s: resp.status, h: respHeaders });
    if (!resp.body) return send({ t: "end", id });
    const reader = resp.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (let off = 0; off < value.length; off += CHUNK) {
          send({ t: "data", id, b: Buffer.from(value.subarray(off, off + CHUNK)).toString("base64") });
        }
        await drained();
        if (dc.readyState !== "open") return;
      }
      send({ t: "end", id });
    } catch {
      // Cancelled by the client, or the channel closed: nothing more to say.
    } finally {
      await reader.cancel().catch(() => {});
    }
  }
}
