// Direct access end to end: a real WebRTC client peer (werift) sends its
// offer to /v2/rtc/connect on the real HTTP server, opens a data channel, and
// reads a local-only session's events over it — history, then a live record.
import { test, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
process.env.JOY_HOME_DIR = mkdtempSync(join(tmpdir(), "joy-rtc-"));
process.env.JOY_STUN_URLS = "off"; // loopback: host candidates only
import { RTCPeerConnection, type RTCDataChannel } from "werift";
import { startHttpServer } from "./http";
import { closeAllRtcPeers, rtcPeerCount } from "./rtc";
import { markLocalOnly } from "../domain/localOnly";
import { appendLocalRecord } from "../domain/localLog";

const TOKEN = "tok-rtc";
const LOC = "rtc12345";
let server: Server; let port = 0;
const registry: any = { get: (id: string) => (id === LOC ? { id: LOC } : undefined), chatHistory: () => [], list: () => [], subscribeSse: () => () => {} };

let client: RTCPeerConnection;
let dc: RTCDataChannel;
const frames: any[] = [];

beforeAll(async () => {
  markLocalOnly(LOC);
  for (let i = 1; i <= 3; i++) appendLocalRecord(LOC, { role: "agent", n: i });
  await new Promise<void>((resolve) => {
    server = startHttpServer({ registry, port: 0, publicDir: mkdtempSync(join(tmpdir(), "joy-pub-")), token: TOKEN, onListening: (p) => { port = p; resolve(); } });
  });
  client = new RTCPeerConnection({ iceServers: [] });
  dc = client.createDataChannel("joy");
  dc.onMessage.subscribe((m) => frames.push(JSON.parse(m.toString())));
  const gathered = new Promise<void>((r) => client.iceGatheringStateChange.subscribe((s) => { if (s === "complete") r(); }));
  await client.setLocalDescription(await client.createOffer());
  await gathered;
  const res = await fetch(`http://127.0.0.1:${port}/v2/rtc/connect`, {
    method: "POST", headers: { "X-Joy-Token": TOKEN, "content-type": "application/json" },
    body: JSON.stringify({ sdp: client.localDescription!.sdp }),
  });
  expect(res.status).toBe(200);
  await client.setRemoteDescription({ type: "answer", sdp: (await res.json() as any).sdp });
  await dc.stateChanged.watch((s) => s === "open", 10_000);
}, 20_000);

afterAll(async () => {
  await client?.close();
  await closeAllRtcPeers();
  await new Promise<void>((r) => server.close(() => r()));
});

const until = async (pred: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!pred()) { if (Date.now() > end) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 20)); }
};
const bodyOf = (id: string) => Buffer.concat(frames.filter((f) => f.id === id && f.t === "data").map((f) => Buffer.from(f.b, "base64"))).toString();

test("the route refuses a call without the daemon token", async () => {
  const res = await fetch(`http://127.0.0.1:${port}/v2/rtc/connect`, { method: "POST", body: JSON.stringify({ sdp: "x" }) });
  expect(res.status).toBe(401);
});

test("a request over the channel is answered by the local API (the daemon adds its token)", async () => {
  dc.send(JSON.stringify({ t: "req", id: "a", m: "GET", p: `/sessions/${LOC}/events?last=2` }));
  await until(() => frames.some((f) => f.id === "a" && f.t === "end"));
  expect(frames.find((f) => f.id === "a" && f.t === "head").s).toBe(200);
  const lines = bodyOf("a").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  expect(lines[0]).toEqual({ hello: true, seq: 3 });
  expect(lines.slice(1).map((r: any) => r.record.n)).toEqual([2, 3]);
  expect(rtcPeerCount()).toBe(1);
});

test("a following stream delivers live records, and cancel ends it", async () => {
  dc.send(JSON.stringify({ t: "req", id: "f", m: "GET", p: `/sessions/${LOC}/events?after=3&follow=1` }));
  await until(() => frames.some((f) => f.id === "f" && f.t === "head"));
  appendLocalRecord(LOC, { role: "agent", n: 4 });
  await until(() => bodyOf("f").includes('"n":4'));
  dc.send(JSON.stringify({ t: "cancel", id: "f" }));
  await new Promise((r) => setTimeout(r, 200));
  const before = frames.filter((f) => f.id === "f").length;
  appendLocalRecord(LOC, { role: "agent", n: 5 });
  await new Promise((r) => setTimeout(r, 300));
  expect(frames.filter((f) => f.id === "f").length).toBe(before);
});

test("a path off the local surface is refused, never fetched", async () => {
  dc.send(JSON.stringify({ t: "req", id: "x", m: "GET", p: "//evil.example/x" }));
  await until(() => frames.some((f) => f.id === "x"));
  expect(frames.filter((f) => f.id === "x")).toEqual([{ t: "err", id: "x", e: "bad_path" }]);
});
