// opencode client decoding at its sites (#569 #570): a fake `opencode` bin
// that prints its listen line in two writes, and a local HTTP server that
// splits a euro sign across socket writes in a JSON body and an SSE event.
import { test, expect, describe, beforeAll, afterAll } from "vitest";
import * as http from "node:http";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnOpencodeServer, OpencodeClient, killOpencodeServerPid } from "./opencodeClient";

let dir: string;
const savedHome = process.env.JOY_HOME_DIR;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "oc-decode-"));
  process.env.JOY_HOME_DIR = join(dir, "joy-home"); // the spawn writes a clean npmrc under the state dir
});
afterAll(() => {
  if (savedHome === undefined) delete process.env.JOY_HOME_DIR; else process.env.JOY_HOME_DIR = savedHome;
  rmSync(dir, { recursive: true, force: true });
});

const EURO = Buffer.from("€", "utf8");

describe("spawnOpencodeServer port parse (#570)", () => {
  test("a listen line arriving as ':42' then '123\\n' resolves 42123, not 42", async () => {
    const bin = join(dir, "fake-opencode");
    writeFileSync(bin, `#!/bin/sh
printf 'opencode server listening on http://127.0.0.1:42'
sleep 0.15
printf '123\\n'
sleep 5
`);
    chmodSync(bin, 0o755);
    const { proc, port } = spawnOpencodeServer(dir, { bin });
    try {
      await expect(port).resolves.toBe(42123);
    } finally {
      if (proc.pid) await killOpencodeServerPid(proc.pid);
    }
  });
});

describe("OpencodeClient decoding (#569)", () => {
  let server: http.Server;
  let port: number;
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url === "/api/split") {
        res.writeHead(200, { "Content-Type": "application/json" });
        const body = Buffer.from(JSON.stringify({ data: { t: "a€b" } }), "utf8");
        const cut = body.indexOf(EURO) + 1; // one byte into the character
        res.write(body.subarray(0, cut));
        setTimeout(() => res.end(body.subarray(cut)), 30);
        return;
      }
      if (req.url === "/api/event") {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        const ev = Buffer.from(`data: ${JSON.stringify({ type: "t", data: { t: "x€y" } })}\n\n`, "utf8");
        const cut = ev.indexOf(EURO) + 2; // two bytes into the character
        res.write(ev.subarray(0, cut));
        setTimeout(() => { res.write(ev.subarray(cut)); }, 30);
        // keep the stream open; the test closes the client
        return;
      }
      res.writeHead(404); res.end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    port = (server.address() as { port: number }).port;
  });
  afterAll(() => new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); }));

  test("request(): a character split across socket chunks parses whole", async () => {
    const c = new OpencodeClient(port);
    const r = await c.request<{ data: { t: string } }>("GET", "/api/split", undefined, 5000);
    expect(r.data.t).toBe("a€b");
  });

  test("subscribeEvents(): an SSE line split inside a character delivers the intact event", async () => {
    const c = new OpencodeClient(port);
    const got = new Promise<string>((resolve) => c.onEvent((e) => resolve(String((e.data as { t: string }).t))));
    c.subscribeEvents();
    try {
      await expect(got).resolves.toBe("x€y");
    } finally { c.close(); }
  });
});
