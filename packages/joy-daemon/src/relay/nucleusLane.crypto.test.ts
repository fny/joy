// Pins the daemon's REAL v2 crypto (the functions the lane ships) — seal/
// encode/decode round-trips, the plaintext seam, tamper-safety, spawn-spec
// parsing, and the exact wire structure the app's libsodium codec opens.
// (Cross-library interop is pinned app-side in
// joy-app/sources/sync/v2/crypto.interop.test.ts; this fence guards that the
// real daemon output keeps the shape that test assumes.)
import { describe, it, expect } from "vitest";
import nacl from "tweetnacl";
import { encodeContent, decodeContent, sealSessionKey, decodeSpawnSpec } from "./nucleusLane";

describe("daemon v2 crypto (real shipped functions)", () => {
    it("content round-trips under a key", () => {
        const key = nacl.randomBytes(32);
        const ct = encodeContent("agent output ✓ 日本語", key);
        expect(ct.startsWith("v2e1:")).toBe(true);
        expect(decodeContent(ct, key)).toBe("agent output ✓ 日本語");
    });

    it("no key → plaintext envelope both ways", () => {
        const ct = encodeContent("plain", null);
        expect(ct.startsWith("v2e1:")).toBe(false);
        expect(decodeContent(ct)).toBe("plain");
    });

    it("sealed content refuses to decode without the key (null, not leak)", () => {
        const key = nacl.randomBytes(32);
        expect(decodeContent(encodeContent("secret", key), null)).toBeNull();
        expect(decodeContent(encodeContent("secret", key), nacl.randomBytes(32))).toBeNull();
    });

    it("wire structure the app codec depends on stays stable", () => {
        const key = nacl.randomBytes(32);
        const contentRaw = Buffer.from(encodeContent("x", key).slice(5), "base64");
        // v2e1: nonce(24) ‖ secretbox(ct+tag16)
        expect(contentRaw.length).toBeGreaterThanOrEqual(24 + 16 + 1);

        const account = nacl.box.keyPair();
        const env = sealSessionKey(nacl.randomBytes(32), account.publicKey);
        expect(env.startsWith("v2sk1:")).toBe(true);
        const envRaw = Buffer.from(env.slice(6), "base64");
        // v2sk1: epk(32) ‖ nonce(24) ‖ box(key32+tag16)
        expect(envRaw.length).toBe(32 + 24 + 32 + 16);
    });

    it("session-key envelope opens with the account secret, not another", () => {
        const account = nacl.box.keyPair();
        const sk = nacl.randomBytes(32);
        const env = sealSessionKey(sk, account.publicKey);
        const raw = Buffer.from(env.slice(6), "base64");
        const epk = new Uint8Array(raw.subarray(0, 32));
        const nonce = new Uint8Array(raw.subarray(32, 56));
        const ct = new Uint8Array(raw.subarray(56));
        expect(Buffer.from(nacl.box.open(ct, nonce, epk, account.secretKey)!).toString("hex")).toBe(Buffer.from(sk).toString("hex"));
        expect(nacl.box.open(ct, nonce, epk, nacl.box.keyPair().secretKey)).toBeNull();
    });

    it("spawn spec parses only the v2 shape", () => {
        expect(decodeSpawnSpec(JSON.stringify({ v: 1, t: "spawn", cwd: "/x", agent: "claude" }))).toMatchObject({ cwd: "/x", agent: "claude" });
        expect(decodeSpawnSpec(JSON.stringify({ v: 1, t: "plain", text: "hi" }))).toBeNull();
        expect(decodeSpawnSpec(null)).toBeNull();
        expect(decodeSpawnSpec("garbage")).toBeNull();
    });
});
