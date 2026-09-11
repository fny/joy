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
    // The host shell may export a relay selection; each test sets its own.
    delete process.env.JOY_RELAY_URL;
});
afterEach(() => {
    delete process.env.JOY_HOME_DIR;
    delete process.env.JOY_RELAY_URL;
    vi.doUnmock("os");
    vi.restoreAllMocks();
});

const RELAY = "https://relay.example.test:4997";
const RELAY_KEY = "relay.example.test_4997";

/** A pairing as `joy auth` leaves it: access.key + settings.json {serverUrl}. */
function pairAt(url: string) {
    const key = new URL(url).port ? `${new URL(url).hostname}_${new URL(url).port}` : new URL(url).hostname;
    const dir = join(joy, "relays", key);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "access.key"), "{}");
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ machineId: "m", serverUrl: url }));
}

describe("relay resolution: no default, one relay", () => {
    it("relay creds dir keys by host and port", async () => {
        const { joyRelayCredsDir } = await freshPaths();
        expect(joyRelayCredsDir("https://relay.example.test")).toBe(join(joy, "relays", "relay.example.test"));
        expect(joyRelayCredsDir(RELAY)).toBe(join(joy, "relays", RELAY_KEY));
    });

    it("nothing configured and nothing paired → no relay, and a sentence instead of a guess", async () => {
        const p = await freshPaths();
        expect(p.joyRelayUrlOrNull()).toBeNull();
        expect(() => p.joyRelayUrl()).toThrow(p.NoRelayConfiguredError);
        expect(() => p.joyRelayUrl()).toThrow(/joy auth <relay url>/);
        expect(p).not.toHaveProperty("DEFAULT_RELAY_URL");
        expect(p).not.toHaveProperty("RELAY_ALIASES");
    });

    it("JOY_RELAY_URL selects the relay and scopes state, tmux and creds together", async () => {
        process.env.JOY_RELAY_URL = RELAY;
        const p = await freshPaths();
        expect(p.joyRelayUrl()).toBe(RELAY);
        expect(p.joyRelayKey()).toBe(RELAY_KEY);
        expect(p.tmuxSocketArgs()).toEqual(["-L", `joy-${RELAY_KEY}`]);
        expect(p.tmuxServerLabel("abc")).toBe("joy-abc");
        expect(p.tmuxNamesFor("joy-abc", "abc")).toEqual({ session: "joy-abc", target: "joy-abc:agent" });
        expect(p.tmuxNamesFor(`joy-${RELAY_KEY}-s-abc`, "abc")).toEqual({ session: "j-abc", target: "j-abc" });
        expect(p.joyStateDir()).toBe(join(joy, "relays", RELAY_KEY, "state"));
        expect(p.joyRelayCredsDir()).toBe(join(joy, "relays", RELAY_KEY));
    });

    it("~/.joy/relay.json selects the relay when the env var is absent", async () => {
        mkdirSync(joy, { recursive: true });
        writeFileSync(join(joy, "relay.json"), JSON.stringify({ serverUrl: RELAY }));
        const p = await freshPaths();
        expect(p.joyRelayUrl()).toBe(RELAY);
        expect(p.joyStateDir()).toBe(join(joy, "relays", RELAY_KEY, "state"));
    });

    it("a machine paired before relay.json existed resolves its one pairing", async () => {
        pairAt(RELAY);
        const p = await freshPaths();
        expect(p.joyRelayUrl()).toBe(RELAY);
    });

    it("two pairings and no relay.json → ambiguous, so no relay rather than a pick", async () => {
        pairAt(RELAY);
        pairAt("https://other.example.test");
        const p = await freshPaths();
        expect(p.joyRelayUrlOrNull()).toBeNull();
    });

    it("normalizeRelayUrl gives a bare host its scheme and passes URLs through", async () => {
        const p = await freshPaths();
        expect(p.normalizeRelayUrl("relay.example.test:4997")).toBe(RELAY);
        expect(p.normalizeRelayUrl("relay.example.test")).toBe("https://relay.example.test");
        expect(p.normalizeRelayUrl("http://127.0.0.1:3105/")).toBe("http://127.0.0.1:3105");
        expect(p.normalizeRelayUrl("joy")).toBe("joy"); // no dot, no scheme: not a relay, and not an alias any more
    });
});

describe("isolation: JOY_HOME_DIR override", () => {
    it("everything follows JOY_HOME_DIR; ~ is expanded", async () => {
        process.env.JOY_HOME_DIR = "~/.joy-test";
        const { homedir } = await import("os");
        const p = await freshPaths();
        expect(p.joyHomeDir()).toBe(join(homedir(), ".joy-test"));
        expect(p.joySessionDir("s1")).toBe(join(homedir(), ".joy-test", "sessions", "s1"));
        process.env.JOY_RELAY_URL = RELAY;
        expect(p.joyRelayCredsDir()).toBe(join(homedir(), ".joy-test", "relays", RELAY_KEY));
    });
});

describe("canonicalCwd (#549 #564)", () => {
    it("expands ~, folds `.`/`..`, resolves symlinks, and keeps a not-yet-existing tail under its real parent", async () => {
        const { homedir } = await import("os");
        const { symlinkSync, realpathSync } = await import("fs");
        const p = await freshPaths();
        const root = mkdtempSync(join(tmpdir(), "joy-canon-"));
        const real = join(root, "real"); mkdirSync(real);
        const link = join(root, "link"); symlinkSync(real, link);
        const realRoot = realpathSync.native(real);
        expect(p.canonicalCwd(`${real}/.`)).toBe(realRoot);
        expect(p.canonicalCwd(`${real}/a/../.`)).toBe(realRoot);
        expect(p.canonicalCwd(link)).toBe(realRoot);
        expect(p.canonicalCwd(`${link}/sub/deeper`)).toBe(join(realRoot, "sub", "deeper")); // absent tail, real parent
        expect(p.canonicalCwd("~")).toBe(realpathSync.native(homedir()));
        expect(p.canonicalCwd("~/nope-never-there")).toBe(join(realpathSync.native(homedir()), "nope-never-there"));
        expect(p.canonicalCwd("  /tmp/x/  ")).toBe(join(realpathSync.native("/tmp"), "x"));
    });

    it("#564 residual: `..` after a symlink steps up from the link TARGET, the way the kernel enters it — never folded lexically first", async () => {
        const { symlinkSync, realpathSync } = await import("fs");
        const p = await freshPaths();
        const root = mkdtempSync(join(tmpdir(), "joy-canon-dotdot-"));
        const physical = join(root, "physical"); const nested = join(physical, "nested"); mkdirSync(nested, { recursive: true });
        const other = join(root, "other"); mkdirSync(other);
        const link = join(root, "shortcut"); symlinkSync(nested, link);
        const realPhysical = realpathSync.native(physical);
        // shortcut -> physical/nested, so shortcut/.. IS physical (old code: the test root)
        expect(realpathSync.native(`${link}/..`)).toBe(realPhysical);
        expect(p.canonicalCwd(`${link}/..`)).toBe(realPhysical);
        expect(p.canonicalCwd(`${link}/../..`)).toBe(realpathSync.native(root));
        // an absent tail below the traversal still hangs off the real directory
        expect(p.canonicalCwd(`${link}/../new-dir/deeper`)).toBe(join(realPhysical, "new-dir", "deeper"));
        // `..` inside the absent tail folds lexically (nothing exists to follow); past it, physically again
        expect(p.canonicalCwd(`${link}/nope/../..`)).toBe(realPhysical);
        expect(p.canonicalCwd(`${link}/nope/deeper/..`)).toBe(join(realpathSync.native(nested), "nope"));
        // a second symlink met AFTER a `..` is followed too
        symlinkSync(other, join(physical, "to-other"));
        expect(p.canonicalCwd(`${link}/../to-other`)).toBe(realpathSync.native(other));
        // relative spellings resolve against the (physical) process cwd
        expect(p.canonicalCwd("./")).toBe(process.cwd());
        expect(p.canonicalCwd("sub/../")).toBe(process.cwd());
    });

    it("#564 residual: the same symlink traversal spelled absolute, relative and with `~` all land in the link target's parent", async () => {
        const { symlinkSync, realpathSync } = await import("fs");
        const root = realpathSync.native(mkdtempSync(join(tmpdir(), "joy-canon-spell-")));
        const physical = join(root, "physical"); mkdirSync(join(physical, "nested"), { recursive: true });
        symlinkSync(join(physical, "nested"), join(root, "shortcut"));
        expect(realpathSync.native(`${root}/shortcut/..`)).toBe(physical); // what `cd shortcut/..` reaches
        // absolute
        let p = await freshPaths();
        expect(p.canonicalCwd(`${root}/shortcut/..`)).toBe(physical);
        // relative to the (physical) process cwd — old code: join(cwd, "shortcut/..") folded to `root`
        vi.spyOn(process, "cwd").mockReturnValue(root);
        expect(p.canonicalCwd("shortcut/..")).toBe(physical);
        expect(p.canonicalCwd("./shortcut/../")).toBe(physical);
        expect(p.canonicalCwd("shortcut/../new-dir/deeper")).toBe(join(physical, "new-dir", "deeper"));
        // `~` — old code: join(homedir(), "shortcut/..") folded to the home directory
        vi.doMock("os", async (importOriginal) => ({ ...await importOriginal<typeof import("os")>(), homedir: () => root }));
        p = await freshPaths();
        expect(p.expandHome("~/shortcut/..")).toBe(`${root}/shortcut/..`); // raw: nothing folded before the walk
        expect(p.canonicalCwd("~/shortcut/..")).toBe(physical);
        expect(p.canonicalCwd("~/shortcut/../..")).toBe(root);
        expect(p.canonicalCwd("~")).toBe(root);
    });
});
