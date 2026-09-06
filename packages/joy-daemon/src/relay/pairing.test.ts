import { describe, it, expect, afterEach } from "vitest";
import * as http from "node:http";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseBackupCode, pairWithRelay, deriveRelayPerimeterKey } from "./pairing";
// machineKeyOpensStore reads ~/.joy/env.sealed — keep the test off the live home.
process.env.JOY_HOME_DIR = mkdtempSync(join(tmpdir(), "joy-pairing-test-"));

// Mirror of the app's formatSecretKeyForBackup (secretKeyBackup.ts): base32,
// groups of 5, dash-joined. The parser must round-trip anything it emits.
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function formatBackupCode(bytes: Uint8Array): string {
    let out = "", buf = 0, bits = 0;
    for (const b of bytes) {
        buf = (buf << 8) | b; bits += 8;
        while (bits >= 5) { bits -= 5; out += B32[(buf >> bits) & 0x1f]; }
    }
    if (bits > 0) out += B32[(buf << (5 - bits)) & 0x1f];
    const groups: string[] = [];
    for (let i = 0; i < out.length; i += 5) groups.push(out.slice(i, i + 5));
    return groups.join("-");
}

describe("parseBackupCode", () => {
    it("round-trips the app's dashed base32 format", () => {
        const secret = new Uint8Array(32).map((_, i) => (i * 37 + 5) & 0xff);
        expect(parseBackupCode(formatBackupCode(secret))).toEqual(secret);
    });

    it("forgives lowercase, spaces, and the app's typo substitutions (0→O, 1→I)", () => {
        const secret = new Uint8Array(32).map((_, i) => (i * 11 + 200) & 0xff);
        const code = formatBackupCode(secret).toLowerCase().replace(/-/g, " ").replace(/o/g, "0").replace(/i/g, "1");
        expect(parseBackupCode(code)).toEqual(secret);
    });

    it("accepts the bare base64url on-device form", () => {
        const secret = new Uint8Array(32).map((_, i) => i);
        expect(parseBackupCode(Buffer.from(secret).toString("base64url"))).toEqual(secret);
    });

    // #64: '-' and '_' are base64url alphabet, not a dashed-base32 marker.
    it("accepts a base64url secret that happens to contain '-' or '_' (#64)", () => {
        const secret = new Uint8Array(32).fill(0xfb);
        const code = Buffer.from(secret).toString("base64url");
        expect(code).toMatch(/-/);
        expect(code).toMatch(/_/);
        expect(parseBackupCode(code)).toEqual(secret);
        expect(parseBackupCode(`  ${code}\n`)).toEqual(secret);
    });

    it("rejects wrong-length input", () => {
        expect(() => parseBackupCode("ABCDE-FGHIJ")).toThrow(/length/);
        expect(() => parseBackupCode("")).toThrow();
    });
});

// #607: a poll that finds the answer already collected is answered
// `{state:'consumed', error, consumedAt, message}` — pairWithRelay must
// surface the relay's words and the moment, not "not authorized".

describe("pairWithRelay: consumed answer (#607)", () => {
    it("throws the relay's message and the consumedAt instant", async () => {
        const consumedAt = Date.UTC(2026, 8, 6, 12, 34, 56);
        let polls = 0;
        const server = http.createServer((req, res) => {
            let raw = ""; req.on("data", (c) => (raw += c));
            req.on("end", () => {
                const send = (o: unknown) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
                if (req.url === "/joy/v2/auth") return send({ token: "acct" });
                if (req.url === "/joy/v2/auth/response") return send({ success: true });
                if (req.url === "/joy/v2/auth/request") {
                    polls++;
                    if (polls === 1) return send({ state: "requested" });
                    return send({
                        state: "consumed", error: "pairing_answer_already_collected", consumedAt,
                        message: "This pairing answer was already collected — it cannot be re-issued; start a new pairing.",
                    });
                }
                res.writeHead(404); res.end();
            });
        });
        const url = await new Promise<string>((r) => server.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${(server.address() as any).port}`)));
        try {
            const creds = mkdtempSync(join(tmpdir(), "joy-pair-test-"));
            await expect(pairWithRelay(url, new Uint8Array(32).fill(3), creds)).rejects.toThrow(
                /already collected — it cannot be re-issued; start a new pairing\. \(collected at 2026-09-06T12:34:56\.000Z\)/,
            );
            expect(polls).toBe(2);
        } finally { server.close(); }
    });
});

// #586: a fresh pairing against a relay gated with the account-derived
// perimeter key must present that key from the FIRST request — the daemon has
// no perimeter.key yet, only the pasted secret it derives from.
describe("pairWithRelay", () => {
    let server: http.Server | null = null;
    let credsRoot: string | null = null;
    const savedEnv = process.env.JOY_RELAY_ACCESS_KEY;
    afterEach(() => {
        server?.close(); server = null;
        if (credsRoot) rmSync(credsRoot, { recursive: true, force: true }); credsRoot = null;
        if (savedEnv === undefined) delete process.env.JOY_RELAY_ACCESS_KEY; else process.env.JOY_RELAY_ACCESS_KEY = savedEnv;
    });

    /** A relay whose gate demands `expectedKey` on every request. */
    function gatedRelay(expectedKey: string) {
        const seen: Array<{ path: string; key: string | undefined }> = [];
        let stored: string | null = null;
        let rejected = 0;
        server = http.createServer((req, res) => {
            let raw = ""; req.on("data", (c) => (raw += c));
            req.on("end", () => {
                const key = req.headers["x-joy-relay-key"] as string | undefined;
                seen.push({ path: req.url!, key });
                const send = (status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
                if (key !== expectedKey) { rejected++; return send(401, { error: "relay key required", relay: "joy-relay" }); }
                const body = raw ? JSON.parse(raw) : {};
                if (req.url === "/joy/v2/auth") return send(200, { token: "acct-token" });
                if (req.url === "/joy/v2/auth/response") { stored = body.response; return send(200, { ok: true }); }
                if (req.url === "/joy/v2/auth/request") return send(200, stored ? { state: "authorized", response: stored, token: "term-token" } : { state: "pending" });
                send(404, { error: "nope" });
            });
        });
        return {
            seen, rejected: () => rejected,
            listen: () => new Promise<string>((r) => server!.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${(server!.address() as any).port}`))),
        };
    }

    it("sends the perimeter key derived from the backup secret on every request of a fresh pair (#586)", async () => {
        delete process.env.JOY_RELAY_ACCESS_KEY;
        const secret = new Uint8Array(32).map((_, i) => (i * 7 + 3) & 0xff);
        const expected = deriveRelayPerimeterKey(secret);
        const relay = gatedRelay(expected);
        const url = await relay.listen();
        credsRoot = mkdtempSync(join(tmpdir(), "joy-pair-creds-"));
        const credsDir = join(credsRoot, "relays", "test");
        const machineId = await pairWithRelay(url, secret, credsDir);
        expect(machineId).toMatch(/^[0-9a-f-]{36}$/);
        expect(relay.rejected()).toBe(0);
        expect(relay.seen.length).toBeGreaterThanOrEqual(4);
        expect(relay.seen.every((s) => s.key === expected)).toBe(true);
        expect(readFileSync(join(credsDir, "perimeter.key"), "utf8").trim()).toBe(expected);
        expect(JSON.parse(readFileSync(join(credsDir, "access.key"), "utf8")).token).toBe("term-token");
        expect(existsSync(join(credsDir, "settings.json"))).toBe(true);
    });

    it("an explicit JOY_RELAY_ACCESS_KEY stays the override", async () => {
        process.env.JOY_RELAY_ACCESS_KEY = "static-gate-key";
        const secret = new Uint8Array(32).map((_, i) => (i * 5 + 1) & 0xff);
        const relay = gatedRelay("static-gate-key");
        const url = await relay.listen();
        credsRoot = mkdtempSync(join(tmpdir(), "joy-pair-creds-"));
        await pairWithRelay(url, secret, join(credsRoot, "relays", "test"));
        expect(relay.rejected()).toBe(0);
        expect(relay.seen.every((s) => s.key === "static-gate-key")).toBe(true);
    });
});
