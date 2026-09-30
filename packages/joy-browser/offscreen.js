// Chrome only: the page that holds Direct mode's peer connection, because the
// service worker cannot. One port from the worker = one peer:
//
//   worker → here  {type:'open', iceServers}   {type:'answer', sdp}
//                  {type:'fail', error}         {type:'msg', data}
//   here → worker  {type:'offer', sdp}  {type:'ready'}  {type:'msg', data}
//                  {type:'closed', reason}
//
// A worker that stops (Chrome stops idle ones) drops its port, and the peer
// goes with it; the next worker opens a new one.
import { openPeer } from './src/peer.js';

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'joy-rtc') return;
  let peer = null; let gone = false;
  let answered = null;
  const say = (m) => { if (!gone) { try { port.postMessage(m); } catch { gone = true; } } };
  port.onDisconnect.addListener(() => { gone = true; peer?.close(); answered?.reject(new Error('the worker went away')); });
  port.onMessage.addListener(async (m) => {
    if (m?.type === 'answer') return answered?.resolve(m.sdp);
    if (m?.type === 'fail') return answered?.reject(new Error(m.error));
    if (m?.type === 'msg') return peer?.send(m.data);
    if (m?.type !== 'open' || peer) return;
    try {
      peer = await openPeer({
        iceServers: m.iceServers ?? [],
        signal: (sdp) => new Promise((resolve, reject) => { answered = { resolve, reject }; say({ type: 'offer', sdp }); }),
        onMessage: (data) => say({ type: 'msg', data }),
        onClose: (reason) => { say({ type: 'closed', reason }); try { port.disconnect(); } catch { /* gone */ } },
      });
      if (gone) return peer.close();
      say({ type: 'ready' });
    } catch (e) {
      say({ type: 'closed', reason: e?.message ?? String(e) });
      try { port.disconnect(); } catch { /* gone */ }
    }
  });
});
