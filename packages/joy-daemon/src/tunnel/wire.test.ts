// Response→request binding (#418). A malicious relay records the daemon's
// sealed response to request A and hands it back as the answer to request B.
// Before the binding, B's client derived the response key from the response's
// OWN stream id (relay-controlled) and accepted A's status/body as B's result.
// Now every response head names the request it answers and the client checks
// it on the head frame — before any status or body is surfaced.
import { test, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { deriveTunnelKey, TamperError } from "./sealedStream";
import { sealRequest, sealResponse, openHeadAndBody, StreamingOpen, requestBinding, type ResponseHead } from "./wire";

const KEY = deriveTunnelKey(new Uint8Array(32).fill(5), "machine-bind");
const enc = (s: string) => new TextEncoder().encode(s);

/** What the executor does: answer `requestWire` with a head bound to it. */
function daemonAnswer(requestWire: Uint8Array, status: number, body: string): Uint8Array {
  return sealResponse(KEY, { s: status, h: { "content-type": "application/json" }, r: requestBinding(requestWire) }, enc(body));
}

test("a bound response opens for the request it answers", () => {
  const reqA = sealRequest(KEY, { m: "PUT", p: "/v2/sessions/s/files/content", h: {} }, enc('{"path":"a"}'));
  const respA = daemonAnswer(reqA, 200, '{"success":true}');
  const { head, body } = openHeadAndBody<ResponseHead>(KEY, respA, requestBinding(reqA));
  expect(head.s).toBe(200);
  expect(new TextDecoder().decode(body)).toBe('{"success":true}');
});

test("replay: the response recorded for request A is refused as the answer to request B", () => {
  const reqA = sealRequest(KEY, { m: "PUT", p: "/v2/sessions/s/files/content", h: {} }, enc('{"path":"a","content":"1"}'));
  const reqB = sealRequest(KEY, { m: "PUT", p: "/v2/sessions/s/files/content", h: {} }, enc('{"path":"a","content":"2"}'));
  const respA = daemonAnswer(reqA, 200, '{"success":true}');
  // Same key, same machine, a perfectly authentic stream — only the binding differs.
  expect(() => openHeadAndBody<ResponseHead>(KEY, respA, requestBinding(reqB))).toThrow(TamperError);
  expect(() => openHeadAndBody<ResponseHead>(KEY, respA, requestBinding(reqB))).toThrow(/another request/);
});

test("replay through the streaming reader fails on the HEAD frame, before any body chunk surfaces", () => {
  const reqA = sealRequest(KEY, { m: "GET", p: "/v2/status", h: {} }, new Uint8Array(0));
  const reqB = sealRequest(KEY, { m: "GET", p: "/v2/status", h: {} }, new Uint8Array(0));
  const respA = daemonAnswer(reqA, 200, "x".repeat(10_000));
  const open = new StreamingOpen<ResponseHead>(KEY, requestBinding(reqB));
  let surfaced = 0;
  expect(() => {
    for (let i = 0; i < respA.length; i += 512) surfaced += open.feed(respA.subarray(i, i + 512)).length;
  }).toThrow(TamperError);
  expect(open.head).toBeNull();
  expect(surfaced).toBe(0);
});

test("an unbound (legacy-shaped) response is refused when a binding is expected", () => {
  const req = sealRequest(KEY, { m: "GET", p: "/v2/status", h: {} }, new Uint8Array(0));
  const legacy = sealResponse(KEY, { s: 200, h: {} } as ResponseHead, enc("{}"));
  expect(() => openHeadAndBody<ResponseHead>(KEY, legacy, requestBinding(req))).toThrow(/no request binding/);
  // …and a reflected REQUEST stream can never pass as a response (no numeric status).
  const reflected = sealRequest(KEY, { m: "GET", p: "/v2/status", h: {} }, new Uint8Array(0));
  expect(() => openHeadAndBody<ResponseHead>(KEY, reflected, requestBinding(req))).toThrow(/malformed/);
});

test("without an expected binding (daemon opening a request) nothing changes", () => {
  const req = sealRequest(KEY, { m: "POST", p: "/v2/x", h: { a: "b" } }, new Uint8Array(randomBytes(300)));
  const { head } = openHeadAndBody<{ m: string; p: string }>(KEY, req);
  expect(head.m).toBe("POST");
});

test("requestBinding is the hex of the 16-byte stream id, distinct per request", () => {
  const r1 = sealRequest(KEY, { m: "GET", p: "/", h: {} }, new Uint8Array(0));
  const r2 = sealRequest(KEY, { m: "GET", p: "/", h: {} }, new Uint8Array(0));
  expect(requestBinding(r1)).toMatch(/^[0-9a-f]{32}$/);
  expect(requestBinding(r1)).not.toBe(requestBinding(r2));
});
