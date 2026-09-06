// #48 — the daemon's secret-bearing state is owner-only.
//
// daemon.json (HTTP bearer token = full session/bash/file access), the window
// records (v2SessionKey — decrypts every app↔daemon message of that session)
// and the ledger (prompt text + the outbox rows' content keys) were all
// written with the umask default (-rw-rw-r-- on the box the issue was filed
// from), inside a state dir with the same. These assert the modes at the
// write sites, including on a REWRITE of a file an older daemon left loose.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, statSync, writeFileSync, chmodSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSecure, writeSecretFileAtomic, SECRET_FILE_MODE, SECRET_DIR_MODE } from "./secretFile";
import { saveWindowRecord, loadWindowRecord } from "./windowRecord";
import { Ledger } from "./ledger";

const mode = (p: string) => statSync(p).mode & 0o7777;
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "joy-secret-mode-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("secretFile (#48)", () => {
  it("creates directories 0700 and tightens an existing loose one", () => {
    const d = join(dir, "state");
    mkdirSecure(d);
    expect(mode(d)).toBe(SECRET_DIR_MODE);
    chmodSync(d, 0o755);
    mkdirSecure(d);
    expect(mode(d)).toBe(SECRET_DIR_MODE);
  });

  it("writes 0600 and ENFORCES it over a world-readable predecessor", () => {
    const f = join(dir, "daemon.json");
    writeFileSync(f, "{}", { mode: 0o664 });
    expect(mode(f)).toBe(0o664);
    writeSecretFileAtomic(f, JSON.stringify({ token: "s3cret" }));
    expect(mode(f)).toBe(SECRET_FILE_MODE);
  });
});

describe("window records are owner-only (#48)", () => {
  it("saves the v2 session key at 0600 in a 0700 dir", () => {
    const base = join(dir, "state");
    expect(saveWindowRecord("aabbccdd", { launchCwd: dir, v2SessionKey: "a".repeat(44) }, base)).toBe(true);
    expect(mode(base)).toBe(SECRET_DIR_MODE);
    expect(mode(join(base, "window-aabbccdd.json"))).toBe(SECRET_FILE_MODE);
    expect(loadWindowRecord("aabbccdd", base)?.v2SessionKey).toBe("a".repeat(44));
  });

  it("re-tightens a record an older daemon wrote world-readable", () => {
    const base = join(dir, "state");
    mkdirSync(base, { recursive: true });
    const p = join(base, "window-11223344.json");
    writeFileSync(p, JSON.stringify({ id: "11223344", launchCwd: dir }), { mode: 0o644 });
    saveWindowRecord("11223344", { v2SessionKey: "k" }, base);
    expect(mode(p)).toBe(SECRET_FILE_MODE);
  });
});

describe("the ledger is owner-only (#48)", () => {
  it("keeps the sqlite file, its WAL and its dir owner-only", () => {
    const base = join(dir, "ledger-state");
    const ledger = Ledger.open(base);
    try {
      ledger.acceptCommand({ sessionId: "s1", text: "a secret prompt", source: "rpc", visible: true, mirrorToRelay: false });
      expect(mode(base)).toBe(SECRET_DIR_MODE);
      expect(mode(ledger.path)).toBe(SECRET_FILE_MODE);
      for (const sib of [`${ledger.path}-wal`, `${ledger.path}-shm`]) {
        if (existsSync(sib)) expect(mode(sib)).toBe(SECRET_FILE_MODE);
      }
    } finally { ledger.close(); }
  });
});
