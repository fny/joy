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
import { closeAllLedgers, ledgerFor, LedgerWriteError } from "./ledger";
import { resetCoordinators, SessionCoordinator } from "./coordinator";
import { fakeCoordinatedSession } from "./coordinator.fakeDriver";
import { saveWindowRecord } from "./windowRecord";
import { saveHandoffJob, loadHandoffJob } from "./handoff";
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

// ── #53 ──────────────────────────────────────────────────────────────────────

function handoffCapable(id: string, cwd: string) {
  const infos: Array<Record<string, unknown> | null> = [];
  const { s } = fakeCoordinatedSession(id, {
    agent: "claude", cwd,
    extra: {
      setHandoff: (info: Record<string, unknown> | null) => { infos.push(info); },
      cardMetadata: () => ({ joy__handoff: infos[infos.length - 1] ?? undefined }),
    },
  });
  return { s, infos };
}

describe("handoff / handback in-progress guard (#53)", () => {
  it("a second handoff for the same source is refused while the first is writing its note", async () => {
    const id = uid();
    const { s, infos } = handoffCapable(id, home);
    const reg = { get: (x: string) => (x === id ? s : undefined) } as never;
    const first = (await op("joy-handoff").handler(reg, { id, agent: "codex" }, { via: "rpc" })) as Record<string, unknown>;
    expect(first).toMatchObject({ ok: true, pending: true });
    expect(infos.at(-1)).toMatchObject({ state: "writing" });
    const second = (await op("joy-handoff").handler(reg, { id, agent: "codex" }, { via: "rpc" })) as Record<string, unknown>;
    expect(second).toEqual({ ok: false, error: "handoff already in progress" });
    expect(infos.filter((i) => i?.state === "writing")).toHaveLength(1); // no second note prompt / job
  });

  it("a persisted job (the daemon restarted mid-note) also blocks a new handoff", async () => {
    const id = uid();
    const { s } = handoffCapable(id, home);
    saveHandoffJob(id, { role: "source", path: join(home, "note.md"), target: { agent: "codex" }, at: Date.now() });
    const r = await op("joy-handoff").handler({ get: () => s } as never, { id, agent: "codex" }, { via: "rpc" });
    expect(r).toEqual({ ok: false, error: "handoff already in progress" });
  });

  it("handback: the second call is refused while the first is writing", async () => {
    const srcId = uid(), tgtId = uid();
    const { s: src } = handoffCapable(srcId, home);
    const { s: tgt, infos } = handoffCapable(tgtId, home);
    tgt.setHandoff!({ state: "picked_up", peer: srcId, at: Date.now() });
    const reg = { get: (x: string) => (x === srcId ? src : x === tgtId ? tgt : undefined) } as never;
    const first = (await op("joy-handback").handler(reg, { id: tgtId }, { via: "rpc" })) as Record<string, unknown>;
    expect(first).toMatchObject({ ok: true, pending: true });
    expect(infos.at(-1)).toMatchObject({ state: "writing", peer: srcId });
    const second = await op("joy-handback").handler(reg, { id: tgtId }, { via: "rpc" });
    expect(second).toEqual({ ok: false, error: "handback already in progress" });
  });

  // A refused ledger commit (SQLITE_FULL) used to be published as `writing`
  // FIRST: no prompt, no job, and the guard above then refused every retry.
  const refuseNextAccept = () => vi.spyOn(SessionCoordinator.prototype, "accept").mockImplementationOnce(() => { throw new LedgerWriteError("accept", new Error("SQLITE_FULL")); });

  it("handoff: the note cannot be durably queued → card untouched, no job, not_durable — and the retry goes through", async () => {
    const id = uid();
    const { s, infos } = handoffCapable(id, home);
    const reg = { get: (x: string) => (x === id ? s : undefined) } as never;
    const spy = refuseNextAccept();
    try {
      const r = (await op("joy-handoff").handler(reg, { id, agent: "codex" }, { via: "rpc" })) as Record<string, unknown>;
      expect(r).toMatchObject({ ok: false, error: "not_durable" });
      expect(String(r.detail)).toContain("SQLITE_FULL");
      expect(op("joy-handoff").httpShape!(r).status).toBe(503);
      expect(infos).toEqual([]); // never marked writing, nothing to roll back
      expect(loadHandoffJob(id)).toBeNull();
      expect(ledgerFor().listCommands(id)).toEqual([]);
      // The disk cleared: the same request is accepted, the guard did not lock the session.
      const retry = (await op("joy-handoff").handler(reg, { id, agent: "codex" }, { via: "rpc" })) as Record<string, unknown>;
      expect(retry).toMatchObject({ ok: true, pending: true });
      expect(infos.at(-1)).toMatchObject({ state: "writing" });
      expect(ledgerFor().listCommands(id)).toHaveLength(1);
      // …and once in flight the double-tap guard still holds.
      const third = await op("joy-handoff").handler(reg, { id, agent: "codex" }, { via: "rpc" });
      expect(third).toEqual({ ok: false, error: "handoff already in progress" });
    } finally { spy.mockRestore(); }
  });

  it("handback: the note cannot be durably queued → target card untouched, no job, not_durable — and the retry goes through", async () => {
    const srcId = uid(), tgtId = uid();
    const { s: src } = handoffCapable(srcId, home);
    const { s: tgt, infos } = handoffCapable(tgtId, home);
    tgt.setHandoff!({ state: "picked_up", peer: srcId, at: Date.now() });
    const reg = { get: (x: string) => (x === srcId ? src : x === tgtId ? tgt : undefined) } as never;
    const spy = refuseNextAccept();
    try {
      const r = (await op("joy-handback").handler(reg, { id: tgtId }, { via: "rpc" })) as Record<string, unknown>;
      expect(r).toMatchObject({ ok: false, error: "not_durable" });
      expect(op("joy-handback").httpShape!(r).status).toBe(503);
      expect(infos.at(-1)).toMatchObject({ state: "picked_up" }); // the previous card state survives
      expect(loadHandoffJob(tgtId)).toBeNull();
      expect(ledgerFor().listCommands(tgtId)).toEqual([]);
      const retry = (await op("joy-handback").handler(reg, { id: tgtId }, { via: "rpc" })) as Record<string, unknown>;
      expect(retry).toMatchObject({ ok: true, pending: true });
      expect(infos.at(-1)).toMatchObject({ state: "writing", peer: srcId });
      expect(await op("joy-handback").handler(reg, { id: tgtId }, { via: "rpc" })).toEqual({ ok: false, error: "handback already in progress" });
    } finally { spy.mockRestore(); }
  });

  it("handback from an ENDED target is refused outright (only the source used to be checked)", async () => {
    const srcId = uid(), tgtId = uid();
    const { s: src } = handoffCapable(srcId, home);
    const { s: tgt, infos } = handoffCapable(tgtId, home);
    tgt.setHandoff!({ state: "picked_up", peer: srcId, at: Date.now() });
    (tgt as { status: string }).status = "ended";
    const reg = { get: (x: string) => (x === srcId ? src : x === tgtId ? tgt : undefined) } as never;
    const r = (await op("joy-handback").handler(reg, { id: tgtId }, { via: "rpc" })) as Record<string, unknown>;
    expect(r.ok).toBe(false);
    expect(String(r.error)).toMatch(/has ended; restart it before handing back/);
    expect(infos.at(-1)).toMatchObject({ state: "picked_up" }); // never `writing`
    expect(loadHandoffJob(tgtId)).toBeNull();
    expect(ledgerFor().listCommands(tgtId)).toEqual([]);
  });
});

const TELEPORT_B64 = Buffer.from(JSON.stringify({ type: "user", message: { role: "user", content: "x" } }) + "\n").toString("base64");

// ── #549 ─────────────────────────────────────────────────────────────────────

describe("teleport import canonicalises the cwd (#549)", () => {
  const b64 = TELEPORT_B64;
  it("a `~/…` cwd is expanded before the transcript dir is derived, and the same cwd reaches create()", async () => {
    const name = `joy-wavef-${uid()}`;
    const expanded = join(homedir(), name);
    cleanupDirs.push(cwdToTranscriptDir(expanded), cwdToTranscriptDir(`~/${name}`));
    const create = vi.fn(async () => ({ id: "f0f0f0f3", toJSON: () => ({}) }));
    const r = (await op("joy-teleport-import").handler({ list: () => [], listRecords: () => [], create } as never, { cwd: `~/${name}`, claudeSessionId: "abc-5490", transcriptBase64: b64 }, { via: "rpc" })) as Record<string, unknown>;
    expect(r.ok).toBe(true);
    expect(existsSync(join(cwdToTranscriptDir(expanded), "abc-5490.jsonl"))).toBe(true);      // where Claude will look
    expect(existsSync(cwdToTranscriptDir(`~/${name}`))).toBe(false);                          // old code: the literal tilde dir
    expect((create.mock.calls[0] as unknown[])[0]).toMatchObject({ cwd: expanded, resume_id: "abc-5490" });
  });
});

// ── #550 ─────────────────────────────────────────────────────────────────────

describe("same-machine teleport into another folder (#550)", () => {
  const b64 = TELEPORT_B64;
  it("an import into ANOTHER folder is allowed; into the source's own folder it is refused", async () => {
    const src = join(tmpdir(), `joy-src-${uid()}`); mkdirSync(src);
    const dst = join(tmpdir(), `joy-dst-${uid()}`); mkdirSync(dst);
    cleanupDirs.push(src, dst, cwdToTranscriptDir(src), cwdToTranscriptDir(dst));
    const sid = "abc-5500";
    const live = { id: uid(), cwd: src, status: "active", claudeSessionId: sid, transcriptPath: join(cwdToTranscriptDir(src), `${sid}.jsonl`) };
    const create = vi.fn(async () => ({ id: "f0f0f0f4", toJSON: () => ({}) }));
    const reg = { list: () => [live], listRecords: () => [{ id: live.id, claudeSessionId: sid, launchCwd: src }], create } as never;
    const other = (await op("joy-teleport-import").handler(reg, { cwd: dst, claudeSessionId: sid, transcriptBase64: b64 }, { via: "rpc" })) as Record<string, unknown>;
    expect(other.ok).toBe(true);                                                              // old code: "belongs to a session …"
    expect((create.mock.calls[0] as unknown[])[0]).toMatchObject({ cwd: dst, resume_id: sid, forkSession: true });
    const same = (await op("joy-teleport-import").handler(reg, { cwd: src, claudeSessionId: sid, transcriptBase64: b64 }, { via: "rpc" })) as Record<string, unknown>;
    expect(same.error).toMatch(/belongs to a session in/);
    expect(create).toHaveBeenCalledTimes(1);
    // The record alone (a daemon-forgotten session in the source folder) refuses too.
    const recOnly = { list: () => [], listRecords: () => [{ id: "deadbeef", claudeSessionId: sid, launchCwd: `${src}/.` }], create } as never;
    const viaRec = (await op("joy-teleport-import").handler(recOnly, { cwd: src, claudeSessionId: sid, transcriptBase64: b64 }, { via: "rpc" })) as Record<string, unknown>;
    expect(viaRec.error).toMatch(/belongs to a session in/);
  });
});

// ── #552 ─────────────────────────────────────────────────────────────────────

describe("provenance keeps daemon slash commands interceptable (#552)", () => {
  function interceptingSession(id: string) {
    const seen: string[] = [];
    const { s, driver, accepted } = fakeCoordinatedSession(id, { agent: "claude", cwd: home });
    driver.commands = (text) => {
      seen.push(text);
      const cmd = parseJoyCommand(text);
      if (!cmd) return null;
      if (cmd.name === "steer") return { steer: cmd.args };
      return { handled: true };
    };
    const reg = { get: (x: string) => (x === id ? s : undefined), nextChatId: () => 1, addChatMessage: () => {} } as never;
    return { s, seen, accepted, reg };
  }

  it("/title with `from` reaches the adapter as a command (handled), not as a wrapped prompt", async () => {
    const id = uid();
    const { seen, accepted, reg } = interceptingSession(id);
    const r = (await op("joy-send").handler(reg, { session_id: id, text: "/title New name", from: "cli" }, { via: "rpc" })) as Record<string, unknown>;
    expect(r.ok).toBe(true);
    expect(seen).toEqual(["/title New name"]);              // old code: "<joy-message from=\"cli\">\n/title New name\n</joy-message>"
    expect(accepted()).toEqual(["/title New name"]);
  });

  it("/steer with `from` keeps its command head; the steered body carries the provenance", async () => {
    const id = uid();
    const { seen, reg } = interceptingSession(id);
    const r = (await op("joy-send").handler(reg, { session_id: id, text: "/steer go left", from: "cli" }, { via: "rpc" })) as Record<string, unknown>;
    expect(r.ok).toBe(true);
    expect(seen[0]).toMatch(/^\/steer <joy-message from="cli">\ngo left\n<\/joy-message>$/);
  });

  it("an ordinary message with `from` is still wrapped", async () => {
    const id = uid();
    const { accepted, reg } = interceptingSession(id);
    await op("joy-send").handler(reg, { session_id: id, text: "plain words", from: "cli" }, { via: "rpc" });
    expect(accepted()[0]).toBe('<joy-message from="cli">\nplain words\n</joy-message>');
  });
});
