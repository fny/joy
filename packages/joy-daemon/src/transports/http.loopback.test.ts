// The daemon's local API takes no key for reads, and that is only safe
// because it is reachable from THIS machine alone. These are the two halves
// of that guarantee, pinned so a change to either fails here:
//   1. it binds 127.0.0.1 — nothing on the network can connect at all;
//   2. it answers only requests addressed to localhost — a web page whose DNS
//      points at 127.0.0.1 (DNS rebinding) cannot read it through the browser.
// What it does NOT cover, by design, and the docs say so (reference/security):
// other user accounts on the same machine share the loopback interface.
import { test, expect, beforeAll, afterAll } from "vitest";
import * as net from "node:net";
import * as http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir, networkInterfaces } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
process.env.JOY_HOME_DIR = mkdtempSync(join(tmpdir(), "joy-http-loopback-"));
import { startHttpServer } from "./http";

let server: Server; let port = 0; let publicDir: string;
const registry: any = { get: () => undefined, chatHistory: () => [], list: () => [], subscribeSse: () => () => {} };

beforeAll(async () => {
  publicDir = mkdtempSync(join(tmpdir(), "joy-http-loopback-public-"));
  await new Promise<void>((resolve) => {
    server = startHttpServer({ registry, port: 0, publicDir, token: "tok", onListening: (p) => { port = p; resolve(); } });
  });
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(publicDir, { recursive: true, force: true });
  rmSync(process.env.JOY_HOME_DIR!, { recursive: true, force: true });
});

const get = (host: string, address = "127.0.0.1") => new Promise<number>((resolve, reject) => {
  const req = http.get({ host: address, port, path: "/sessions", headers: { host } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
  req.on("error", reject);
});

test("the server is bound to 127.0.0.1 and nothing else", () => {
  const addr = server.address();
  expect(addr && typeof addr === "object" ? addr.address : addr).toBe("127.0.0.1");
});

test("a connection to any non-loopback address of this machine is refused", async () => {
  const external = Object.values(networkInterfaces()).flat()
    .filter((i): i is NonNullable<typeof i> => !!i && !i.internal && i.family === "IPv4")
    .map((i) => i.address);
  // A machine with no external interface has nothing to test against; the
  // bind assertion above still holds.
  for (const address of external) {
    const outcome = await new Promise<string>((resolve) => {
      const s = net.connect({ host: address, port });
      s.once("connect", () => { s.destroy(); resolve("connected"); });
      s.once("error", (e: NodeJS.ErrnoException) => resolve(e.code ?? "error"));
      s.setTimeout(3000, () => { s.destroy(); resolve("timeout"); });
    });
    expect(outcome, address).not.toBe("connected");
  }
});

test("only requests addressed to localhost are answered — a rebinding page's own Host is refused", async () => {
  expect(await get(`localhost:${port}`)).not.toBe(403);
  expect(await get(`127.0.0.1:${port}`)).not.toBe(403);
  expect(await get(`[::1]:${port}`)).not.toBe(403);
  expect(await get(`attacker.example:${port}`)).toBe(403);
  expect(await get(`127.0.0.1.nip.io:${port}`)).toBe(403);
});

test("changes need the daemon's token even from this machine", async () => {
  const status = await new Promise<number>((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: "/sessions", method: "POST", headers: { host: `localhost:${port}`, "content-type": "application/json" } },
      (res) => { res.resume(); resolve(res.statusCode ?? 0); });
    req.on("error", reject); req.end("{}");
  });
  expect(status).toBe(401);
});
