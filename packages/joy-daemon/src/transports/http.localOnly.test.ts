// A local-only session's history (domain/localLog.ts) is served by the same
// /sessions/:id/events route as any other session — from the durable log on
// disk, the session's only store — history first, then live records.
import { test, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
process.env.JOY_HOME_DIR = mkdtempSync(join(tmpdir(), "joy-http-localonly-"));
import { startHttpServer } from "./http";
import { markLocalOnly } from "../domain/localOnly";
import { appendLocalRecord } from "../domain/localLog";

const TOKEN = "tok-local";
const LOC = "loc12345";
let server: Server; let port = 0;
const registry: any = { get: (id: string) => (id === LOC ? { id: LOC } : undefined), chatHistory: () => [], list: () => [], subscribeSse: () => () => {} };

beforeAll(async () => {
  markLocalOnly(LOC);
  for (let i = 1; i <= 5; i++) appendLocalRecord(LOC, { role: "agent", n: i });
  await new Promise<void>((resolve) => {
    server = startHttpServer({ registry, port: 0, publicDir: mkdtempSync(join(tmpdir(), "joy-pub-")), token: TOKEN, onListening: (p) => { port = p; resolve(); } });
  });
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

const lines = (text: string) => text.split("\n").filter(Boolean).map((l) => JSON.parse(l));

test("history comes from the local log: ?last and ?after", async () => {
  const last = lines(await (await fetch(`http://127.0.0.1:${port}/sessions/${LOC}/events?last=2`, { headers: { "X-Joy-Token": TOKEN } })).text());
  expect(last[0]).toEqual({ hello: true, seq: 5 });
  expect(last.slice(1).map((r: any) => r.seq)).toEqual([4, 5]);
  const after = lines(await (await fetch(`http://127.0.0.1:${port}/sessions/${LOC}/events?after=3`, { headers: { "X-Joy-Token": TOKEN } })).text());
  expect(after.slice(1).map((r: any) => r.record.n)).toEqual([4, 5]);
});

test("?follow=1 delivers records appended after the history", async () => {
  const ctl = new AbortController();
  const res = await fetch(`http://127.0.0.1:${port}/sessions/${LOC}/events?after=5&follow=1`, { headers: { "X-Joy-Token": TOKEN }, signal: ctl.signal });
  const reader = res.body!.getReader();
  const got: any[] = [];
  let buf = "";
  const pump = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buf += new TextDecoder().decode(value);
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) { got.push(JSON.parse(buf.slice(0, nl))); buf = buf.slice(nl + 1); }
      if (got.some((r) => r.seq === 6)) return;
    }
  })();
  await new Promise((r) => setTimeout(r, 200));
  appendLocalRecord(LOC, { role: "agent", n: 6 });
  await Promise.race([pump, new Promise((r) => setTimeout(r, 3000))]);
  ctl.abort();
  expect(got[0]).toEqual({ hello: true, seq: 5 });
  expect(got.find((r) => r.seq === 6)?.record).toEqual({ role: "agent", n: 6 });
});
