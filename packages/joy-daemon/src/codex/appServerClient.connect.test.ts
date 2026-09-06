// #511: a connect that expires at its deadline — the server accepted the
// unix connection but stalled during the WebSocket upgrade, or upgraded and
// never answered `initialize` — must tear down THAT attempt's socket. The
// next attempt used to overwrite the only socket reference, so three expired
// connects against a stalled server left three connections open and
// close() released only the last one (catalog/startup retries accumulated
// descriptors). Both stall points are exercised against real listeners.
import { test, expect } from "vitest";
import { createServer as createNetServer, type Socket } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { CodexAppServerClient } from "./appServerClient";

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("#511: connects that stall before the upgrade close their sockets at the deadline — nothing leaks across retries", async () => {
  const dir = mkdtempSync(join(tmpdir(), "asc-"));
  const sock = join(dir, "s.sock");
  const accepted: Socket[] = [];
  let closed = 0;
  // The server reads (so it observes the client's FIN) but never upgrades.
  const server = createNetServer((c) => { accepted.push(c); c.resume(); c.on("close", () => { closed++; }); });
  await new Promise<void>((r) => server.listen(sock, r));
  try {
    const client = new CodexAppServerClient();
    for (let i = 0; i < 3; i++) await expect(client.connect(sock, 120)).rejects.toThrow(/timed out/);
    await settle(100);
    expect(accepted).toHaveLength(3);
    expect(closed).toBe(3);
    expect(client.connected).toBe(false);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#511: connects that upgrade but never answer initialize close their sockets at the deadline; a later good connect works and close() releases it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "asc-"));
  const sock = join(dir, "s.sock");
  const http = createHttpServer();
  const wss = new WebSocketServer({ server: http, perMessageDeflate: false });
  const conns: WebSocket[] = [];
  let closed = 0;
  let answer = false;
  wss.on("connection", (ws) => {
    conns.push(ws);
    ws.on("close", () => { closed++; });
    ws.on("message", (data) => {
      const msg = JSON.parse(String(data));
      if (answer && msg.method === "initialize") ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { ok: true } }));
    });
  });
  await new Promise<void>((r) => http.listen(sock, r));
  try {
    const client = new CodexAppServerClient();
    for (let i = 0; i < 3; i++) await expect(client.connect(sock, 120)).rejects.toThrow(/timed out/);
    await settle(100);
    expect(conns).toHaveLength(3);
    expect(closed).toBe(3);
    // The stalled attempts left nothing behind: a server that now answers is
    // joined normally, and close() releases that one connection too.
    answer = true;
    await client.connect(sock, 2_000);
    expect(client.connected).toBe(true);
    client.close();
    await settle(100);
    expect(conns).toHaveLength(4);
    expect(closed).toBe(4);
  } finally {
    wss.close();
    http.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
