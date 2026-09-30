// One DevTools (CDP) connection to one Chromium target, with the few verbs
// the Chromium smoke tests use.
import { cleanup } from './smoke-lib.mjs';

export async function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error(`cannot reach ${wsUrl}`)); });
  cleanup.push(() => ws.close());
  let nextId = 0; const pending = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
  const send = async (method, params = {}) => {
    const id = ++nextId;
    const reply = await new Promise((res) => { pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
    if (reply.error) throw new Error(`${method}: ${reply.error.message}`);
    return reply.result;
  };
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result?.value;
  };
  // The page button lives in a CLOSED shadow root: page script cannot see it,
  // and neither can Runtime.evaluate. The DOM domain can, with pierce.
  const attr = (n, name) => { const a = n.attributes ?? []; const i = a.indexOf(name); return i >= 0 && i % 2 === 0 ? a[i + 1] : null; };
  const walk = function* (n) { yield n; for (const c of [...(n.shadowRoots ?? []), ...(n.children ?? [])]) yield* walk(c); };
  const widget = async () => { const { root } = await send('DOM.getDocument', { depth: -1, pierce: true }); for (const n of walk(root)) if (n.nodeName === 'JOY-BROWSER-ROOT') return n; return null; };
  const inWidget = async (test) => { const w = await widget(); if (!w) return null; for (const n of walk(w)) if (test(n, attr)) return n; return null; };
  const call = async (node, fn) => { const { object } = await send('DOM.resolveNode', { nodeId: node.nodeId }); return (await send('Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration: fn, returnByValue: true })).result?.value; };
  const click = async (node) => {
    const { model } = await send('DOM.getBoxModel', { nodeId: node.nodeId });
    const q = model.content; const x = (q[0] + q[4]) / 2; const y = (q[1] + q[5]) / 2;
    for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
  };
  const type = async (text) => {
    await send('Input.insertText', { text });
    for (const t of ['keyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type: t, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, ...(t === 'keyDown' ? { text: '\r' } : {}) });
  };
  return { send, evaluate, widget, inWidget, call, click, type };
}
