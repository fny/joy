// Sealed env store: seal/open round-trip under the machine key, legacy-file
// migration, and the "service env wins, removed keys are withdrawn" contract
// of applyEnvStore. Runs against a throwaway JOY_HOME_DIR with a minted
// access.key (the store needs a machineKey to exist).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as { DatabaseSync: new (p: string) => { exec(sql: string): void; close(): void } };

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
  mod.__setEnvStoreHooksForTests({ beforePublish: undefined });
  mod.__setEnvLockTimingForTests({ waitMs: 5000 });
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

  /** Seal `data` by hand under `key` in the store's framing. */
  const sealWith = (key: Buffer, data: Record<string, string>) => {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    const enc = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(data), "utf8")), cipher.final()]);
    return Buffer.concat([Buffer.from([0]), nonce, enc, cipher.getAuthTag()]).toString("base64") + "\n";
  };
  /** The raw names in the sealed file, decoded under the local key. */
  const sealedNames = () => {
    const key = Buffer.from(readFileSync(join(home, "env.key"), "utf8").trim(), "base64");
    const buf = Buffer.from(readFileSync(join(home, "env.sealed"), "utf8").trim(), "base64");
    const d = createDecipheriv("aes-256-gcm", key, buf.subarray(1, 13));
    d.setAuthTag(buf.subarray(buf.length - 16));
    return Object.keys(JSON.parse(Buffer.concat([d.update(buf.subarray(13, buf.length - 16)), d.final()]).toString("utf8"))).sort();
  };

  it("a NUL value sealed by the previous version is neither applied nor resealed (#535 residual)", () => {
    mod.setEnvVar("JOY_ENV_TEST_B", "fine"); // mints env.key
    const key = Buffer.from(readFileSync(join(home, "env.key"), "utf8").trim(), "base64");
    writeFileSync(join(home, "env.sealed"), sealWith(key, { JOY_ENV_TEST_A: "before\0after", JOY_ENV_TEST_B: "fine" }));
    expect(mod.readEnvStore()).toEqual({ ok: true, env: { JOY_ENV_TEST_B: "fine" }, dropped: ["JOY_ENV_TEST_A"] });
    expect(mod.listEnvVars()).toEqual({ ok: true, names: ["JOY_ENV_TEST_B"] });
    mod.applyEnvStore();
    expect(process.env.JOY_ENV_TEST_A).toBeUndefined(); // not "before"
    expect(process.env.JOY_ENV_TEST_B).toBe("fine");
    // The next write reseals without it; a replacement value is accepted.
    expect(mod.setEnvVar("JOY_ENV_TEST_SVC", "x")).toEqual({ ok: true });
    expect(sealedNames()).toEqual(["JOY_ENV_TEST_B", "JOY_ENV_TEST_SVC"]);
    expect(mod.setEnvVar("JOY_ENV_TEST_A", "clean")).toEqual({ ok: true });
    mod.applyEnvStore();
    expect(process.env.JOY_ENV_TEST_A).toBe("clean");
  });

  it("a legacy relay-key store carrying a NUL value is migrated without it (#535 residual)", () => {
    const ak = JSON.parse(readFileSync(join(paths.joyRelayCredsDir(RELAY), "access.key"), "utf8"));
    writeFileSync(join(home, "env.sealed"), sealWith(Buffer.from(ak.encryption.machineKey, "base64"), { JOY_ENV_TEST_A: "bad\0", JOY_ENV_TEST_B: "ok" }));
    expect(mod.readEnvStore()).toEqual({ ok: true, env: { JOY_ENV_TEST_B: "ok" }, dropped: ["JOY_ENV_TEST_A"] });
    expect(existsSync(join(home, "env.key"))).toBe(true); // re-sealed under the local key…
    expect(sealedNames()).toEqual(["JOY_ENV_TEST_B"]);   // …without the value it cannot carry
    expect(mod.readEnvStore()).toEqual({ ok: true, env: { JOY_ENV_TEST_B: "ok" } });
  });

  it("concurrent first writers from separate daemons serialize: one key, no lost variable (#533 residual)", async () => {
    // Three processes, each a fresh daemon with no key yet, each writing five
    // variables at once. The old code let the second minter replace the first
    // key and its store; now every write lands under the one key.
    const script = `const m = await import(${JSON.stringify(join(__dirname, "envStore.ts"))});
      for (let i = 0; i < 5; i++) { const r = m.setEnvVar("JOY_ENV_RACE_" + process.argv[1] + "_" + i, "v" + i); if (!r.ok) { console.error(JSON.stringify(r)); process.exit(1); } }`;
    const run = (tag: string) => new Promise<{ code: number | null; err: string }>((resolve) => {
      const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, tag], {
        env: { ...process.env, JOY_HOME_DIR: home }, stdio: ["ignore", "ignore", "pipe"],
      });
      let err = "";
      child.stderr.on("data", (d) => { err += d; });
      child.on("close", (code) => resolve({ code, err }));
    });
    const results = await Promise.all(["A", "B", "C"].map(run));
    for (const r of results) expect(r, r.err).toMatchObject({ code: 0 });
    const r = mod.readEnvStore();
    expect(r.ok && Object.keys(r.env).sort()).toEqual(
      ["A", "B", "C"].flatMap((t) => [0, 1, 2, 3, 4].map((i) => `JOY_ENV_RACE_${t}_${i}`)).sort(),
    );
    // One key, no leftover attempt files; the lock database is the only extra.
    expect(readdirSync(home).filter((f) => f.startsWith("env")).sort()).toEqual(["env.key", "env.lock.db", "env.sealed"]);
  }, 30_000);

  it("a held lock makes the write wait, then fail closed; release lets it through", () => {
    expect(mod.setEnvVar("JOY_ENV_TEST_A", "before")).toEqual({ ok: true });
    // Another writer's transaction: a second connection holding BEGIN IMMEDIATE.
    const holder = new DatabaseSync(join(home, "env.lock.db"));
    holder.exec("BEGIN IMMEDIATE");
    mod.__setEnvLockTimingForTests({ waitMs: 50 });
    try {
      const t0 = Date.now();
      expect(mod.setEnvVar("JOY_ENV_TEST_B", "blocked")).toEqual({ ok: false, error: "store_busy" });
      expect(Date.now() - t0).toBeGreaterThanOrEqual(40); // it waited, not failed at once
      expect(mod.readEnvStore()).toEqual({ ok: true, env: { JOY_ENV_TEST_A: "before" } });
    } finally {
      mod.__setEnvLockTimingForTests({ waitMs: 5000 });
      holder.exec("ROLLBACK");
      holder.close();
    }
    expect(mod.setEnvVar("JOY_ENV_TEST_B", "after")).toEqual({ ok: true });
    expect(mod.readEnvStore()).toEqual({ ok: true, env: { JOY_ENV_TEST_A: "before", JOY_ENV_TEST_B: "after" } });
  });

  /** A real second daemon process: writes `name` and prints the result plus
   *  the time it finished. `marker` is touched just before it takes the lock. */
  const secondWriter = (name: string, marker: string) => {
    const script = `import { writeFileSync } from "node:fs";
      const m = await import(${JSON.stringify(join(__dirname, "envStore.ts"))});
      writeFileSync(${JSON.stringify(marker)}, "");
      const r = m.setEnvVar(${JSON.stringify(name)}, "accepted");
      console.log(JSON.stringify({ ...r, doneAt: Date.now() }));`;
    return new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
      const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
        env: { ...process.env, JOY_HOME_DIR: home }, stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "", err = "";
      child.stdout.on("data", (d) => { out += d; });
      child.stderr.on("data", (d) => { err += d; });
      child.on("close", (code) => resolve({ code, out, err }));
    });
  };
  const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

  it("a writer paused at its rename keeps its lock: a second process waits for it and neither write is lost (#533 residual)", async () => {
    // Writer A (this process) is paused inside the lock between writing its
    // temporary file and renaming it into place — a stopped or slow holder.
    // Writer B, a real second process, arrives meanwhile. Under the aged
    // env.lock, B stole the lock and saved SECOND, then A's stale FIRST
    // snapshot was renamed over it: both reported ok, SECOND was gone.
    expect(mod.setEnvVar("JOY_ENV_TEST_SEED", "seed")).toEqual({ ok: true });
    const marker = join(home, "b-ready");
    let b: ReturnType<typeof secondWriter> | null = null;
    let releasedAt = 0;
    mod.__setEnvStoreHooksForTests({
      beforePublish: () => {
        b = secondWriter("JOY_ENV_TEST_SECOND", marker);
        const deadline = Date.now() + 20_000;
        while (!existsSync(marker) && Date.now() < deadline) sleepSync(20);
        expect(existsSync(marker)).toBe(true);
        sleepSync(400); // B is now inside its BEGIN IMMEDIATE wait
        releasedAt = Date.now();
      },
    });
    try {
      expect(mod.setEnvVar("JOY_ENV_TEST_FIRST", "accepted")).toEqual({ ok: true });
    } finally {
      mod.__setEnvStoreHooksForTests({ beforePublish: undefined });
    }
    const r = await b!;
    expect(r, r.err).toMatchObject({ code: 0 });
    const parsed = JSON.parse(r.out.trim()) as { ok: boolean; doneAt: number };
    expect(parsed.ok).toBe(true);
    expect(parsed.doneAt).toBeGreaterThanOrEqual(releasedAt); // B waited for A
    expect(mod.readEnvStore()).toEqual({ ok: true, env: { JOY_ENV_TEST_SEED: "seed", JOY_ENV_TEST_FIRST: "accepted", JOY_ENV_TEST_SECOND: "accepted" } });
  }, 40_000);

  it("a holder that dies mid-transaction releases the lock with it — nothing to break, nothing to steal", async () => {
    const marker = join(home, "dying-ready");
    const script = `import { writeFileSync } from "node:fs";
      const m = await import(${JSON.stringify(join(__dirname, "envStore.ts"))});
      m.__setEnvStoreHooksForTests({ beforePublish: () => { writeFileSync(${JSON.stringify(marker)}, ""); process.kill(process.pid, "SIGKILL"); } });
      m.setEnvVar("JOY_ENV_TEST_DYING", "never");`;
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      env: { ...process.env, JOY_HOME_DIR: home }, stdio: ["ignore", "ignore", "inherit"],
    });
    const signal = await new Promise<NodeJS.Signals | null>((resolve) => child.on("close", (_code, sig) => resolve(sig)));
    expect(signal).toBe("SIGKILL");
    expect(existsSync(marker)).toBe(true);
    const t0 = Date.now();
    expect(mod.setEnvVar("JOY_ENV_TEST_A", "after-death")).toEqual({ ok: true });
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(mod.readEnvStore()).toEqual({ ok: true, env: { JOY_ENV_TEST_A: "after-death" } });
  }, 30_000);

  it("a key published by another daemon between our read and our mint is adopted, not replaced", () => {
    // Simulate the loser of a first-mint race: the sealed store and key
    // appear from elsewhere; our own write must seal under THAT key.
    const foreign = randomBytes(32);
    writeFileSync(join(home, "env.key"), foreign.toString("base64") + "\n");
    writeFileSync(join(home, "env.sealed"), sealWith(foreign, { JOY_ENV_TEST_A: "theirs" }));
    expect(mod.setEnvVar("JOY_ENV_TEST_B", "ours")).toEqual({ ok: true });
    expect(readFileSync(join(home, "env.key"), "utf8").trim()).toBe(foreign.toString("base64"));
    expect(sealedNames()).toEqual(["JOY_ENV_TEST_A", "JOY_ENV_TEST_B"]);
  });
});
