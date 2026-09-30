// The WebRTC half of Direct mode — it needs a page. Firefox's background page
// runs it in place; Chrome's service worker has no RTCPeerConnection, so there
// it runs in the offscreen document (offscreen.js) and the worker drives it
// over a port (openOffscreenPeer, src/direct.js).
//
// This end offers, the daemon answers (packages/joy-daemon/src/transports/
// rtc.ts). ICE is gathered in full before the offer goes out: the offer and
// the answer each cross the sealed tunnel once, and nothing else does.

const GATHER_MS = 5_000;
const OPEN_MS = 15_000;

function gathered(pc) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => { if (pc.iceGatheringState === 'complete') { pc.removeEventListener('icegatheringstatechange', done); resolve(); } };
    pc.addEventListener('icegatheringstatechange', done);
    setTimeout(resolve, GATHER_MS); // offer what we have
  });
}

function opened(dc) {
  if (dc.readyState === 'open') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no direct route to the machine (the hole punch failed)')), OPEN_MS);
    dc.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    dc.addEventListener('close', () => { clearTimeout(timer); reject(new Error('the machine closed the direct connection')); }, { once: true });
  });
}

/** Connect to the daemon. `signal(offerSdp)` carries the offer and resolves
 *  the answer SDP. Resolves { send, close } once the channel is open. */
export async function openPeer({ iceServers = [], signal, onMessage, onClose }) {
  const pc = new RTCPeerConnection({ iceServers });
  const dc = pc.createDataChannel('joy', { ordered: true });
  let closed = false;
  const close = (why) => {
    if (closed) return;
    closed = true;
    try { dc.close(); } catch { /* already */ }
    try { pc.close(); } catch { /* already */ }
    onClose?.(why);
  };
  dc.onmessage = (e) => onMessage?.(typeof e.data === 'string' ? e.data : new TextDecoder().decode(e.data));
  try {
    await pc.setLocalDescription(await pc.createOffer());
    await gathered(pc);
    const answer = await signal(pc.localDescription.sdp);
    await pc.setRemoteDescription({ type: 'answer', sdp: answer });
    await opened(dc);
  } catch (e) { close(e?.message ?? String(e)); throw e; }
  // Registered only once open: an early close is the error thrown above.
  dc.onclose = () => close('the direct connection closed');
  pc.onconnectionstatechange = () => { if (pc.connectionState === 'failed' || pc.connectionState === 'closed') close(`the direct connection ${pc.connectionState}`); };
  return { send: (text) => { if (!closed) dc.send(text); }, close: () => close('closed') };
}
