import { describe, it, expect, afterEach } from "vitest";
import * as http from "node:http";
import { createHmac, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import tweetnacl from "tweetnacl";
import { parseBackupCode, pairWithRelay, pairingProof, deriveRelayPerimeterKey } from "./pairing";
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

// #127: the pickup proves possession of the ephemeral private key. The fake
// relay below is the relay's REAL construction (accounts.mjs: a per-request
// X25519 keypair + nonce, Node's x25519 + HMAC-SHA256 to verify), so the
// daemon's tweetnacl.scalarMult is checked against OpenSSL inside this suite
// — a drift in the label, the concatenation order or the nonce encoding on
// either side fails here, not in the field.
const X25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");
const X25519_SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");
const PAIRING_PROOF_LABEL = "joy-pairing-proof-v1";

/** The cross-package proof vector — the SAME bytes are asserted by the relay
 *  (packages/joy-relay/test/wave-f-pairing.test.mjs, Node x25519) and the
 *  app (packages/joy-app/sources/encryption/pairingProof.spec.ts, tweetnacl +
 *  expo-crypto), so the three derivations cannot drift apart unnoticed. */
const VECTOR = {
    requesterPriv: Buffer.from("01080f161d242b323940474e555c636a71787f868d949ba2a9b0b7bec5ccd3da", "hex"),
    requesterPub: Buffer.from("c8feca81be196cdf2cadeabf13c4903d7632dce4955aa68b6e5d9adef54e2616", "hex"),
    relayPub: Buffer.from("c25e8b84378b21071d603dfce3f947b162b6e715240344db0a18d99259a6de23", "hex"),
    challenge: Buffer.from("fffcf9f6f3f0edeae7e4e1dedbd8d5d2cfccc9c6c3c0bdbab7b4b1aeaba8a5a2", "hex").toString("base64"),
    proofHex: "58d584b4cc82b5cf464318067108a5e0ccfdbbff55df77b0db7c7a513147cc93",
};

describe("pairingProof (#127)", () => {
    it("reproduces the cross-package test vector", () => {
        const kp = tweetnacl.box.keyPair.fromSecretKey(new Uint8Array(VECTOR.requesterPriv));
        expect(Buffer.from(kp.publicKey).toString("hex")).toBe(VECTOR.requesterPub.toString("hex"));
        const proof = pairingProof(kp, { challenge: VECTOR.challenge, relayPublicKey: VECTOR.relayPub.toString("base64") });
        expect(Buffer.from(proof!, "base64").toString("hex")).toBe(VECTOR.proofHex);
    });

    it("is undefined without a handshake (a relay from before the proof) or with a malformed one", () => {
        const kp = tweetnacl.box.keyPair();
        expect(pairingProof(kp, { state: "requested" })).toBeUndefined();
        expect(pairingProof(kp, { challenge: "abc", relayPublicKey: "AAAA" })).toBeUndefined();
        expect(pairingProof(kp, { challenge: "", relayPublicKey: Buffer.alloc(32).toString("base64") })).toBeUndefined();
    });
});

describe("pairWithRelay: proof of possession (#127)", () => {
    let server: http.Server | null = null;
    let credsRoot: string | null = null;
    afterEach(() => {
        server?.close(); server = null;
        if (credsRoot) rmSync(credsRoot, { recursive: true, force: true }); credsRoot = null;
    });

    interface Row { challenge: string; relayPriv: Buffer; relayPub: Buffer; response: string | null }

    /** A relay that issues the handshake and REQUIRES the proof on pickup.
     *  `handshake:false` strips the handshake (a MITM, or a relay that wants
     *  the proof but never said how); `verdict:'reject'` refuses every proof. */
    function proofRelay({ handshake = true, verdict = "check" as "check" | "reject" } = {}) {
        const rows = new Map<string, Row>();
        const polls: Array<{ proof: string | undefined; state: string | number }> = [];
        let verified = 0;
        const verify = (row: Row, requesterPub: Buffer, proof: unknown) => {
            if (typeof proof !== "string" || !proof) return false;
            const priv = createPrivateKey({ key: Buffer.concat([X25519_PKCS8_PREFIX, row.relayPriv]), format: "der", type: "pkcs8" });
            const pub = createPublicKey({ key: Buffer.concat([X25519_SPKI_PREFIX, requesterPub]), format: "der", type: "spki" });
            const shared = diffieHellman({ privateKey: priv, publicKey: pub });
            const expected = createHmac("sha256", shared)
                .update(Buffer.concat([Buffer.from(PAIRING_PROOF_LABEL), Buffer.from(row.challenge, "base64"), requesterPub, row.relayPub]))
                .digest("base64");
            return expected === proof;
        };
        server = http.createServer((req, res) => {
            let raw = ""; req.on("data", (c) => (raw += c));
            req.on("end", () => {
                const send = (status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
                const body = raw ? JSON.parse(raw) : {};
                if (req.url === "/joy/v2/auth") return send(200, { token: "acct-token" });
                if (req.url === "/joy/v2/auth/response") {
                    const row = rows.get(body.publicKey);
                    if (!row) return send(404, { error: "no_request" });
                    row.response = body.response;
                    return send(200, { success: true });
                }
                if (req.url === "/joy/v2/auth/request") {
                    let row = rows.get(body.publicKey);
                    if (!row) {
                        const kp = generateKeyPairSync("x25519");
                        row = {
                            challenge: randomBytes(32).toString("base64"),
                            relayPriv: Buffer.from(kp.privateKey.export({ format: "jwk" }).d!, "base64url"),
                            relayPub: kp.publicKey.export({ format: "der", type: "spki" }).subarray(-32),
                            response: null,
                        };
                        rows.set(body.publicKey, row);
                    }
                    const hs = handshake ? { challenge: row.challenge, relayPublicKey: row.relayPub.toString("base64") } : {};
                    const proven = body.proof !== undefined;
                    if (proven) {
                        const ok = verdict === "check" && verify(row, Buffer.from(body.publicKey, "base64"), body.proof);
                        if (!ok) { polls.push({ proof: body.proof, state: 401 }); return send(401, { error: "invalid_proof" }); }
                        verified++;
                    }
                    if (!row.response) { polls.push({ proof: body.proof, state: "requested" }); return send(200, { state: "requested", ...hs }); }
                    if (proven) { polls.push({ proof: body.proof, state: "authorized" }); return send(200, { state: "authorized", response: row.response, token: "term-token" }); }
                    polls.push({ proof: undefined, state: "proof_required" });
                    return send(200, {
                        state: "proof_required", error: "proof_required",
                        message: "This pairing is approved; present `proof` to collect it.", ...hs,
                    });
                }
                send(404, { error: "nope" });
            });
        });
        return {
            polls, verified: () => verified,
            listen: () => new Promise<string>((r) => server!.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${(server!.address() as any).port}`))),
        };
    }

    const secret = new Uint8Array(32).map((_, i) => (i * 3 + 9) & 0xff);

    it("the pickup carries a proof the relay verifies with Node x25519, and the bearer is written", async () => {
        const relay = proofRelay();
        const url = await relay.listen();
        credsRoot = mkdtempSync(join(tmpdir(), "joy-pair-proof-"));
        const credsDir = join(credsRoot, "relays", "test");
        await pairWithRelay(url, secret, credsDir);
        expect(relay.verified()).toBe(1);
        // Creation (no handshake yet to prove over), then the proven pickup.
        expect(relay.polls.map((p) => p.state)).toEqual(["requested", "authorized"]);
        expect(relay.polls[0].proof).toBeUndefined();
        expect(Buffer.from(relay.polls[1].proof!, "base64").length).toBe(32);
        expect(JSON.parse(readFileSync(join(credsDir, "access.key"), "utf8")).token).toBe("term-token");
    });

    it("a proof the relay rejects surfaces as HTTP 401 invalid_proof, and nothing is written", async () => {
        const relay = proofRelay({ verdict: "reject" });
        const url = await relay.listen();
        credsRoot = mkdtempSync(join(tmpdir(), "joy-pair-proof-"));
        const credsDir = join(credsRoot, "relays", "test");
        await expect(pairWithRelay(url, secret, credsDir)).rejects.toThrow(/HTTP 401.*invalid_proof/);
        expect(relay.polls.at(-1)).toMatchObject({ state: 401 });
        expect(existsSync(join(credsDir, "access.key"))).toBe(false);
    });

    it("a relay that requires the proof but issued no handshake fails closed with proof_required, never a token", async () => {
        const relay = proofRelay({ handshake: false });
        const url = await relay.listen();
        credsRoot = mkdtempSync(join(tmpdir(), "joy-pair-proof-"));
        const credsDir = join(credsRoot, "relays", "test");
        await expect(pairWithRelay(url, secret, credsDir)).rejects.toThrow(/state=proof_required/);
        expect(relay.verified()).toBe(0);
        expect(relay.polls.map((p) => p.state)).toEqual(["requested", "proof_required"]);
        expect(existsSync(join(credsDir, "access.key"))).toBe(false);
    });
});
