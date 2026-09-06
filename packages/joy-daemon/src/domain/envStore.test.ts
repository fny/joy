// Sealed env store: seal/open round-trip under the machine key, legacy-file
// migration, and the "service env wins, removed keys are withdrawn" contract
// of applyEnvStore. Runs against a throwaway JOY_HOME_DIR with a minted
// access.key (the store needs a machineKey to exist).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, createCipheriv } from "node:crypto";

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

  /** Pair a second relay with its OWN machine key under the same JOY_HOME_DIR. */
  const pairOther = (url: string): string => {
    const creds = paths.joyRelayCredsDir(url);
    mkdirSync(creds, { recursive: true });
    const machineKey = randomBytes(32).toString("base64");
    writeFileSync(join(creds, "access.key"), JSON.stringify({
      token: "t2", encryption: { publicKey: randomBytes(32).toString("base64"), machineKey },
    }));
    writeFileSync(join(creds, "settings.json"), JSON.stringify({ machineId: "m-test-2", serverUrl: url }));
    return machineKey;
  };
  const select = (url: string) => { process.env.JOY_RELAY_URL = url; paths.__resetRelaySelection(); };

  it("two relays paired under one JOY_HOME_DIR share the store (#533)", () => {
    const OTHER = "http://127.0.0.1:3299";
    expect(mod.setEnvVar("JOY_ENV_TEST_A", "shared")).toEqual({ ok: true });
    pairOther(OTHER);
    select(OTHER);
    // The second relay's daemon has a DIFFERENT machineKey — it used to see store_unreadable.
    expect(mod.readEnvStore()).toEqual({ ok: true, env: { JOY_ENV_TEST_A: "shared" } });
    expect(mod.setEnvVar("JOY_ENV_TEST_B", "b")).toEqual({ ok: true });
    select(RELAY);
    expect(mod.readEnvStore()).toEqual({ ok: true, env: { JOY_ENV_TEST_A: "shared", JOY_ENV_TEST_B: "b" } });
    // pairing's helper: any relay's key "opens" a store that no longer depends on relay keys
    expect(mod.machineKeyOpensStore(randomBytes(32).toString("base64"))).toBe(true);
  });

  it("a legacy store sealed under a relay machine key is read, then re-sealed for every relay (#533)", () => {
    // Seal by hand under relay A's machineKey — the pre-#533 on-disk format.
    const ak = JSON.parse(readFileSync(join(paths.joyRelayCredsDir(RELAY), "access.key"), "utf8"));
    const key = Buffer.from(ak.encryption.machineKey, "base64");
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    const enc = Buffer.concat([cipher.update(Buffer.from(JSON.stringify({ JOY_ENV_TEST_A: "legacy" }), "utf8")), cipher.final()]);
    writeFileSync(join(home, "env.sealed"), Buffer.concat([Buffer.from([0]), nonce, enc, cipher.getAuthTag()]).toString("base64") + "\n");
    expect(existsSync(join(home, "env.key"))).toBe(false);
    expect(mod.readEnvStore()).toEqual({ ok: true, env: { JOY_ENV_TEST_A: "legacy" } });
    // …and now a sibling relay with an unrelated key reads it too
    const OTHER = "http://127.0.0.1:3399";
    pairOther(OTHER);
    select(OTHER);
    expect(mod.readEnvStore()).toEqual({ ok: true, env: { JOY_ENV_TEST_A: "legacy" } });
    select(RELAY);
  });

  it("__proto__ is an ordinary variable name: stored, listed, kept across writes (#534)", () => {
    expect(mod.setEnvVar("__proto__", "v")).toEqual({ ok: true });
    expect(mod.listEnvVars()).toEqual({ ok: true, names: ["__proto__"] });
    mod.setEnvVar("JOY_ENV_TEST_A", "a"); // an unrelated write must not drop it
    const r = mod.readEnvStore();
    expect(r.ok && Object.hasOwn(r.env, "__proto__") && r.env["__proto__"]).toBe("v");
    expect(mod.unsetEnvVar("toString")).toEqual({ ok: true, existed: false }); // no inherited "names"
    expect(mod.unsetEnvVar("__proto__")).toEqual({ ok: true, existed: true });
    expect(mod.listEnvVars()).toEqual({ ok: true, names: ["JOY_ENV_TEST_A"] });
  });

  it("a value with NUL is rejected at set time and skipped by the migration (#535)", () => {
    expect(mod.setEnvVar("JOY_ENV_TEST_A", "before\0after")).toEqual({ ok: false, error: "bad_value" });
    expect(mod.readEnvStore()).toEqual({ ok: true, env: {} });
    writeFileSync(join(home, "env"), "JOY_ENV_TEST_A=ok\nJOY_ENV_TEST_B=bad\0value\n");
    const lines: string[] = [];
    mod.migrateLegacyEnvFile((l) => lines.push(l));
    expect(mod.readEnvStore()).toEqual({ ok: true, env: { JOY_ENV_TEST_A: "ok" } });
    expect(lines.join("\n")).toMatch(/JOY_ENV_TEST_B/);
  });
});
