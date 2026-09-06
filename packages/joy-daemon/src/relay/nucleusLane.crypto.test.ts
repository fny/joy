// Pins the daemon's REAL v2 crypto (the functions the lane ships) — seal/
// encode/decode round-trips, the plaintext seam, tamper-safety, spawn-spec
// parsing, and the exact wire structure the app's libsodium codec opens.
// (Cross-library interop is pinned app-side in
// joy-app/sources/sync/v2/crypto.interop.test.ts; this fence guards that the
// real daemon output keeps the shape that test assumes.)
import { describe, it, expect } from "vitest";
import nacl from "tweetnacl";
import { encodeContent, decodeContent, decodePrompt, openAttachmentBytes, sealSessionKey, decodeSpawnSpec, encodeRecord, decodeRecord, promptRejectReason } from "./nucleusLane";

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

    it("decodePrompt surfaces the attachment citations the app seals beside the text", () => {
        const key = nacl.randomBytes(32);
        // The app's sealV2Content wire shape: {v:1,t:'plain',text,attachments}.
        const seal = (obj: unknown) => {
            const nonce = nacl.randomBytes(24);
            const ct = nacl.secretbox(new Uint8Array(Buffer.from(JSON.stringify(obj), "utf8")), nonce, key);
            return "v2e1:" + Buffer.concat([Buffer.from(nonce), Buffer.from(ct)]).toString("base64");
        };
        const ct = seal({ v: 1, t: "plain", text: "look", attachments: [{ id: "att-1", name: "shot.png", size: 9, mime: "image/png", width: 3, height: 2 }] });
        expect(decodePrompt(ct, key)).toEqual({ text: "look", attachments: [{ id: "att-1", name: "shot.png", size: 9, mime: "image/png" }] });
        expect(decodePrompt(encodeContent("bare", key), key)).toEqual({ text: "bare", attachments: [] });
        expect(decodePrompt(ct, null)).toBeNull();
        // malformed citations are dropped, plaintext sessions parse the JSON as-is
        expect(decodePrompt(JSON.stringify({ v: 1, t: "plain", text: "p", attachments: [{ id: 5 }, { id: "ok", name: "f" }] })))
            .toEqual({ text: "p", attachments: [{ id: "ok", name: "f", size: 0 }] });
    });

    it("attachment bytes open under the session key (app sealV2Bytes layout) and refuse otherwise", () => {
        const key = nacl.randomBytes(32);
        const bytes = nacl.randomBytes(500);
        const nonce = nacl.randomBytes(24);
        const sealed = Buffer.concat([Buffer.from(nonce), Buffer.from(nacl.secretbox(bytes, nonce, key))]);
        expect(Buffer.from(openAttachmentBytes(new Uint8Array(sealed), key)!)).toEqual(Buffer.from(bytes));
        expect(openAttachmentBytes(new Uint8Array(sealed), nacl.randomBytes(32))).toBeNull();
        expect(openAttachmentBytes(new Uint8Array(3), key)).toBeNull();
        expect(openAttachmentBytes(bytes, null)).toBe(bytes);
    });

    it("adapter records seal as {t:'record'} and never read as text (or vice versa)", () => {
        const key = nacl.randomBytes(32);
        const record = { role: "session" as const, content: { type: "session", data: { id: "e1", time: 1, role: "agent", turn: "t1", ev: { t: "tool-call-start", call: "c1", name: "Read", title: "Read", description: "", args: { path: "x" } } } }, meta: { sentFrom: "joy" } };
        const ct = encodeRecord(record, key);
        expect(ct.startsWith("v2e1:")).toBe(true);
        expect(decodeRecord(ct, key)).toEqual(record);
        expect(decodeRecord(ct, null)).toBeNull();
        expect(decodeContent(ct, key)).toBeNull();           // a record is not a text payload
        expect(decodeRecord(encodeContent("hi", key), key)).toBeNull(); // and text is not a record
        expect(decodeRecord(encodeRecord(record, null))).toEqual(record);
    });
});

describe("sealed sessions accept nothing but authenticated envelopes (#579)", () => {
    it("plaintext JSON offered to a keyed session is refused, not parsed", () => {
        const key = nacl.randomBytes(32);
        const plain = JSON.stringify({ v: 1, t: "plain", text: "injected by the relay" });
        expect(decodeContent(plain, key)).toBeNull();
        expect(decodePrompt(plain, key)).toBeNull();
        expect(decodeRecord(JSON.stringify({ v: 1, t: "record", record: { role: "agent" } }), key)).toBeNull();
        // the same bytes are fine on a session that has no key (legacy pairing)
        expect(decodeContent(plain, null)).toBe("injected by the relay");
        expect(decodePrompt(plain)).toEqual({ text: "injected by the relay", attachments: [] });
        // and a properly sealed prompt still opens
        expect(decodePrompt(encodeContent("real", key), key)).toEqual({ text: "real", attachments: [] });
    });

    it("the turn's failure reason names the class of refusal", () => {
        const key = nacl.randomBytes(32);
        const plain = JSON.stringify({ v: 1, t: "plain", text: "x" });
        expect(promptRejectReason(plain, key)).toBe("plaintext_on_sealed_session");
        expect(promptRejectReason("v2e1:AAAA", key)).toBe("undecodable_prompt");   // sealed, wrong key / garbage
        expect(promptRejectReason("v2e1:AAAA", null)).toBe("undecodable_prompt");  // sealed, no key here
        expect(promptRejectReason("not json", null)).toBe("undecodable_prompt");
    });
});
