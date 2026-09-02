// Sealed env store: seal/open round-trip under the machine key, legacy-file
// migration, and the "service env wins, removed keys are withdrawn" contract
// of applyEnvStore. Runs against a throwaway JOY_HOME_DIR with a minted
// access.key (the store needs a machineKey to exist).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

let home: string;
const RELAY = "http://127.0.0.1:3199";
let mod: typeof import("./envStore");
let paths: typeof import("../paths");

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "joy-env-"));
  process.env.JOY_HOME_DIR = home;
  process.env.JOY_RELAY_URL = RELAY;
  paths = await import("../paths");
  paths.__resetRelaySelection();
  const creds = paths.joyRelayCredsDir(RELAY);
  mkdirSync(creds, { recursive: true });
  writeFileSync(join(creds, "access.key"), JSON.stringify({
    token: "t", encryption: { publicKey: randomBytes(32).toString("base64"), machineKey: randomBytes(32).toString("base64") },
  }));
  writeFileSync(join(creds, "settings.json"), JSON.stringify({ machineId: "m-test", serverUrl: RELAY }));
  mod = await import("./envStore");
  for (const k of ["JOY_ENV_TEST_A", "JOY_ENV_TEST_B", "JOY_ENV_TEST_SVC"]) delete process.env[k];
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  for (const k of ["JOY_ENV_TEST_A", "JOY_ENV_TEST_B", "JOY_ENV_TEST_SVC"]) delete process.env[k];
});

describe("envStore", () => {
  it("seals to disk and reads back; names only in the listing", () => {
    expect(mod.setEnvVar("JOY_ENV_TEST_A", "secret-a")).toEqual({ ok: true });
    const raw = readFileSync(join(home, "env.sealed"), "utf8");
    expect(raw).not.toContain("secret-a");
    expect(mod.readEnvStore()).toEqual({ ok: true, env: { JOY_ENV_TEST_A: "secret-a" } });
    expect(mod.listEnvVars()).toEqual({ ok: true, names: ["JOY_ENV_TEST_A"] });
    expect(mod.unsetEnvVar("JOY_ENV_TEST_A")).toEqual({ ok: true, existed: true });
    expect(mod.unsetEnvVar("JOY_ENV_TEST_A")).toEqual({ ok: true, existed: false });
    expect(mod.setEnvVar("not a name", "x")).toEqual({ ok: false, error: "bad_name" });
  });

  it("a tampered file fails closed", () => {
    mod.setEnvVar("JOY_ENV_TEST_A", "v");
    const p = join(home, "env.sealed");
    const buf = Buffer.from(readFileSync(p, "utf8").trim(), "base64");
    buf[20] ^= 0xff;
    writeFileSync(p, buf.toString("base64"));
    expect(mod.readEnvStore()).toEqual({ ok: false, error: "store_unreadable" });
  });

  it("applyEnvStore: store fills gaps, never shadows the service env, withdraws removed keys", () => {
    process.env.JOY_ENV_TEST_SVC = "from-service";
    mod.setEnvVar("JOY_ENV_TEST_SVC", "from-store");
    mod.setEnvVar("JOY_ENV_TEST_A", "a1");
    mod.applyEnvStore();
    expect(process.env.JOY_ENV_TEST_SVC).toBe("from-service");
    expect(process.env.JOY_ENV_TEST_A).toBe("a1");
    mod.setEnvVar("JOY_ENV_TEST_A", "a2");
    mod.unsetEnvVar("JOY_ENV_TEST_SVC");
    mod.applyEnvStore();
    expect(process.env.JOY_ENV_TEST_A).toBe("a2");        // refreshed at the next spawn
    expect(process.env.JOY_ENV_TEST_SVC).toBe("from-service");
    mod.unsetEnvVar("JOY_ENV_TEST_A");
    mod.applyEnvStore();
    expect(process.env.JOY_ENV_TEST_A).toBeUndefined();  // withdrawn
  });

  it("migrates a plaintext ~/.joy/env into the store and deletes it", () => {
    writeFileSync(join(home, "env"), "# keys\nexport JOY_ENV_TEST_A='plain-a'\nJOY_ENV_TEST_B=\"plain-b\"\n");
    const lines: string[] = [];
    mod.migrateLegacyEnvFile((l) => lines.push(l));
    expect(existsSync(join(home, "env"))).toBe(false);
    expect(mod.readEnvStore()).toEqual({ ok: true, env: { JOY_ENV_TEST_A: "plain-a", JOY_ENV_TEST_B: "plain-b" } });
    expect(lines[0]).toMatch(/sealed 2 variable/);
    expect(mod.parseEnvFile("A=1\n\n#c\nexport B = two\nbad\n")).toEqual({ A: "1", B: "two" });
  });
});
