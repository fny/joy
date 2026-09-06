// Wave F session-family op contracts: fork / teleport fail CLOSED on the
// permission mode (#50), handoff / handback refuse a second in-flight job
// (#53), teleport import canonicalises the cwd (#549) and allows a same-box
// import into another folder (#550), and a provenance-stamped send keeps a
// daemon-owned slash command interceptable (#552). Isolated JOY_HOME_DIR;
// transcript dirs under ~/.claude/projects are created per test and removed.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { randomBytes } from "node:crypto";

vi.mock("./handoff", async (importOriginal) => {
  const real = await importOriginal<typeof import("./handoff")>();
  // The jobs themselves poll for a note for minutes; the op contract under
  // test is the intake, so the background job is a no-op here.
  return { ...real, runHandoffJob: vi.fn(async () => {}), runHandbackJob: vi.fn(async () => {}) };
});

import { machineOps, sourcePermissionMode } from "./operations";
import { closeAllLedgers } from "./ledger";
import { resetCoordinators } from "./coordinator";
import { fakeCoordinatedSession } from "./coordinator.fakeDriver";
import { saveWindowRecord } from "./windowRecord";
import { saveHandoffJob } from "./handoff";
import { cwdToTranscriptDir } from "../claude/transcript";
import { parseJoyCommand } from "../claude/session";

const op = (name: string) => machineOps.find((o) => o.rpcName === name)!;
let home: string;
const realHome = process.env.JOY_HOME_DIR;
const cleanupDirs: string[] = [];
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "joy-ops-session-")); process.env.JOY_HOME_DIR = home; closeAllLedgers(); resetCoordinators(); });
afterEach(() => {
  resetCoordinators(); closeAllLedgers(); // coordinators first: a pump must not wake on a closed ledger
  if (realHome === undefined) delete process.env.JOY_HOME_DIR; else process.env.JOY_HOME_DIR = realHome;
  rmSync(home, { recursive: true, force: true });
  for (const d of cleanupDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const uid = () => randomBytes(4).toString("hex");

// ── #50 ──────────────────────────────────────────────────────────────────────

describe("fork / teleport permission mode fails closed (#50)", () => {
  it("sourcePermissionMode: pane unreadable → the record's mode, else default — never bypass", () => {
    const id = uid();
    const s = { id, detectPermissionMode: () => null } as const;
    expect(sourcePermissionMode(s)).toBe("default");
    saveWindowRecord(id, { launchCwd: home, claudePermissionMode: "plan" });
    expect(sourcePermissionMode(s)).toBe("plan");
    // A live read still wins over the record.
    expect(sourcePermissionMode({ id, detectPermissionMode: () => "acceptEdits" })).toBe("acceptEdits");
    // Codex keeps its mode in its own settings block.
    const cid = uid();
    saveWindowRecord(cid, { launchCwd: home, agent: "codex", codexSettings: { permissionMode: "read-only" } });
    expect(sourcePermissionMode({ id: cid, detectPermissionMode: () => null })).toBe("read-only");
  });

  it("fork of a claude session whose pane read fails continues in the persisted mode, not bypass", async () => {
    const id = uid();
    const { s } = fakeCoordinatedSession(id, { agent: "claude", cwd: home, extra: { claudeSessionId: "abc-1230", detectPermissionMode: () => null, model: "opus" } });
    saveWindowRecord(id, { launchCwd: home, claudePermissionMode: "plan" });
    const create = vi.fn(async (opts: Record<string, unknown>) => ({ id: "f0f0f0f0", toJSON: () => ({ id: "f0f0f0f0", opts }) }));
    const r = (await op("joy-fork-session").handler({ get: (x: string) => (x === id ? s : undefined), create } as never, { id }, { via: "rpc" })) as Record<string, unknown>;
    expect(r.ok).toBe(true);
    expect(create.mock.calls[0][0]).toMatchObject({ resume_id: "abc-1230", forkSession: true, permissionMode: "plan" });
  });

  it("fork with neither a pane read nor a record → default (old code: undefined → bypassPermissions)", async () => {
    const id = uid();
    const { s } = fakeCoordinatedSession(id, { agent: "claude", cwd: home, extra: { claudeSessionId: "abc-1230", detectPermissionMode: () => null } });
    const create = vi.fn(async () => ({ id: "f0f0f0f1", toJSON: () => ({}) }));
    await op("joy-fork-session").handler({ get: () => s, create } as never, { id }, { via: "rpc" });
    expect((create.mock.calls[0] as unknown[])[0]).toMatchObject({ permissionMode: "default" });
  });

  it("teleport export reports the persisted mode when the pane read fails; import defaults a missing mode to `default`", async () => {
    const id = uid();
    const tp = join(home, "t.jsonl");
    writeFileSync(tp, JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }) + "\n");
    const { s } = fakeCoordinatedSession(id, { agent: "claude", cwd: home, extra: { claudeSessionId: "abc-1230", transcriptPath: tp, detectPermissionMode: () => null } });
    saveWindowRecord(id, { launchCwd: home, claudePermissionMode: "acceptEdits" });
    const ex = (await op("joy-teleport-export").handler({ get: () => s } as never, { id }, { via: "rpc" })) as Record<string, unknown>;
    expect(ex.ok).toBe(true);
    expect(ex.permissionMode).toBe("acceptEdits");

    const dst = join(tmpdir(), `joy-tp-${uid()}`); mkdirSync(dst); cleanupDirs.push(dst, cwdToTranscriptDir(dst));
    const create = vi.fn(async () => ({ id: "f0f0f0f2", toJSON: () => ({}) }));
    const im = (await op("joy-teleport-import").handler({ list: () => [], listRecords: () => [], create } as never, { cwd: dst, claudeSessionId: "abc-1230", transcriptBase64: Buffer.from("{}\n").toString("base64") }, { via: "rpc" })) as Record<string, unknown>;
    expect(im.ok).toBe(true);
    expect((create.mock.calls[0] as unknown[])[0]).toMatchObject({ permissionMode: "default" });
  });
});

