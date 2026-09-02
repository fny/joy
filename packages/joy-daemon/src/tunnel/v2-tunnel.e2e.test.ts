// The full v2 story, end to end, every layer REAL:
//   client tunnelFetch → relay /joy/v2/machines/{id}/http (v2 router,
//   account auth + machine ownership) → tunnel core → executor (v1 claim
//   lane, unchanged) → the daemon's REAL local HTTP server → the /v2/*
//   machine-plane routes over a real git repo.
// Proves the tunnel is endpoint-agnostic: the daemon's brand-new v2 surface
// is remotely reachable with ZERO relay changes, through either entry.
import { test, expect, beforeAll, afterAll } from "vitest";
import * as http from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { startTunnelExecutor, type ExecutorHandle } from "./executor";
import { tunnelFetch, TunnelError } from "./client";
import { startHttpServer } from "../transports/http";
import type { SessionRegistry } from "../domain/registry";
import type { AgentSession } from "../domain/agentSession";

// The relay is ESM .mjs — vitest resolves these fine from the sibling package.
import { openDb } from "../../../joy-relay/src/db.mjs";
import { createCore } from "../../../joy-relay/src/core.mjs";
import { createNotify } from "../../../joy-relay/src/notify.mjs";
import { createTestRelayAccounts } from "./testRelayAccounts";
import { createV2Router } from "../../../joy-relay/src/v2.mjs";
import { createTunnel } from "../../../joy-relay/src/tunnel.mjs";
import { createAttachments } from "../../../joy-relay/src/attachments.mjs";

const SECRET_A = new Uint8Array(32).fill(7);
const MACHINE = "m-v2-e2e";
const TOKEN = "v2-e2e-token";

let dataDir: string; let repo: string; let pub: string;
let relay: http.Server; let relayUrl: string;
let daemonUrl: string;
let executor: ExecutorHandle | null = null;
let db: any;
let tokA: string; let tokB: string;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "joy-v2tun-db-"));
  repo = mkdtempSync(join(tmpdir(), "joy-v2tun-repo-"));
  pub = mkdtempSync(join(tmpdir(), "joy-v2tun-pub-"));

  const g = (args: string[]) => execFileSync("git", args, { cwd: repo });
  g(["init", "-b", "main"]);
  g(["config", "user.email", "t@t"]); g(["config", "user.name", "t"]);
  writeFileSync(join(repo, "a.txt"), "one\n");
  g(["add", "."]); g(["commit", "-m", "init"]);
  writeFileSync(join(repo, "a.txt"), "one\ntwo\n");

  // Real relay with BOTH routers mounted, exactly like server.mjs.
  db = await openDb(dataDir);
  const notify = createNotify();
  const core = createCore(db, notify);
  // Real account plane: two fresh accounts, real EdDSA bearers.
  const acc = await createTestRelayAccounts(db);
  const { auth, accounts } = acc;
  tokA = acc.tokA; tokB = acc.tokB;
  const tunnel = createTunnel({ notify });
  const attachments = createAttachments(db);
  const v2 = createV2Router({ core, auth, notify, db, tunnel, attachments, accounts });
  relay = http.createServer((req, res) => {
    void (async () => {
      if (await v2.handle(req, res)) return;
      res.writeHead(404); res.end();
    })();
  });
  await new Promise<void>((r) => relay.listen(0, "127.0.0.1", r));
  relayUrl = `http://127.0.0.1:${(relay.address() as any).port}`;

  // The REAL daemon HTTP server (v2 plane) over a stub registry.
  const fakeSession = {
    id: "abcd1234", agentFlavor: "claude", cwd: repo,
    toJSON: () => ({ id: "abcd1234", cwd: repo, agent: "claude" }),
  } as unknown as AgentSession;
  const registry = {
    get: (id: string) => (id === "abcd1234" ? fakeSession : undefined),
    list: () => [fakeSession],
    size: 1, sseClientCount: 0, startedAt: Date.now(),
    chatHistory: () => [], claudeInfo: () => ({}),
    commands: { union: () => [], refresh: () => ({ slashCommands: [] }), forProject: () => [] },
    subscribeSse: () => () => {},
  } as unknown as SessionRegistry;
  daemonUrl = await new Promise<string>(resolve => {
    startHttpServer({
      registry, port: 0, publicDir: pub, token: TOKEN,
      onListening: p => resolve(`http://127.0.0.1:${p}`),
    });
  });

  // Real executor: v1 claim lane (unchanged), local target = the real daemon,
  // instance token injected daemon-side so remote callers never hold it.
  executor = startTunnelExecutor({
    relayUrl, accountToken: tokA, machineKey: SECRET_A,
    machineId: MACHINE, targetBase: daemonUrl,
    targetHeaders: { "X-Joy-Token": TOKEN },
  });
  await new Promise((r) => setTimeout(r, 300));
}, 30_000);

afterAll(async () => {
  await executor?.stop();
  relay?.close();
  await db?.close?.();
  for (const d of [dataDir, repo, pub]) rmSync(d, { recursive: true, force: true });
});

const V2_ENTRY = "/joy/v2/machines";
const call = (over: Partial<Parameters<typeof tunnelFetch>[0]> = {}) =>
  tunnelFetch({
    relayUrl, accountToken: tokA, masterSecret: SECRET_A, machineId: MACHINE,
    entryBase: V2_ENTRY, method: "GET", path: "/v2/status", ...over,
  });

test("v2 relay entry reaches the daemon v2 surface: /v2/status", async () => {
  const r = await call();
  expect(r.status).toBe(200);
  const body = JSON.parse(Buffer.from(r.body).toString());
  expect(body.ok).toBe(true);
  expect(body.sessions).toBe(1);
});

test("git status through the tunnel: porcelain parsed daemon-side", async () => {
  const r = await call({ path: "/v2/sessions/abcd1234/git/status" });
  expect(r.status).toBe(200);
  const body = JSON.parse(Buffer.from(r.body).toString());
  expect(body.ok).toBe(true);
  expect(body.branch).toBe("main");
  expect(body.clean).toBe(false);
  expect(body.entries.some((e: any) => e.path === "a.txt" && e.unstaged === "M")).toBe(true);
});

test("remote file write via v2 PUT (mutating verb; token injected by the executor)", async () => {
  const put = await call({
    method: "PUT", path: "/v2/sessions/abcd1234/files/content",
    headers: { "content-type": "application/json" },
    body: Buffer.from(JSON.stringify({ path: "remote.txt", content: "written through the tunnel\n" })),
  });
  expect(put.status).toBe(200);
  expect(JSON.parse(Buffer.from(put.body).toString()).success).toBe(true);

  const got = await call({ path: "/v2/sessions/abcd1234/files/content?path=remote.txt" });
  const body = JSON.parse(Buffer.from(got.body).toString());
  expect(Buffer.from(body.content, "base64").toString()).toBe("written through the tunnel\n");
});

test("typed grep through the tunnel", async () => {
  const r = await call({ path: "/v2/sessions/abcd1234/files/grep?q=through+the+tunnel" });
  const body = JSON.parse(Buffer.from(r.body).toString());
  expect(body.success).toBe(true);
  expect(body.stdout).toContain("remote.txt");
});

test("v2 entry enforces machine ownership before the tunnel", async () => {
  await expect(call({ accountToken: tokB })).rejects.toMatchObject(
    expect.any(TunnelError) as any,
  );
  try {
    await call({ accountToken: tokB });
  } catch (e) {
    expect((e as TunnelError).status).toBe(403);
  }
});

test("entryBase must be a path — an authority-shaped value is refused before any fetch", async () => {
  await expect(call({ entryBase: "@evil.example/x" })).rejects.toThrow(/invalid entryBase/);
  await expect(call({ entryBase: "https://evil.example" })).rejects.toThrow(/invalid entryBase/);
});
