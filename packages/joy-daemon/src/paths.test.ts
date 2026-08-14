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
    // The host shell may export a relay selection (per-relay daemon work);
    // these tests assume the DEFAULT relay unless a test sets one itself.
    delete process.env.JOY_RELAY_URL;
});
afterEach(() => {
    delete process.env.HAPPY_HOME_DIR;
    delete process.env.JOY_HOME_DIR;
    delete process.env.JOY_RELAY_URL;
});

describe("state migration (transition safety)", () => {
    it("renames legacy state to ~/.joy/state — content served from the new path", async () => {
        const legacy = join(happy, "joy-tmux-state");
        mkdirSync(legacy, { recursive: true });
        writeFileSync(join(legacy, "joy-hook.mjs"), "// forwarder");
        const { joyStateDir } = await freshPaths();
        const dir = joyStateDir();
        expect(dir).toBe(join(joy, "state"));
        // migrated content readable at the NEW path
        expect(readFileSync(join(dir, "joy-hook.mjs"), "utf8")).toContain("forwarder");
        // legacy location is gone (no compat symlink since the 2026-08-13
        // fleet cycle — old baked hook paths no longer exist anywhere)
        expect(() => lstatSync(legacy)).toThrow();
    });

    it("fresh machine (no legacy, no state): new path used, no legacy artifacts", async () => {
        const { joyStateDir } = await freshPaths();
        expect(joyStateDir()).toBe(join(joy, "state"));
        expect(() => lstatSync(join(happy, "joy-tmux-state"))).toThrow();
    });

    it("relay creds dir keys by host and port", async () => {
        const { joyRelayCredsDir } = await freshPaths();
        expect(joyRelayCredsDir("https://joy.voltai.party")).toBe(join(joy, "relays", "joy.voltai.party"));
        expect(joyRelayCredsDir("https://joy.voltai.party:1443")).toBe(join(joy, "relays", "joy.voltai.party_1443"));
    });
});

describe("per-relay namespacing (concurrent daemons)", () => {
    it("default relay: default selection, plain tmux server, ~/.joy/state", async () => {
        const p = await freshPaths();
        expect(p.joyRelayUrl()).toBe(p.DEFAULT_RELAY_URL);
        expect(p.isDefaultRelay()).toBe(true);
        expect(p.tmuxSocketArgs()).toEqual([]);
        expect(p.joyStateDir()).toBe(join(joy, "state"));
    });

    it("JOY_RELAY_URL alias resolves and scopes state + tmux + creds together", async () => {
        process.env.JOY_RELAY_URL = "joy";
        const p = await freshPaths();
        expect(p.joyRelayUrl()).toBe("https://joy.voltai.party:4997");
        expect(p.isDefaultRelay()).toBe(false);
        expect(p.joyRelayKey()).toBe("joy.voltai.party_4997");
        expect(p.tmuxSocketArgs()).toEqual(["-L", "joy-joy.voltai.party_4997"]);
        // state sits beside that relay's credentials — nothing shared with the
        // default daemon's ~/.joy/state
        expect(p.joyStateDir()).toBe(join(joy, "relays", "joy.voltai.party_4997", "state"));
        expect(p.joyRelayCredsDir()).toBe(join(joy, "relays", "joy.voltai.party_4997"));
    });

    it("~/.joy/relay.json selects the relay when the env var is absent", async () => {
        mkdirSync(joy, { recursive: true });
        writeFileSync(join(joy, "relay.json"), JSON.stringify({ serverUrl: "https://joy.voltai.party:14997" }));
        const p = await freshPaths();
        expect(p.joyRelayUrl()).toBe("https://joy.voltai.party:14997");
        expect(p.joyStateDir()).toBe(join(joy, "relays", "joy.voltai.party_14997", "state"));
    });

    it("an explicit default-relay env value stays default (no accidental namespacing)", async () => {
        process.env.JOY_RELAY_URL = "happy";
        const p = await freshPaths();
        expect(p.isDefaultRelay()).toBe(true);
        expect(p.tmuxSocketArgs()).toEqual([]);
        expect(p.joyStateDir()).toBe(join(joy, "state"));
    });
});

describe("isolation: HAPPY_HOME_DIR override", () => {
    it("joy home follows an overridden happy home when JOY_HOME_DIR is unset", async () => {
        delete process.env.JOY_HOME_DIR;
        const { joyHomeDir, joyStateDir } = await freshPaths();
        expect(joyHomeDir()).toBe(happy);
        expect(joyStateDir()).toBe(join(happy, "state"));
    });
});
