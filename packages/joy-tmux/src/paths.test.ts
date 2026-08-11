import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, lstatSync, realpathSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// joyStateDir caches its one-shot migration in module state — re-import fresh
// per test so each scenario starts unmigrated.
async function freshPaths() {
    vi.resetModules();
    return await import("./paths");
}

let happy: string;
let joy: string;

beforeEach(() => {
    const root = mkdtempSync(join(tmpdir(), "joy-paths-"));
    happy = join(root, "happy");
    joy = join(root, "joy");
    process.env.HAPPY_HOME_DIR = happy;
    process.env.JOY_HOME_DIR = joy;
});
afterEach(() => {
    delete process.env.HAPPY_HOME_DIR;
    delete process.env.JOY_HOME_DIR;
});

describe("state migration (transition safety)", () => {
    it("renames legacy state to ~/.joy/state AND leaves a compat symlink — both paths serve the same files", async () => {
        const legacy = join(happy, "joy-tmux-state");
        mkdirSync(legacy, { recursive: true });
        writeFileSync(join(legacy, "joy-hook.mjs"), "// forwarder");
        const { joyStateDir } = await freshPaths();
        const dir = joyStateDir();
        expect(dir).toBe(join(joy, "state"));
        // migrated content readable at the NEW path
        expect(readFileSync(join(dir, "joy-hook.mjs"), "utf8")).toContain("forwarder");
        // …and STILL readable at the OLD baked-in path (live sessions' hooks)
        expect(readFileSync(join(legacy, "joy-hook.mjs"), "utf8")).toContain("forwarder");
        expect(lstatSync(legacy).isSymbolicLink()).toBe(true);
        expect(realpathSync(legacy)).toBe(realpathSync(dir));
        // a write via the OLD path lands in the new dir (transition writers)
        writeFileSync(join(legacy, "via-old.txt"), "x");
        expect(readFileSync(join(dir, "via-old.txt"), "utf8")).toBe("x");
    });

    it("creates the compat symlink even when migration already happened (no legacy dir)", async () => {
        mkdirSync(join(joy, "state"), { recursive: true });
        writeFileSync(join(joy, "state", "daemon.json"), "{}");
        const { joyStateDir } = await freshPaths();
        joyStateDir();
        const legacy = join(happy, "joy-tmux-state");
        expect(lstatSync(legacy).isSymbolicLink()).toBe(true);
        expect(readFileSync(join(legacy, "daemon.json"), "utf8")).toBe("{}");
    });

    it("fresh machine (no legacy, no state): new path used, symlink still placed", async () => {
        const { joyStateDir } = await freshPaths();
        expect(joyStateDir()).toBe(join(joy, "state"));
        expect(lstatSync(join(happy, "joy-tmux-state")).isSymbolicLink()).toBe(true);
    });

    it("relay creds dir keys by host and port", async () => {
        const { joyRelayCredsDir } = await freshPaths();
        expect(joyRelayCredsDir("https://joy.voltai.party")).toBe(join(joy, "relays", "joy.voltai.party"));
        expect(joyRelayCredsDir("https://joy.voltai.party:1443")).toBe(join(joy, "relays", "joy.voltai.party_1443"));
    });
});
