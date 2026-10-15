// Session secrets: set/get/list/remove per session, names without regard to
// case, all-or-nothing sets, kill and fork bookkeeping, the file on disk is
// sealed, and redaction of a session's values in its outgoing records.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let home: string;
let mod: typeof import("./secretsStore");
const A = "aaaaaaaa";
const B = "bbbbbbbb";

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "joy-secrets-"));
  process.env.JOY_HOME_DIR = home;
  mod = await import("./secretsStore");
});
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

describe("secrets store", () => {
  it("keeps each session's secrets to itself, names without regard to case", () => {
    expect(mod.setSecrets(A, { email: "me@x.com", Password: "hunter22" })).toEqual({ ok: true, names: ["email", "Password"] });
    expect(mod.setSecrets(B, { email: "other@x.com" })).toMatchObject({ ok: true });
    expect(mod.getSecret(A, "EMAIL")).toEqual({ ok: true, name: "email", value: "me@x.com" });
    expect(mod.getSecret(A, "password")).toMatchObject({ value: "hunter22" });
    expect(mod.getSecret(B, "email")).toMatchObject({ value: "other@x.com" });
    expect(mod.getSecret(B, "password")).toEqual({ ok: false, error: "not_found" });
    const list = mod.listSecrets(A);
    expect(list.ok && list.secrets.map((s) => s.name)).toEqual(["email", "Password"]);
  });

  it("replaces a value by name, keeping the spelling last written", () => {
    mod.setSecrets(A, { token: "one-1" });
    mod.setSecrets(A, { TOKEN: "two-2" });
    expect(mod.getSecret(A, "token")).toEqual({ ok: true, name: "TOKEN", value: "two-2" });
    const list = mod.listSecrets(A);
    expect(list.ok && list.secrets.length).toBe(1);
  });

  it("refuses a whole set when one name or value is bad", () => {
    expect(mod.setSecrets(A, { good: "value", "bad name": "x" })).toMatchObject({ ok: false, error: "bad_name", name: "bad name" });
    expect(mod.setSecrets(A, { good: "value", empty: "" })).toMatchObject({ ok: false, error: "bad_value", name: "empty" });
    expect(mod.getSecret(A, "good")).toEqual({ ok: false, error: "not_found" });
    expect(mod.setSecrets("not-an-id", { a: "b" })).toMatchObject({ ok: false, error: "bad_session" });
  });

  it("removes one, drops a killed session's, copies to a fork", () => {
    mod.setSecrets(A, { email: "me@x.com", password: "hunter22" });
    expect(mod.removeSecret(A, "EMAIL")).toEqual({ ok: true, existed: true });
    expect(mod.removeSecret(A, "email")).toEqual({ ok: true, existed: false });
    mod.copySessionSecrets(A, B);
    expect(mod.getSecret(B, "password")).toMatchObject({ value: "hunter22" });
    mod.dropSessionSecrets(A);
    expect(mod.listSecrets(A)).toEqual({ ok: true, secrets: [] });
    expect(mod.getSecret(B, "password")).toMatchObject({ value: "hunter22" }); // the fork keeps its copy
  });

  it("is sealed on disk, apart from the env store", () => {
    mod.setSecrets(A, { password: "hunter22-plain" });
    const file = join(home, "secrets.sealed");
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, "utf8")).not.toContain("hunter22-plain");
    expect(existsSync(join(home, "env.sealed"))).toBe(false);
  });
});

describe("redaction", () => {
  it("blanks a session's values in its records, and only that session's", () => {
    mod.setSecrets(A, { password: "hunter22", quote: 'a"b\\c' });
    const rec = { role: "agent", content: { type: "output", text: "pw is hunter22, odd one a\"b\\c" } };
    expect(mod.redactSecrets(A, rec)).toEqual({ role: "agent", content: { type: "output", text: `pw is ${mod.REDACTED}, odd one ${mod.REDACTED}` } });
    expect(mod.redactSecrets(B, rec)).toBe(rec);
  });

  it("leaves very short values alone, and a record without secrets untouched", () => {
    mod.setSecrets(A, { pin: "123" });
    const rec = { text: "step 123 of 456" };
    expect(mod.redactSecrets(A, rec)).toBe(rec);
  });

  it("sees a value set after the first redaction", () => {
    const rec = { text: "token abcd-1234" };
    expect(mod.redactSecrets(A, rec)).toBe(rec);
    mod.setSecrets(A, { token: "abcd-1234" });
    expect(mod.redactSecrets(A, rec)).toEqual({ text: `token ${mod.REDACTED}` });
  });
});
