import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// joyRelayUrl caches its resolution in module state — re-import fresh per
// test so each scenario resolves from its own env.
async function freshPaths() {
    vi.resetModules();
    return await import("./paths");
}

let joy: string;

beforeEach(() => {
    const root = mkdtempSync(join(tmpdir(), "joy-paths-"));
    joy = join(root, "joy");
    process.env.JOY_HOME_DIR = joy;
    // The host shell may export a relay selection (per-relay daemon work);
    // these tests assume the DEFAULT relay unless a test sets one itself.
    delete process.env.JOY_RELAY_URL;
});
afterEach(() => {
    delete process.env.JOY_HOME_DIR;
    delete process.env.JOY_RELAY_URL;
});

describe("per-relay layout", () => {
    it("relay creds dir keys by host and port", async () => {
        const { joyRelayCredsDir } = await freshPaths();
        expect(joyRelayCredsDir("https://joy.voltai.party")).toBe(join(joy, "relays", "joy.voltai.party"));
        expect(joyRelayCredsDir("https://joy.voltai.party:1443")).toBe(join(joy, "relays", "joy.voltai.party_1443"));
    });

    it("no configuration → the joy relay, scoped like any other relay", async () => {
        const p = await freshPaths();
        expect(p.joyRelayUrl()).toBe("https://joy.voltai.party:4997");
        expect(p.joyRelayUrl()).toBe(p.DEFAULT_RELAY_URL);
        expect(p.isDefaultRelay()).toBe(true);
        expect(p.tmuxSocketArgs()).toEqual(["-L", "joy-joy.voltai.party_4997"]);
        expect(p.tmuxServerLabel("abc")).toBe("joy-joy.voltai.party_4997-s-abc");
        expect(p.joyStateDir()).toBe(join(joy, "relays", "joy.voltai.party_4997", "state"));
    });

    it("JOY_RELAY_URL alias resolves and scopes state + tmux + creds together", async () => {
        process.env.JOY_RELAY_URL = "joy-dev";
        const p = await freshPaths();
        expect(p.joyRelayUrl()).toBe("https://joy.voltai.party:14997");
        expect(p.isDefaultRelay()).toBe(false);
        expect(p.joyRelayKey()).toBe("joy.voltai.party_14997");
        expect(p.tmuxSocketArgs()).toEqual(["-L", "joy-joy.voltai.party_14997"]);
        // state sits beside that relay's credentials — nothing shared with the
        // default daemon
        expect(p.joyStateDir()).toBe(join(joy, "relays", "joy.voltai.party_14997", "state"));
        expect(p.joyRelayCredsDir()).toBe(join(joy, "relays", "joy.voltai.party_14997"));
    });

    it("a bare URL passes through resolveRelayAlias unchanged", async () => {
        const p = await freshPaths();
        expect(p.resolveRelayAlias("http://127.0.0.1:3105")).toBe("http://127.0.0.1:3105");
        expect(p.resolveRelayAlias("joy")).toBe(p.DEFAULT_RELAY_URL);
    });

    it("~/.joy/relay.json selects the relay when the env var is absent", async () => {
        mkdirSync(joy, { recursive: true });
        writeFileSync(join(joy, "relay.json"), JSON.stringify({ serverUrl: "https://joy.voltai.party:14997" }));
        const p = await freshPaths();
        expect(p.joyRelayUrl()).toBe("https://joy.voltai.party:14997");
        expect(p.joyStateDir()).toBe(join(joy, "relays", "joy.voltai.party_14997", "state"));
    });
});

describe("isolation: JOY_HOME_DIR override", () => {
    it("everything follows JOY_HOME_DIR; ~ is expanded", async () => {
        process.env.JOY_HOME_DIR = "~/.joy-test";
        const { homedir } = await import("os");
        const p = await freshPaths();
        expect(p.joyHomeDir()).toBe(join(homedir(), ".joy-test"));
        expect(p.joySessionDir("s1")).toBe(join(homedir(), ".joy-test", "sessions", "s1"));
        expect(p.joyRelayCredsDir()).toBe(join(homedir(), ".joy-test", "relays", "joy.voltai.party_4997"));
    });
});
