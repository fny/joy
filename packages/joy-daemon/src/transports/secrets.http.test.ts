// Session secrets over the daemon's HTTP surfaces: the app's /v2 routes save,
// list and remove — and have NO route that returns a value; the CLI's own
// route (`joy secret get`) does. A real server over a stub registry and a
// throwaway JOY_HOME_DIR.
import { test, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHttpServer } from "./http";
import type { SessionRegistry } from "../domain/registry";

const TOKEN = "test-token-secrets";
const SID = "abcd1234";
let base = "";
let home = "";
let server: ReturnType<typeof startHttpServer> | null = null;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "joy-secrets-http-"));
  process.env.JOY_HOME_DIR = home;
  const registry = { get: (id: string) => (id === SID ? ({ id: SID } as never) : undefined) } as unknown as SessionRegistry;
  base = await new Promise<string>((resolve) => {
    server = startHttpServer({ registry, port: 0, publicDir: home, token: TOKEN, onListening: (p) => resolve(`http://127.0.0.1:${p}`) });
  });
});
afterAll(() => { server?.close(); rmSync(home, { recursive: true, force: true }); });

async function call(method: string, path: string, body?: unknown) {
  const r = await fetch(base + path, { method, headers: { "content-type": "application/json", "x-joy-token": TOKEN }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => null) as any };
}

test("the app saves, lists and removes over /v2; only the CLI route reads a value", async () => {
  const set = await call("POST", `/v2/sessions/${SID}/secrets`, { secrets: { email: "me@x.com", password: "hunter22" } });
  expect(set).toMatchObject({ status: 200, json: { ok: true, names: ["email", "password"] } });

  const list = await call("GET", `/v2/sessions/${SID}/secrets`);
  expect(list.status).toBe(200);
  expect(list.json.secrets.map((s: { name: string }) => s.name)).toEqual(["email", "password"]);
  expect(JSON.stringify(list.json)).not.toContain("hunter22");

  // No /v2 route answers with a value.
  const appGet = await call("GET", `/v2/sessions/${SID}/secrets/password`);
  expect(appGet.status).toBe(404);
  expect(JSON.stringify(appGet.json)).not.toContain("hunter22");

  // The CLI's route (joy secret get) does.
  expect(await call("GET", `/sessions/${SID}/secrets/PASSWORD`)).toMatchObject({ status: 200, json: { ok: true, value: "hunter22" } });
  expect(await call("GET", `/sessions/${SID}/secrets/nope`)).toMatchObject({ status: 404, json: { error: "not_found" } });

  expect(await call("DELETE", `/v2/sessions/${SID}/secrets/email`)).toMatchObject({ status: 200, json: { ok: true, existed: true } });
  const after = await call("GET", `/sessions/${SID}/secrets`);
  expect(after.json.secrets.map((s: { name: string }) => s.name)).toEqual(["password"]);
});

test("refusals: an unknown session, a bad name", async () => {
  expect(await call("POST", `/v2/sessions/ffffffff/secrets`, { secrets: { a: "b" } })).toMatchObject({ status: 404, json: { error: "session_not_found" } });
  expect(await call("POST", `/v2/sessions/${SID}/secrets`, { secrets: { "two words": "x" } })).toMatchObject({ status: 400, json: { error: "bad_name", name: "two words" } });
});
